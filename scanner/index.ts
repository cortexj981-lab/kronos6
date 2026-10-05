// Kronos 6 v1 main loop — LIVE trading on a funded Kalshi account.
// The strategy pipeline (signal → discovery → quote → gates) is byte-for-byte
// the Kronos 5 logic. Only what happens AFTER signal generation changed:
// simulated bets became real V2 limit orders with fill/cancel handling.
//
// SAFETY: live orders are submitted ONLY when ALL of these hold —
//   1. startup validation passed (re-checked after failures),
//   2. config k6_halt != '1' (audit/operator kill switch),
//   3. config k6_live_trading_armed == 'ARMED' (set only by the human via
//      scripts/arm-live-trading.mjs). Until then signals record DRY_RUN.
// Flags: --once (single tick).
import {
  POLL_MS, CANDLE_MS, MAX_TARGET_AGE_MS, MIN_TARGET_REMAINING_MS,
  P_DOWN_CONSERVATIVE, MAX_NO_PRICE, MIN_FEE_ADJUSTED_EV, SERIES_TICKER,
  KALSHI_ENV, KALSHI_REST_URL, CANDLE_HISTORY, STRATEGY, SYMBOL, INTERVAL, STRATEGY_DIRECTION,
} from './config.js';
import { fetchCandles } from './candles.js';
import { computeFeatures, passesRules, ruleReason, strategyDirectionToKalshiOutcome } from './strategy.js';
import { discoverTargetMarket, readLiveNoQuote, describeMarket } from './kalshi-markets.js';
import { feeAdjustedEv } from './ev.js';
import { sizeOrder } from './sizing.js';
import { executeNoBuy, recoverOrphanOrders } from './execution.js';
import {
  getDb, ensureDefaults, insertDecision, hasTradeForWindow, hasLiveOrderForWindow,
  insertTrade, getStakeDollars, isArmed, isHalted, setHalt, getConfig, setConfig,
  recordEquity, recordHeartbeat, getStopLossDollars, getTrailStopDollars,
} from './db.js';
import { getBalance } from './kalshi-client.js';
import { resolveTrades } from './resolver.js';
import { auditLedger, reconstructSessionStart } from './reconciler.js';
import { validateStartup } from './validate.js';
import { k6log } from './log.js';
import type { Features, NoQuote, KalshiMarket } from './types.js';

const ONCE = process.argv.includes('--once');
const AUDIT_EVERY_MS = 15 * 60 * 1000;
const HEARTBEAT_EVERY_MS = 5 * 60 * 1000;
const REVALIDATE_EVERY_MS = 60 * 1000;
let lastAudit = 0;
let lastHeartbeat = 0;
let lastValidateAttempt = 0;
let validationOk = false;

interface BlockCtx {
  targetWindowStart: number | null;
  targetWindowEnd: number | null;
  features?: Features | null;
  market?: KalshiMarket | null;
  quote?: NoQuote | null;
  selectedExecPrice?: number | null;
  estimatedFee?: number | null;
  ev?: number | null;
  indexPrice?: number | null;   // signal-candle close (instrumentation only)
}

function decisionRow(decision: 'BLOCK' | 'DRY_RUN' | 'TRADE', reason: string, ctx: BlockCtx): void {
  insertDecision({
    ts: Date.now(),
    targetWindowStart: ctx.targetWindowStart,
    targetWindowEnd: ctx.targetWindowEnd,
    decision,
    reason,
    features: ctx.features ?? null,
    pDown: P_DOWN_CONSERVATIVE,
    seriesTicker: SERIES_TICKER,
    eventTicker: ctx.market?.event_ticker ?? null,
    marketTicker: ctx.market?.ticker ?? null,
    quote: ctx.quote ?? null,
    selectedExecPrice: ctx.selectedExecPrice ?? null,
    estimatedFee: ctx.estimatedFee ?? null,
    feeAdjustedEv: ctx.ev ?? null,
    // Settlement-divergence instrumentation. Recorded on EVERY decision row —
    // including BLOCKs while halted — so a stop-loss trip never stops the study.
    strikePrice: ctx.market?.floor_strike ?? null,
    strikeType: ctx.market?.strike_type ?? null,
    indexPriceAtEntry: ctx.indexPrice ?? null,
    indexPriceSource: ctx.indexPrice != null ? 'coinbase_15m_signal_close' : null,
  });
}

function block(reason: string, ctx: BlockCtx): void {
  decisionRow('BLOCK', reason, ctx);
  k6log(`[K6 BLOCK] ${reason}`);
}

/**
 * Trailing stop ratchet. When a trail distance is configured, the floor follows
 * the balance up at that fixed distance and never moves down. Runs on the same
 * fresh-balance observations as enforcement (enforceStopLoss callers), so the
 * floor can only ratchet on values just read from Kalshi — a corrupt or stale
 * ledger number can never raise it.
 */
function ratchetTrailingStop(balanceDollars: number): void {
  const trail = getTrailStopDollars();
  if (trail == null) return;
  const candidate = balanceDollars - trail;
  if (candidate <= 0) return;
  const floor = getStopLossDollars();
  if (floor != null && candidate <= floor) return;
  setConfig('k6_stop_loss_dollars', candidate.toFixed(2));
  k6log(`[K6 STOP-LOSS] trailing floor raised: $${floor?.toFixed(2) ?? '(none)'} -> $${candidate.toFixed(2)} (balance $${balanceDollars.toFixed(2)} - trail $${trail.toFixed(2)})`);
}

/**
 * Balance-floor stop loss. Given a FRESH, authoritative Kalshi balance, trip
 * the existing k6_halt kill switch when balance has fallen to or below the
 * configured floor. Returns true when at/below the floor (caller should not
 * trade). Never called with a stale or last-known balance — only with a value
 * just read from Kalshi (startup validation, post-settlement, or pre-trade).
 *
 * Tripping k6_halt means new trading stays stopped until an operator explicitly
 * clears it (scripts/clear-halt.mjs) — it does NOT auto-resume. The reason
 * string is distinct so the dashboard shows a stop-loss halt as such.
 */
function enforceStopLoss(balanceDollars: number | null, source: string): boolean {
  if (balanceDollars == null) return false;
  ratchetTrailingStop(balanceDollars);
  const floor = getStopLossDollars();
  if (floor == null) return false;
  if (balanceDollars > floor) return false;

  if (!isHalted()) {
    const reason = `STOP-LOSS: balance $${balanceDollars.toFixed(2)} <= floor $${floor.toFixed(2)} (${source}). New trading halted until an operator approves restart (scripts/clear-halt.mjs).`;
    setHalt(true, reason);
    setConfig('k6_stop_loss_tripped_ts', String(Date.now()));
    k6log(`[K6 STOP-LOSS] ${reason}`);
  }
  return true;
}

async function heartbeatMaybe(): Promise<void> {
  if (Date.now() - lastHeartbeat < HEARTBEAT_EVERY_MS) return;
  lastHeartbeat = Date.now();
  const status = !validationOk ? 'validation_failed' : (isHalted() ? 'halted' : 'ok');
  const bal = getConfig('k6_last_balance');
  recordHeartbeat(status, isArmed(), bal != null ? Number(bal) : null, `poll ok; armed=${isArmed()}; halted=${isHalted()}`);
}

async function tick(): Promise<void> {
  // Settlement + bookkeeping always run, even when trading is disabled.
  await resolveTrades();

  // Stop-loss (balance floor): resolveTrades() refreshes k6_last_balance from
  // Kalshi immediately after any settlement, so this trips the halt the moment
  // a losing settlement crosses the floor — without waiting for the next
  // signal. The pre-trade gate below is the hard guarantee; this is for
  // promptness and dashboard visibility.
  const lastBalStr = getConfig('k6_last_balance');
  if (lastBalStr != null) enforceStopLoss(Number(lastBalStr), 'post_settlement');

  await heartbeatMaybe();

  if (Date.now() - lastAudit > AUDIT_EVERY_MS) {
    lastAudit = Date.now();
    try { await auditLedger(); } catch (e) { k6log(`[K6 ERROR] audit failed: ${(e as Error).message}`); }
  }

  // Fail-closed validation gate: no trading until every startup check passes.
  if (!validationOk) {
    if (Date.now() - lastValidateAttempt >= REVALIDATE_EVERY_MS) {
      lastValidateAttempt = Date.now();
      const v = await validateStartup();
      validationOk = v.ok;
      if (v.balanceDollars != null) recordEquity(v.balanceDollars, 'startup');
      if (validationOk && getConfig('k6_session_start_balance') == null && v.balanceDollars != null) {
        setConfig('k6_session_start_balance', String(reconstructSessionStart(v.balanceDollars)));
      }
    }
    if (!validationOk) return; // do not trade
  }

  const now = Date.now();
  const targetWindowStart = Math.floor(now / CANDLE_MS) * CANDLE_MS;
  const targetWindowEnd = targetWindowStart + CANDLE_MS;
  const targetAge = now - targetWindowStart;
  const targetRemaining = targetWindowEnd - now;
  const ctx: BlockCtx = { targetWindowStart, targetWindowEnd };

  // Only log the outside-window state transition once per window.
  if (targetAge > MAX_TARGET_AGE_MS || targetRemaining < MIN_TARGET_REMAINING_MS) {
    const key = `outside-window:${targetWindowStart}`;
    if (getConfig('k6_last_outside_logged') !== key) {
      setConfig('k6_last_outside_logged', key);
      block(`outside early target window: age=${Math.round(targetAge / 1000)}s remaining=${Math.round(targetRemaining / 1000)}s`, ctx);
    }
    return;
  }

  // One trade per market window — trades UNIQUE index plus the order-intent
  // guard (covers the crash-after-submit case). Never submit duplicates.
  if (hasTradeForWindow(targetWindowStart) || hasLiveOrderForWindow(targetWindowStart)) {
    return;
  }

  // Signal candle: the most recently fully closed 15m candle must be the one
  // immediately preceding the target window.
  const candles = await fetchCandles(SYMBOL, CANDLE_HISTORY);
  const last = candles[candles.length - 1];
  if (!last || last.ts !== targetWindowStart - CANDLE_MS) {
    block(`signal candle not ready (last=${last ? new Date(last.ts).toISOString() : 'none'})`, ctx);
    return;
  }

  ctx.indexPrice = last.close;
  const features = computeFeatures(candles);
  ctx.features = features;
  if (!features) { block('features not ready (insufficient history or zero range)', ctx); return; }

  if (!passesRules(features)) { block(`rules failed: ${ruleReason(features)}`, ctx); return; }

  k6log(`[K6 SIGNAL] ETH 15m DOWN exhaustion detected target=${new Date(targetWindowStart).toISOString()} ${ruleReason(features)}`);

  // Live market discovery
  const disc = await discoverTargetMarket(targetWindowStart);
  if (!disc.market) {
    block(`market not found for window (rejected: ${disc.rejected.slice(0, 3).join('; ') || 'none listed'})`, ctx);
    return;
  }
  const market = disc.market;
  ctx.market = market;
  k6log(`[K6 MARKET] selected ${describeMarket(market)}`);
  setConfig('k6_last_market_ticker', market.ticker);

  strategyDirectionToKalshiOutcome(STRATEGY_DIRECTION); // asserts DOWN -> 'no'

  // Live quote — the NO price that becomes our limit price.
  const quote = await readLiveNoQuote(market);
  ctx.quote = quote;
  if (!quote) {
    block('no usable price data (book empty and no market quote)', ctx);
    return;
  }
  if (quote.warning) k6log(`[K6 MARKET] liquidity warning: ${quote.warning}`);
  const execPrice = quote.execPrice;
  ctx.selectedExecPrice = execPrice;

  // Frozen strategy gates (identical to Kronos 5)
  if (execPrice > MAX_NO_PRICE) {
    block(`NO price too expensive: ${execPrice.toFixed(4)} > ${MAX_NO_PRICE}`, ctx);
    return;
  }
  const ev = feeAdjustedEv(P_DOWN_CONSERVATIVE, execPrice);
  ctx.ev = ev;
  if (ev <= MIN_FEE_ADJUSTED_EV) {
    block(`fee-adjusted EV below gate: ev=${ev.toFixed(4)} <= ${MIN_FEE_ADJUSTED_EV}`, ctx);
    return;
  }

  // Operator/audit kill switch — checked at the last gate before money moves.
  if (isHalted()) {
    block(`halted (k6_halt=1): ${getConfig('k6_halt_reason') ?? 'no reason recorded'}`, ctx);
    return;
  }

  // Fixed dollar stake (from config) against the real available balance.
  const stake = getStakeDollars();
  let balanceBefore: number | null = null;
  try {
    balanceBefore = (await getBalance()).balanceDollars;
    recordEquity(balanceBefore, 'pre_trade');
  } catch (e) {
    block(`balance read failed before order — refusing to trade blind: ${(e as Error).message}`, ctx);
    return;
  }

  // Stop-loss hard guarantee: this is a fresh Kalshi balance read moments before
  // an order would be placed. No order is ever submitted at or below the floor.
  if (enforceStopLoss(balanceBefore, 'pre_trade')) {
    block(`stop-loss: balance $${balanceBefore.toFixed(2)} at/below floor — halted, no order placed`, ctx);
    return;
  }
  const sz = sizeOrder(stake, balanceBefore, execPrice);
  ctx.estimatedFee = sz.estimatedFee;
  if (sz.contracts <= 0) {
    block(`sizing rejected trade: stake=$${stake.toFixed(2)} balance=$${balanceBefore.toFixed(2)} price=${execPrice.toFixed(4)} -> 0 contracts`, ctx);
    return;
  }

  // Liquidity metadata (recorded like Kronos 5; the limit price is the
  // protection — an unfilled remainder is canceled after the timeout).
  let liquidityWarning = quote.warning;
  if (quote.size != null && quote.size < sz.contracts) {
    const msg = `book top level has ${quote.size} contracts; order wants ${sz.contracts}`;
    liquidityWarning = liquidityWarning ? `${liquidityWarning}; ${msg}` : msg;
    k6log(`[K6 MARKET] liquidity warning: ${msg}`);
  }

  // THE ARMING GATE — the human safeguard. Everything above ran for real;
  // nothing below runs until the operator arms live trading.
  if (!isArmed()) {
    decisionRow('DRY_RUN', `signal valid; would place LIVE order: ${sz.contracts} NO @ ${execPrice.toFixed(4)} (stake $${stake.toFixed(2)}, est fee $${sz.estimatedFee.toFixed(4)}, ev ${ev.toFixed(4)}) — live trading NOT ARMED`, ctx);
    k6log(`[K6 DRY_RUN] live trading not armed — would have placed ${sz.contracts} NO @ ${execPrice.toFixed(4)} on ${market.ticker}. Arm with scripts/arm-live-trading.mjs.`);
    return;
  }

  // LIVE ORDER.
  const result = await executeNoBuy({
    marketTicker: market.ticker,
    targetWindowStart,
    priceDollars: execPrice,
    quantity: sz.contracts,
    estimatedFee: sz.estimatedFee,
    exchangeIndex: market.exchange_index,
  });

  if (result.status === 'error' || result.status === 'rejected') {
    block(`live order failed: ${result.errorMessage ?? result.status}`, ctx);
    return;
  }
  if (result.status === 'unfilled') {
    block(`live order unfilled within timeout — canceled (limit ${execPrice.toFixed(4)}, ${sz.contracts} contracts)`, ctx);
    return;
  }

  // A real position exists (full or partial fill). Record the trade with the
  // ACTUAL economics — never the intended ones.
  const avgFill = result.averageFillPrice ?? execPrice;
  const positionCost = Number((avgFill * result.filledQuantity).toFixed(6));
  insertTrade({
    targetWindowStart, targetWindowEnd,
    eventTicker: market.event_ticker,
    marketTicker: market.ticker,
    orderRowId: result.orderRowId,
    pDown: P_DOWN_CONSERVATIVE,
    features,
    limitPrice: execPrice,
    priceSource: quote.priceSource,
    quote,
    liquidityWarning,
    intendedStake: stake,
    contracts: result.filledQuantity,
    requestedContracts: sz.contracts,
    avgFillPrice: avgFill,
    positionCost,
    feeAmount: result.actualFee,
    feeAdjustedEv: ev,
    partialFill: result.status === 'partial',
    balanceBefore,
    // instrumentation only (settlement-divergence analysis): the Kalshi strike
    // this market settles against, and our Coinbase view of price at entry.
    strikePrice: market.floor_strike ?? null,
    strikeType: market.strike_type ?? null,
    indexPriceAtEntry: last.close,
    indexPriceSource: 'coinbase_15m_signal_close',
  });
  decisionRow('TRADE', `LIVE ${result.status.toUpperCase()}: ${result.filledQuantity}/${sz.contracts} NO @ ${avgFill.toFixed(4)} cost=$${positionCost.toFixed(2)} fee=$${result.actualFee.toFixed(4)} ev=${ev.toFixed(4)}${liquidityWarning ? ` [liquidity: ${liquidityWarning}]` : ''}`, ctx);
  k6log(`[K6 TRADE] LIVE ${result.status} ${result.filledQuantity} NO @ ${avgFill.toFixed(4)} market=${market.ticker} window=${new Date(targetWindowStart).toISOString()} cost=$${positionCost.toFixed(2)} fee=$${result.actualFee.toFixed(4)} strike=${market.floor_strike ?? 'n/a'} idx@entry=${last.close}`);
}

async function guardedTick(): Promise<void> {
  try {
    await tick();
  } catch (e) {
    k6log(`[K6 ERROR] tick failed: ${(e as Error).stack ?? e}`);
  }
}

async function main(): Promise<void> {
  k6log(`[K6 ONLINE] Kronos 6 v1 — strategy=${STRATEGY} symbol=${SYMBOL} interval=${INTERVAL} MODE=LIVE env=${KALSHI_ENV} host=${new URL(KALSHI_REST_URL).host}`);
  k6log('[K6 ONLINE] *** THIS SYSTEM TRADES REAL MONEY WHEN ARMED ***');

  getDb();
  ensureDefaults();
  k6log(`[K6 ONLINE] live trading armed: ${isArmed() ? 'YES — orders WILL be placed on signals' : 'no — DRY_RUN mode (arm with scripts/arm-live-trading.mjs)'}`);
  if (isHalted()) k6log(`[K6 ONLINE] !! halted: ${getConfig('k6_halt_reason') ?? ''}`);

  // Startup validation (fail closed — scanner stays alive but will not trade
  // until every check passes; re-validates every minute).
  lastValidateAttempt = Date.now();
  const v = await validateStartup();
  validationOk = v.ok;
  if (v.balanceDollars != null) {
    recordEquity(v.balanceDollars, 'startup');
    if (getConfig('k6_session_start_balance') == null) {
      setConfig('k6_session_start_balance', String(reconstructSessionStart(v.balanceDollars)));
    }
    // If the account is already at/below the floor at boot, trip before the
    // first tick so a restart can never resume trading under the stop.
    enforceStopLoss(v.balanceDollars, 'startup');
  }
  const slFloor = getStopLossDollars();
  if (slFloor != null) k6log(`[K6 ONLINE] stop loss active: balance floor $${slFloor.toFixed(2)} (trips k6_halt; clear with scripts/clear-halt.mjs after approval)`);

  // Crash recovery: reconcile any order left non-terminal by a previous run.
  try {
    const attention = await recoverOrphanOrders(getDb());
    if (attention > 0) k6log(`[K6 RECOVER] ${attention} order(s) need operator attention — see log above`);
  } catch (e) {
    k6log(`[K6 ERROR] orphan-order recovery failed: ${(e as Error).message}`);
  }

  try { await auditLedger(); } catch (e) { k6log(`[K6 ERROR] initial audit failed: ${(e as Error).message}`); }
  lastAudit = Date.now();
  recordHeartbeat(validationOk ? 'ok' : 'validation_failed', isArmed(), v.balanceDollars, 'startup');
  lastHeartbeat = Date.now();

  if (ONCE) {
    await guardedTick();
    return;
  }
  for (;;) {
    await guardedTick();
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

main().catch((e) => {
  k6log(`[K6 FATAL] ${(e as Error).stack ?? e}`);
  process.exit(1);
});
