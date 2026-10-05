// One-shot operator-requested live DOWN order for the next KXETH15M candle.
// Places at most one 1-contract NO order, records any fill in the K6 ledger,
// then exits. This script is intended to be deleted after the run.
import {
  CANDLE_MS,
  P_DOWN_CONSERVATIVE,
  SERIES_TICKER,
  STRATEGY_DIRECTION,
} from '../scanner/config.js';
import { fetchCandles } from '../scanner/candles.js';
import { computeFeatures, strategyDirectionToKalshiOutcome } from '../scanner/strategy.js';
import { discoverTargetMarket, readLiveNoQuote, describeMarket } from '../scanner/kalshi-markets.js';
import { executeNoBuy } from '../scanner/execution.js';
import { getBalance } from '../scanner/kalshi-client.js';
import { takerFee } from '../scanner/fees.js';
import { feeAdjustedEv } from '../scanner/ev.js';
import {
  getDb,
  ensureDefaults,
  isArmed,
  isHalted,
  getConfig,
  hasLiveOrderForWindow,
  hasTradeForWindow,
  insertTrade,
  insertDecision,
  recordEquity,
} from '../scanner/db.js';
import { k6log } from '../scanner/log.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const fmtEt = (ms) => new Date(ms).toLocaleString('en-US', {
  timeZone: 'America/New_York',
  hour12: false,
});

function decision(decisionType, reason, ctx) {
  insertDecision({
    ts: Date.now(),
    targetWindowStart: ctx.targetWindowStart,
    targetWindowEnd: ctx.targetWindowEnd,
    decision: decisionType,
    reason,
    features: ctx.features ?? null,
    pDown: P_DOWN_CONSERVATIVE,
    seriesTicker: SERIES_TICKER,
    eventTicker: ctx.market?.event_ticker ?? null,
    marketTicker: ctx.market?.ticker ?? null,
    quote: ctx.quote ?? null,
    selectedExecPrice: ctx.execPrice ?? null,
    estimatedFee: ctx.estimatedFee ?? null,
    feeAdjustedEv: ctx.ev ?? null,
    strikePrice: ctx.market?.floor_strike ?? null,
    strikeType: ctx.market?.strike_type ?? null,
    indexPriceAtEntry: ctx.indexPrice ?? null,
    indexPriceSource: ctx.indexPrice != null ? 'coinbase_15m_signal_close' : null,
  });
}

async function main() {
  getDb();
  ensureDefaults();

  if (!isArmed()) throw new Error('[K6 MANUAL] live trading is not ARMED; refusing manual live order.');
  if (isHalted()) throw new Error(`[K6 MANUAL] K6 is halted: ${getConfig('k6_halt_reason') ?? 'no reason recorded'}`);
  strategyDirectionToKalshiOutcome(STRATEGY_DIRECTION);

  const now = Date.now();
  const targetWindowStart = Math.floor(now / CANDLE_MS) * CANDLE_MS + CANDLE_MS;
  const targetWindowEnd = targetWindowStart + CANDLE_MS;
  const openAt = targetWindowStart + 1_000;
  k6log(`[K6 MANUAL] queued one 1-contract DOWN/NO live order for next candle ${new Date(targetWindowStart).toISOString()} (${fmtEt(targetWindowStart)} ET)`);

  const waitMs = openAt - Date.now();
  if (waitMs > 0) await sleep(waitMs);

  const ctx = { targetWindowStart, targetWindowEnd };
  if (hasTradeForWindow(targetWindowStart) || hasLiveOrderForWindow(targetWindowStart)) {
    k6log('[K6 MANUAL] existing live order/trade already exists for target window; no manual duplicate placed.');
    return;
  }

  const candles = await fetchCandles('ETHUSD', 240);
  const last = candles[candles.length - 1];
  if (last?.ts === targetWindowStart - CANDLE_MS) {
    ctx.indexPrice = last.close;
    ctx.features = computeFeatures(candles) ?? { closePos: null, ema20Slope3: null, ema100Dist: null };
  } else {
    ctx.features = { closePos: null, ema20Slope3: null, ema100Dist: null };
  }

  let market = null;
  let quote = null;
  const deadline = targetWindowStart + 85_000;
  while (Date.now() < deadline && !quote) {
    if (hasTradeForWindow(targetWindowStart) || hasLiveOrderForWindow(targetWindowStart)) {
      k6log('[K6 MANUAL] existing live order/trade appeared for target window; no manual duplicate placed.');
      return;
    }
    const disc = await discoverTargetMarket(targetWindowStart);
    market = disc.market;
    if (!market) {
      k6log(`[K6 MANUAL] target market not found yet: ${disc.rejected.slice(0, 2).join('; ') || 'none listed'}`);
      await sleep(2_000);
      continue;
    }
    ctx.market = market;
    k6log(`[K6 MANUAL] selected ${describeMarket(market)}`);
    quote = await readLiveNoQuote(market);
    if (!quote) {
      k6log('[K6 MANUAL] no usable NO quote yet; retrying.');
      await sleep(2_000);
    }
  }

  if (!market || !quote) {
    decision('BLOCK', 'MANUAL ONE-SHOT: no usable NO quote before entry deadline; no order placed', ctx);
    k6log('[K6 MANUAL] no usable quote before deadline; no order placed.');
    return;
  }

  ctx.quote = quote;
  ctx.execPrice = quote.execPrice;
  ctx.estimatedFee = takerFee(1, quote.execPrice);
  ctx.ev = feeAdjustedEv(P_DOWN_CONSERVATIVE, quote.execPrice);

  const balanceBefore = (await getBalance()).balanceDollars;
  recordEquity(balanceBefore, 'pre_trade');
  const result = await executeNoBuy({
    marketTicker: market.ticker,
    targetWindowStart,
    priceDollars: quote.execPrice,
    quantity: 1,
    estimatedFee: ctx.estimatedFee,
    purpose: 'strategy',
    exchangeIndex: market.exchange_index,
  });

  if (result.status === 'error' || result.status === 'rejected') {
    decision('BLOCK', `MANUAL ONE-SHOT: live order failed: ${result.errorMessage ?? result.status}`, ctx);
    return;
  }
  if (result.status === 'unfilled') {
    decision('BLOCK', `MANUAL ONE-SHOT: one-contract DOWN/NO order unfilled and canceled at limit ${quote.execPrice.toFixed(4)}`, ctx);
    return;
  }

  const avgFill = result.averageFillPrice ?? quote.execPrice;
  const positionCost = Number((avgFill * result.filledQuantity).toFixed(6));
  insertTrade({
    targetWindowStart,
    targetWindowEnd,
    eventTicker: market.event_ticker,
    marketTicker: market.ticker,
    orderRowId: result.orderRowId,
    pDown: P_DOWN_CONSERVATIVE,
    features: ctx.features,
    limitPrice: quote.execPrice,
    priceSource: quote.priceSource,
    quote,
    liquidityWarning: quote.warning,
    intendedStake: positionCost + result.actualFee,
    contracts: result.filledQuantity,
    requestedContracts: 1,
    avgFillPrice: avgFill,
    positionCost,
    feeAmount: result.actualFee,
    feeAdjustedEv: ctx.ev,
    partialFill: result.status === 'partial',
    balanceBefore,
    strikePrice: market.floor_strike ?? null,
    strikeType: market.strike_type ?? null,
    indexPriceAtEntry: ctx.indexPrice ?? null,
    indexPriceSource: ctx.indexPrice != null ? 'coinbase_15m_signal_close' : null,
  });
  decision('TRADE', `MANUAL ONE-SHOT LIVE ${result.status.toUpperCase()}: ${result.filledQuantity}/1 DOWN/NO @ ${avgFill.toFixed(4)} cost=$${positionCost.toFixed(2)} fee=$${result.actualFee.toFixed(4)}`, ctx);
  k6log(`[K6 MANUAL] LIVE ${result.status} ${result.filledQuantity}/1 DOWN/NO @ ${avgFill.toFixed(4)} market=${market.ticker} cost=$${positionCost.toFixed(2)} fee=$${result.actualFee.toFixed(4)}`);
}

main().catch((e) => {
  k6log(`[K6 MANUAL] FAILED: ${e.stack ?? e}`);
  process.exit(1);
});
