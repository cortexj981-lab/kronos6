import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import {
  CANDLE_HISTORY,
  CANDLE_MS,
  INTERVAL,
  KALSHI_REST_URL,
  MAX_NO_PRICE,
  MAX_TARGET_AGE_MS,
  MIN_FEE_ADJUSTED_EV,
  MIN_TARGET_REMAINING_MS,
  P_DOWN_CONSERVATIVE,
  RULES,
  SERIES_TICKER,
  STRATEGY,
  SYMBOL,
} from '../scanner/config.ts';
import { DB_PATH } from '../scanner/db.ts';
import { feeAdjustedEv } from '../scanner/ev.ts';
import { discoverTargetMarket, readLiveNoQuote } from '../scanner/kalshi-markets.ts';
import {
  getBalance,
  getExchangeStatus,
  getFills,
  getLastClockSkewMs,
  getMarkets,
  getOrders,
  getPositions,
  getSeries,
  getSettlements,
} from '../scanner/kalshi-client.ts';
import { sizeOrder } from '../scanner/sizing.ts';
import { computeFeatures, passesRules, ruleReason } from '../scanner/strategy.ts';
import type { Candle, Features } from '../scanner/types.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'out', `k6-no-trades-${new Date().toISOString().replace(/[:.]/g, '-')}`);

type Row = Record<string, unknown>;

const nf = (n: number | null | undefined, d = 6): string => (
  n == null || !Number.isFinite(n) ? '' : Number(n).toFixed(d)
);
const iso = (ms: number | null | undefined): string => ms == null ? '' : new Date(ms).toISOString();
const et = (ms: number | null | undefined): string => {
  if (ms == null) return '';
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(new Date(ms));
};

function csvEscape(v: unknown): string {
  if (v == null) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function writeCsv(file: string, rows: Row[]): void {
  const headers = Array.from(rows.reduce((set, row) => {
    for (const k of Object.keys(row)) set.add(k);
    return set;
  }, new Set<string>()));
  const body = [headers.join(',')];
  for (const row of rows) body.push(headers.map((h) => csvEscape(row[h])).join(','));
  writeFileSync(file, `${body.join('\n')}\n`, 'utf8');
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'kronos6-investigation/1.0' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
  return await res.json() as T;
}

async function fetchCoinbaseCandles(startMs: number, endMs: number): Promise<Candle[]> {
  const product = SYMBOL === 'ETHUSD' ? 'ETH-USD' : SYMBOL;
  const granularityS = CANDLE_MS / 1000;
  const maxCandlesPerRequest = 280;
  const rows = new Map<number, Candle>();
  let cursor = Math.floor(startMs / CANDLE_MS) * CANDLE_MS;
  const finalEnd = Math.ceil(endMs / CANDLE_MS) * CANDLE_MS;
  while (cursor < finalEnd) {
    const chunkEnd = Math.min(finalEnd, cursor + maxCandlesPerRequest * CANDLE_MS);
    const url = `https://api.exchange.coinbase.com/products/${product}/candles?granularity=${granularityS}&start=${encodeURIComponent(new Date(cursor).toISOString())}&end=${encodeURIComponent(new Date(chunkEnd).toISOString())}`;
    const raw = await fetchJson<[number, number, number, number, number, number][]>(url);
    for (const r of raw) {
      const c = { ts: r[0] * 1000, low: r[1], high: r[2], open: r[3], close: r[4], volume: r[5] };
      rows.set(c.ts, c);
    }
    cursor = chunkEnd;
    await new Promise((r) => setTimeout(r, 150));
  }
  const currentStart = Math.floor(Date.now() / CANDLE_MS) * CANDLE_MS;
  return Array.from(rows.values())
    .filter((c) => c.ts >= startMs && c.ts < finalEnd && c.ts < currentStart)
    .sort((a, b) => a.ts - b.ts);
}

function auditCandles(candles: Candle[]): Row {
  const seen = new Set<number>();
  let duplicates = 0;
  let outOfOrder = 0;
  let nanValues = 0;
  let zeroRange = 0;
  let missing = 0;
  let previous: number | null = null;
  const missingRanges: string[] = [];

  for (const c of candles) {
    if (seen.has(c.ts)) duplicates += 1;
    seen.add(c.ts);
    if (previous != null) {
      if (c.ts <= previous) outOfOrder += 1;
      const gap = c.ts - previous;
      if (gap > CANDLE_MS) {
        const n = gap / CANDLE_MS - 1;
        missing += n;
        if (missingRanges.length < 10) {
          missingRanges.push(`${iso(previous + CANDLE_MS)}..${iso(c.ts - CANDLE_MS)} (${n})`);
        }
      }
    }
    if (![c.open, c.high, c.low, c.close, c.volume].every(Number.isFinite)) nanValues += 1;
    if (c.high <= c.low) zeroRange += 1;
    previous = c.ts;
  }
  return {
    candles_downloaded: candles.length,
    first_candle_utc: iso(candles[0]?.ts),
    last_candle_utc: iso(candles[candles.length - 1]?.ts),
    duplicate_candles: duplicates,
    out_of_order_candles: outOfOrder,
    missing_candles: missing,
    missing_ranges_sample: missingRanges.join('; '),
    candles_with_nan: nanValues,
    candles_with_zero_or_negative_range: zeroRange,
  };
}

function diagnosticAtrPct(candles: Candle[], period = 14): number | null {
  if (candles.length < period + 1) return null;
  const tail = candles.slice(-period);
  const trs = tail.map((c, i) => {
    const prev = candles[candles.length - period + i - 1];
    const highLow = c.high - c.low;
    const highClose = Math.abs(c.high - prev.close);
    const lowClose = Math.abs(c.low - prev.close);
    return Math.max(highLow, highClose, lowClose);
  });
  const atr = trs.reduce((a, b) => a + b, 0) / trs.length;
  const close = candles[candles.length - 1]?.close;
  return close ? (atr / close) * 100 : null;
}

function classifyRuleFailure(f: Features | null): string {
  if (!f) return 'features_not_ready';
  if (f.closePos < RULES.closePosMin) return 'closePos';
  if (f.ema20Slope3 < RULES.ema20Slope3Min) return 'ema20Slope3';
  if (f.ema100Dist < RULES.ema100DistMin) return 'ema100Dist';
  return 'rules_passed';
}

function classifyLiveReject(reason: string | null | undefined): string {
  const r = String(reason ?? '').toLowerCase();
  if (r.includes('market not found')) return 'kalshi_market_availability';
  if (r.includes('no usable price')) return 'kalshi_price_data';
  if (r.includes('no price too expensive')) return 'price_cap';
  if (r.includes('fee-adjusted ev below')) return 'ev_gate';
  if (r.includes('halted')) return 'halt';
  if (r.includes('balance read failed')) return 'balance_read';
  if (r.includes('sizing rejected')) return 'sizing';
  if (r.includes('live order failed')) return 'order_failed';
  if (r.includes('unfilled within timeout')) return 'order_unfilled';
  if (r.includes('not armed')) return 'arming_gate';
  if (r.includes('outside early target window')) return 'outside_entry_window';
  if (r.includes('signal candle not ready')) return 'signal_candle_not_ready';
  if (r.includes('rules failed')) return 'rules_failed';
  return 'other';
}

function sha256(file: string): string {
  return existsSync(file) ? createHash('sha256').update(readFileSync(file)).digest('hex') : 'missing';
}

function runCmd(command: string, args: string[], cwd: string): Row {
  try {
    const out = execFileSync(command, args, { cwd, encoding: 'utf8', timeout: 10_000, windowsHide: true });
    return { ok: true, output: out.trim().slice(0, 5000) };
  } catch (e) {
    return { ok: false, output: String((e as Error).message).slice(0, 2000) };
  }
}

async function kalshiValidation(currentTargetStart: number, lastTradeCreatedAt: number): Promise<Row> {
  const result: Row = {
    api_host: new URL(KALSHI_REST_URL).host,
    current_target_window_start_utc: iso(currentTargetStart),
    current_target_window_end_utc: iso(currentTargetStart + CANDLE_MS),
  };
  try {
    const ex = await getExchangeStatus();
    result.exchange_active = ex.exchange_active;
    result.trading_active = ex.trading_active;
  } catch (e) { result.exchange_status_error = (e as Error).message; }

  try {
    const b = await getBalance();
    result.balance_dollars = b.balanceDollars;
  } catch (e) { result.balance_error = (e as Error).message; }

  try {
    const s = await getSeries(SERIES_TICKER);
    result.series = JSON.stringify(s.series);
  } catch (e) { result.series_error = (e as Error).message; }

  try {
    const currentMarkets = await getMarkets({ series_ticker: SERIES_TICKER, limit: 10 });
    result.current_markets_count = currentMarkets.markets?.length ?? 0;
    result.current_markets_sample = JSON.stringify((currentMarkets.markets ?? []).slice(0, 3).map((m) => ({
      ticker: m.ticker,
      status: m.status,
      open_time: m.open_time,
      close_time: m.close_time,
      yes_bid: m.yes_bid_dollars,
      no_ask: m.no_ask_dollars,
    })));
  } catch (e) { result.markets_error = (e as Error).message; }

  try {
    const disc = await discoverTargetMarket(currentTargetStart);
    result.current_discovery = disc.market ? 'market_found' : 'market_not_found';
    result.current_discovery_rejected = disc.rejected.join('; ');
    if (disc.market) {
      result.current_market = JSON.stringify({
        ticker: disc.market.ticker,
        event_ticker: disc.market.event_ticker,
        status: disc.market.status,
        open_time: disc.market.open_time,
        close_time: disc.market.close_time,
        expected_expiration_time: disc.market.expected_expiration_time,
        yes_bid: disc.market.yes_bid_dollars,
        yes_ask: disc.market.yes_ask_dollars,
        no_bid: disc.market.no_bid_dollars,
        no_ask: disc.market.no_ask_dollars,
      });
      const quote = await readLiveNoQuote(disc.market);
      result.current_no_quote = quote ? JSON.stringify(quote) : 'null';
    }
  } catch (e) { result.current_market_error = (e as Error).message; }

  try {
    const orders = await getOrders({ limit: 20 });
    result.recent_kalshi_orders_count = orders.orders?.length ?? 0;
    result.recent_kalshi_orders_sample = JSON.stringify((orders.orders ?? []).slice(0, 5).map((o) => ({
      order_id: o.order_id,
      client_order_id: o.client_order_id,
      ticker: o.ticker,
      status: o.status,
      created_time: o.created_time,
      fill_count_fp: o.fill_count_fp,
    })));
  } catch (e) { result.orders_error = (e as Error).message; }

  try {
    const fills = await getFills({ limit: 20 });
    result.recent_kalshi_fills_count = fills.fills?.length ?? 0;
    result.recent_kalshi_fills_since_last_trade = (fills.fills ?? []).filter((f) => Date.parse(f.created_time ?? '') > lastTradeCreatedAt).length;
    result.recent_kalshi_fills_sample = JSON.stringify((fills.fills ?? []).slice(0, 5).map((f) => ({
      trade_id: f.trade_id ?? f.fill_id,
      order_id: f.order_id,
      ticker: f.ticker,
      created_time: f.created_time,
      count: f.count ?? f.count_fp,
    })));
  } catch (e) { result.fills_error = (e as Error).message; }

  try {
    const positions = await getPositions({ limit: 20 });
    result.positions_count = positions.market_positions?.length ?? 0;
    result.positions_sample = JSON.stringify((positions.market_positions ?? []).slice(0, 5));
  } catch (e) { result.positions_error = (e as Error).message; }

  try {
    const settlements = await getSettlements({ limit: 20 });
    result.settlements_count = settlements.settlements?.length ?? 0;
    result.settlements_sample = JSON.stringify((settlements.settlements ?? []).slice(0, 5));
  } catch (e) { result.settlements_error = (e as Error).message; }

  result.clock_skew_ms = getLastClockSkewMs();
  result.historical_kalshi_quote_download = 'not_available_in_k6_client_allowlist_or_existing_code; local DB decision rows are the retained quote snapshots';
  return result;
}

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });
  const db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA busy_timeout = 5000');

  const lastTrade = db.prepare(`SELECT * FROM trades WHERE strategy = ? ORDER BY created_at DESC LIMIT 1`).get(STRATEGY) as Row | undefined;
  if (!lastTrade) throw new Error(`No ${STRATEGY} trades found in ${DB_PATH}`);
  const lastTarget = Number(lastTrade.target_window_start);
  const lastTradeCreatedAt = Number(lastTrade.created_at);
  const replayStartTarget = lastTarget + CANDLE_MS;
  const currentTargetStart = Math.floor(Date.now() / CANDLE_MS) * CANDLE_MS;
  const fetchStart = lastTarget - CANDLE_HISTORY * CANDLE_MS;
  const fetchEnd = currentTargetStart;

  const decisions = db.prepare(`SELECT * FROM decisions WHERE target_window_start >= ? ORDER BY target_window_start, ts`).all(replayStartTarget) as Row[];
  const decisionsByTarget = new Map<number, Row[]>();
  for (const d of decisions) {
    const t = Number(d.target_window_start);
    if (!decisionsByTarget.has(t)) decisionsByTarget.set(t, []);
    decisionsByTarget.get(t)!.push(d);
  }

  const trades = db.prepare(`SELECT * FROM trades WHERE strategy = ? AND target_window_start >= ? ORDER BY target_window_start`).all(STRATEGY, replayStartTarget) as Row[];
  const tradesByTarget = new Map(trades.map((t) => [Number(t.target_window_start), t]));
  const orders = db.prepare(`SELECT * FROM orders WHERE target_window_start >= ? ORDER BY target_window_start, submitted_at`).all(replayStartTarget) as Row[];
  const ordersByTarget = new Map<number, Row[]>();
  for (const o of orders) {
    const t = Number(o.target_window_start);
    if (!ordersByTarget.has(t)) ordersByTarget.set(t, []);
    ordersByTarget.get(t)!.push(o);
  }

  const configRows = db.prepare(`SELECT key, value FROM config ORDER BY key`).all() as Array<{ key: string; value: string }>;
  const cfg = new Map(configRows.map((r) => [r.key, r.value]));
  const stakeDollars = Number(cfg.get('k6_stake_dollars') ?? 5);
  const lastHeartbeat = db.prepare(`SELECT * FROM heartbeat ORDER BY ts DESC LIMIT 1`).get() as Row | undefined;
  const openTrades = db.prepare(`SELECT * FROM trades WHERE strategy = ? AND correct IS NULL ORDER BY created_at`).all(STRATEGY) as Row[];
  const nonTerminalOrders = db.prepare(`SELECT * FROM orders WHERE purpose = 'strategy' AND status IN ('pending_submit','resting') ORDER BY submitted_at`).all() as Row[];
  const recentEquity = db.prepare(`SELECT * FROM equity ORDER BY ts DESC LIMIT 10`).all() as Row[];

  const candles = await fetchCoinbaseCandles(fetchStart, fetchEnd);
  const candlesByTs = new Map(candles.map((c) => [c.ts, c]));
  const candleAudit = auditCandles(candles);

  const replayRows: Row[] = [];
  const featureCompareRows: Row[] = [];
  const counts: Record<string, number> = {
    total_candles_processed: 0,
    features_not_ready: 0,
    potential_down_signals_before_kalshi_filters: 0,
    rejected_by_closePos_rule: 0,
    rejected_by_ema20Slope3_rule: 0,
    rejected_by_ema100Dist_rule: 0,
    rejected_by_kalshi_market_availability: 0,
    rejected_by_kalshi_price_data: 0,
    rejected_by_price_cap: 0,
    rejected_by_ev_gate: 0,
    rejected_by_halt: 0,
    rejected_by_balance_read: 0,
    rejected_by_sizing: 0,
    rejected_by_arming_gate: 0,
    rejected_by_order_failed: 0,
    rejected_by_order_unfilled: 0,
    executed_trades: 0,
    possible_missed_rule_pass_no_live_decision: 0,
  };
  const allGateFailures: Record<string, number> = {
    closePos: 0,
    ema20Slope3: 0,
    ema100Dist: 0,
  };

  for (let target = replayStartTarget; target <= currentTargetStart; target += CANDLE_MS) {
    counts.total_candles_processed += 1;
    const signalTs = target - CANDLE_MS;
    const c = candlesByTs.get(signalTs);
    const history = candles.filter((x) => x.ts <= signalTs);
    const productionHistory = history.slice(-CANDLE_HISTORY);
    const features = c ? computeFeatures(productionHistory) : null;
    const rulesPass = features ? passesRules(features) : false;
    const liveRows = decisionsByTarget.get(target) ?? [];
    const trade = tradesByTarget.get(target);
    const targetOrders = ordersByTarget.get(target) ?? [];
    const signalScore = features
      ? Number([
        features.closePos >= RULES.closePosMin,
        features.ema20Slope3 >= RULES.ema20Slope3Min,
        features.ema100Dist >= RULES.ema100DistMin,
      ].filter(Boolean).length)
      : 0;
    const atr14Pct = diagnosticAtrPct(history, 14);
    const rangePct = c && c.open ? ((c.high - c.low) / c.open) * 100 : null;
    const liveCandidates = liveRows.filter((r) => !String(r.reason ?? '').includes('outside early target window'));
    const firstRelevantLive = liveCandidates[liveCandidates.length - 1] ?? liveRows[liveRows.length - 1];
    const liveDecision = trade ? 'TRADE' : firstRelevantLive?.decision;
    const liveReason = trade ? String(trade.id ? `trade row id ${trade.id}` : 'trade row') : String(firstRelevantLive?.reason ?? '');
    let finalDecision = '';
    let failReason = '';

    if (!c) {
      finalDecision = 'BLOCK';
      failReason = 'missing_signal_candle';
      counts.features_not_ready += 1;
    } else if (!features) {
      finalDecision = 'BLOCK';
      failReason = 'features_not_ready';
      counts.features_not_ready += 1;
    } else if (!rulesPass) {
      finalDecision = 'BLOCK';
      failReason = classifyRuleFailure(features);
      if (features.closePos < RULES.closePosMin) allGateFailures.closePos += 1;
      if (features.ema20Slope3 < RULES.ema20Slope3Min) allGateFailures.ema20Slope3 += 1;
      if (features.ema100Dist < RULES.ema100DistMin) allGateFailures.ema100Dist += 1;
      if (failReason === 'closePos') counts.rejected_by_closePos_rule += 1;
      if (failReason === 'ema20Slope3') counts.rejected_by_ema20Slope3_rule += 1;
      if (failReason === 'ema100Dist') counts.rejected_by_ema100Dist_rule += 1;
    } else {
      counts.potential_down_signals_before_kalshi_filters += 1;
      if (trade) {
        counts.executed_trades += 1;
        finalDecision = 'TRADE';
        failReason = 'executed';
      } else {
        finalDecision = 'BLOCK';
        const liveClass = classifyLiveReject(liveReason);
        failReason = liveClass;
        if (liveClass === 'kalshi_market_availability') counts.rejected_by_kalshi_market_availability += 1;
        else if (liveClass === 'kalshi_price_data') counts.rejected_by_kalshi_price_data += 1;
        else if (liveClass === 'price_cap') counts.rejected_by_price_cap += 1;
        else if (liveClass === 'ev_gate') counts.rejected_by_ev_gate += 1;
        else if (liveClass === 'halt') counts.rejected_by_halt += 1;
        else if (liveClass === 'balance_read') counts.rejected_by_balance_read += 1;
        else if (liveClass === 'sizing') counts.rejected_by_sizing += 1;
        else if (liveClass === 'arming_gate') counts.rejected_by_arming_gate += 1;
        else if (liveClass === 'order_failed') counts.rejected_by_order_failed += 1;
        else if (liveClass === 'order_unfilled') counts.rejected_by_order_unfilled += 1;
        else counts.possible_missed_rule_pass_no_live_decision += 1;
      }
    }

    if (features && firstRelevantLive && firstRelevantLive.close_pos != null) {
      const liveClosePos = Number(firstRelevantLive.close_pos);
      const liveSlope = Number(firstRelevantLive.ema20_slope3);
      const liveDist = Number(firstRelevantLive.ema100_dist);
      featureCompareRows.push({
        target_window_start_utc: iso(target),
        live_decision_ts_utc: iso(Number(firstRelevantLive.ts)),
        replay_close_pos: features.closePos,
        live_close_pos: liveClosePos,
        close_pos_delta: features.closePos - liveClosePos,
        replay_ema20_slope3: features.ema20Slope3,
        live_ema20_slope3: liveSlope,
        ema20_slope3_delta: features.ema20Slope3 - liveSlope,
        replay_ema100_dist: features.ema100Dist,
        live_ema100_dist: liveDist,
        ema100_dist_delta: features.ema100Dist - liveDist,
      });
    }

    replayRows.push({
      target_window_start_utc: iso(target),
      target_window_start_et: et(target),
      signal_candle_utc: iso(signalTs),
      eth_open: c?.open ?? null,
      eth_high: c?.high ?? null,
      eth_low: c?.low ?? null,
      eth_close: c?.close ?? null,
      eth_volume: c?.volume ?? null,
      close_pos: features?.closePos ?? null,
      ema20_slope3: features?.ema20Slope3 ?? null,
      ema100_dist: features?.ema100Dist ?? null,
      production_market_regime: 'not_used_by_k6',
      diagnostic_range_pct: rangePct,
      diagnostic_atr14_pct: atr14Pct,
      production_pattern_detection: rulesPass ? 'DOWN_exhaustion_rules_passed' : 'DOWN_exhaustion_rules_failed',
      diagnostic_signal_score_0_to_3: signalScore,
      p_down_conservative: P_DOWN_CONSERVATIVE,
      rule_reason: features ? ruleReason(features) : 'features not ready',
      closePos_filter: features ? features.closePos >= RULES.closePosMin : false,
      ema20Slope3_filter: features ? features.ema20Slope3 >= RULES.ema20Slope3Min : false,
      ema100Dist_filter: features ? features.ema100Dist >= RULES.ema100DistMin : false,
      production_rules_pass: rulesPass,
      live_decision_rows_for_target: liveRows.length,
      live_first_decision_ts_utc: iso(Number(firstRelevantLive?.ts ?? 0)) || '',
      live_decision: liveDecision ?? '',
      live_reason: liveReason,
      live_market_ticker: firstRelevantLive?.kalshi_market_ticker ?? trade?.market_ticker ?? '',
      live_selected_exec_price: firstRelevantLive?.selected_exec_price ?? trade?.limit_price ?? null,
      live_fee_adjusted_ev: firstRelevantLive?.fee_adjusted_ev ?? trade?.fee_adjusted_ev ?? null,
      local_orders_for_target: targetOrders.length,
      final_trade_decision: finalDecision,
      pass_fail_reason: failReason,
    });
  }

  const expectedTargets = replayRows.map((r) => Date.parse(String(r.target_window_start_utc)));
  const targetsWithRows = new Set<number>([
    ...Array.from(decisionsByTarget.keys()),
    ...Array.from(tradesByTarget.keys()),
    ...Array.from(ordersByTarget.keys()),
  ]);
  const missingSchedulerTargets = expectedTargets.filter((t) => !targetsWithRows.has(t));
  const outsideWindowRows = decisions.filter((d) => String(d.reason ?? '').includes('outside early target window')).length;

  const sensitivity = {
    baseline_all_three_rules_pass: replayRows.filter((r) => r.production_rules_pass === true).length,
    closePos_disabled: replayRows.filter((r) => {
      const f = {
        slope: Number(r.ema20_slope3),
        dist: Number(r.ema100_dist),
      };
      return Number.isFinite(f.slope) && Number.isFinite(f.dist) && f.slope >= RULES.ema20Slope3Min && f.dist >= RULES.ema100DistMin;
    }).length,
    ema20Slope3_disabled: replayRows.filter((r) => {
      const closePos = Number(r.close_pos);
      const dist = Number(r.ema100_dist);
      return Number.isFinite(closePos) && Number.isFinite(dist) && closePos >= RULES.closePosMin && dist >= RULES.ema100DistMin;
    }).length,
    ema100Dist_disabled: replayRows.filter((r) => {
      const closePos = Number(r.close_pos);
      const slope = Number(r.ema20_slope3);
      return Number.isFinite(closePos) && Number.isFinite(slope) && closePos >= RULES.closePosMin && slope >= RULES.ema20Slope3Min;
    }).length,
    price_cap_disabled_on_rule_pass_live_quotes: replayRows.filter((r) =>
      r.production_rules_pass === true && r.live_selected_exec_price != null
    ).length,
    ev_threshold_disabled_on_rule_pass_live_quotes: replayRows.filter((r) => {
      if (r.production_rules_pass !== true || r.live_selected_exec_price == null) return false;
      return Number(r.live_selected_exec_price) <= MAX_NO_PRICE;
    }).length,
    cooldown_disabled: 'not_applicable_no_cooldown_module_in_k6; duplicate guard only prevents same-window repeat',
  };

  const maxFeatureDeltas = featureCompareRows.reduce((acc, r) => {
    acc.close_pos = Math.max(acc.close_pos, Math.abs(Number(r.close_pos_delta)));
    acc.ema20_slope3 = Math.max(acc.ema20_slope3, Math.abs(Number(r.ema20_slope3_delta)));
    acc.ema100_dist = Math.max(acc.ema100_dist, Math.abs(Number(r.ema100_dist_delta)));
    return acc;
  }, { close_pos: 0, ema20_slope3: 0, ema100_dist: 0 });

  const currentNow = Date.now();
  const schedulerAudit = {
    current_utc: iso(currentNow),
    current_local_et: et(currentNow),
    current_window_start_utc: iso(currentTargetStart),
    next_candle_time_utc: iso(currentTargetStart + CANDLE_MS),
    next_candle_time_et: et(currentTargetStart + CANDLE_MS),
    previous_candle_processed_by_replay_utc: iso(currentTargetStart - CANDLE_MS),
    expected_target_windows_since_last_trade: expectedTargets.length,
    targets_with_any_live_row_or_order: targetsWithRows.size,
    skipped_target_windows_without_any_live_row_or_order: missingSchedulerTargets.length,
    skipped_targets_sample_utc: missingSchedulerTargets.slice(0, 20).map(iso),
    outside_window_rows: outsideWindowRows,
    last_heartbeat_utc: iso(Number(lastHeartbeat?.ts ?? 0)),
    last_heartbeat_et: et(Number(lastHeartbeat?.ts ?? 0)),
    last_heartbeat_age_seconds: lastHeartbeat ? Math.round((currentNow - Number(lastHeartbeat.ts)) / 1000) : null,
    last_heartbeat_status: lastHeartbeat?.status ?? null,
    last_heartbeat_armed: lastHeartbeat?.armed ?? null,
    last_heartbeat_message: lastHeartbeat?.message ?? null,
  };

  const riskAudit = {
    armed: cfg.get('k6_live_trading_armed') === 'ARMED',
    armed_config_value: cfg.get('k6_live_trading_armed'),
    halt: cfg.get('k6_halt'),
    halt_reason: cfg.get('k6_halt_reason') ?? '',
    stake_dollars: stakeDollars,
    last_balance: cfg.get('k6_last_balance') ?? null,
    last_balance_ts_utc: iso(Number(cfg.get('k6_last_balance_ts') ?? 0)),
    open_trades_count: openTrades.length,
    open_trades: openTrades.map((t) => ({ id: t.id, target_window_start: iso(Number(t.target_window_start)), market_ticker: t.market_ticker })),
    nonterminal_strategy_orders_count: nonTerminalOrders.length,
    nonterminal_strategy_orders: nonTerminalOrders.map((o) => ({ id: o.id, status: o.status, target_window_start: iso(Number(o.target_window_start)), market_ticker: o.market_ticker })),
    recent_equity: recentEquity.map((e) => ({ ts: iso(Number(e.ts)), balance: e.balance, source: e.source })),
    size_order_at_last_balance_and_max_price: Number.isFinite(Number(cfg.get('k6_last_balance')))
      ? sizeOrder(stakeDollars, Number(cfg.get('k6_last_balance')), MAX_NO_PRICE)
      : null,
  };

  const codePathAudit = {
    replay_imports_live_k6_modules: [
      '../scanner/strategy.js',
      '../scanner/config.js',
      '../scanner/ev.js',
      '../scanner/sizing.js',
      '../scanner/kalshi-markets.js',
      '../scanner/kalshi-client.js',
    ],
    live_loop_file: path.join(ROOT, 'scanner', 'index.ts'),
    replay_file: fileURLToPath(import.meta.url),
    scanner_index_sha256: sha256(path.join(ROOT, 'scanner', 'index.ts')),
    scanner_strategy_sha256: sha256(path.join(ROOT, 'scanner', 'strategy.ts')),
    scanner_config_sha256: sha256(path.join(ROOT, 'scanner', 'config.ts')),
    scanner_kalshi_markets_sha256: sha256(path.join(ROOT, 'scanner', 'kalshi-markets.ts')),
    feature_comparisons_against_live_db_rows: featureCompareRows.length,
    max_abs_feature_delta_replay_vs_live_db: maxFeatureDeltas,
    production_filters_present: [
      'signal candle alignment',
      'computeFeatures warmup/zero range',
      'closePos >= 0.8240',
      'ema20Slope3 >= 0.0018',
      'ema100Dist >= 0.2474',
      'Kalshi exact target market active',
      'NO quote available',
      'NO price <= 0.515',
      'feeAdjustedEv(0.566, price) > 0.03',
      'halt flag off',
      'balance read succeeds',
      'fixed stake sizes to >=1 contract',
      'armed flag',
      'live order fills',
    ],
    production_filters_absent: [
      'separate regime filter',
      'separate volatility filter',
      'separate trend module beyond ema100Dist and ema20Slope3',
      'cooldown timer beyond same-window duplicate guard',
      'multi-candle confirmation filter',
    ],
  };

  const kalshiAudit = await kalshiValidation(currentTargetStart, lastTradeCreatedAt);
  const pm2 = runCmd('cmd.exe', ['/c', 'pm2', 'jlist'], ROOT);

  const rulePassRows = replayRows.filter((r) => r.production_rules_pass === true);
  const missedOppRows = replayRows.filter((r) => r.pass_fail_reason === 'other' || r.pass_fail_reason === 'possible_missed_rule_pass_no_live_decision');

  const summary = {
    generated_at_utc: iso(Date.now()),
    generated_at_et: et(Date.now()),
    db_path: DB_PATH,
    output_dir: OUT_DIR,
    strategy: STRATEGY,
    symbol: SYMBOL,
    interval: INTERVAL,
    last_trade: {
      id: lastTrade.id,
      created_at_utc: iso(lastTradeCreatedAt),
      created_at_et: et(lastTradeCreatedAt),
      target_window_start_utc: iso(lastTarget),
      target_window_start_et: et(lastTarget),
      market_ticker: lastTrade.market_ticker,
      avg_fill_price: lastTrade.avg_fill_price,
      contracts: lastTrade.contracts,
      fee_adjusted_ev: lastTrade.fee_adjusted_ev,
    },
    replay_window: {
      start_target_utc: iso(replayStartTarget),
      start_target_et: et(replayStartTarget),
      end_target_utc: iso(currentTargetStart),
      end_target_et: et(currentTargetStart),
      candle_fetch_start_utc: iso(fetchStart),
      candle_fetch_end_utc: iso(fetchEnd),
    },
    thresholds: {
      closePosMin: RULES.closePosMin,
      ema20Slope3Min: RULES.ema20Slope3Min,
      ema100DistMin: RULES.ema100DistMin,
      pDownConservative: P_DOWN_CONSERVATIVE,
      maxNoPrice: MAX_NO_PRICE,
      minFeeAdjustedEv: MIN_FEE_ADJUSTED_EV,
      maxTargetAgeMs: MAX_TARGET_AGE_MS,
      minTargetRemainingMs: MIN_TARGET_REMAINING_MS,
    },
    signal_audit: counts,
    all_rule_gate_failures_not_first_failure: allGateFailures,
    sensitivity,
    candle_audit: candleAudit,
    scheduler_audit: schedulerAudit,
    risk_audit: riskAudit,
    code_path_audit: codePathAudit,
    kalshi_audit: kalshiAudit,
    pm2_audit: pm2,
    rule_pass_candidates: rulePassRows.map((r) => ({
      target_window_start_utc: r.target_window_start_utc,
      target_window_start_et: r.target_window_start_et,
      eth_close: r.eth_close,
      close_pos: r.close_pos,
      ema20_slope3: r.ema20_slope3,
      ema100_dist: r.ema100_dist,
      live_decision: r.live_decision,
      live_reason: r.live_reason,
      live_selected_exec_price: r.live_selected_exec_price,
      live_fee_adjusted_ev: r.live_fee_adjusted_ev,
      pass_fail_reason: r.pass_fail_reason,
    })),
    possible_missed_opportunities: missedOppRows,
  };

  const md = [
    '# Kronos 6 No-Trade Investigation',
    '',
    `Generated: ${summary.generated_at_utc} / ${summary.generated_at_et} ET`,
    `DB: ${DB_PATH}`,
    '',
    '## Replay Window',
    '',
    `Last trade: ${summary.last_trade.created_at_utc} / ${summary.last_trade.created_at_et} ET, target ${summary.last_trade.target_window_start_utc}, market ${summary.last_trade.market_ticker}`,
    `Replay targets: ${summary.replay_window.start_target_utc} through ${summary.replay_window.end_target_utc}`,
    '',
    '## Signal Audit',
    '',
    ...Object.entries(counts).map(([k, v]) => `- ${k}: ${v}`),
    '',
    '## Rule Gate Failures (All Failed Gates, Not Just First)',
    '',
    ...Object.entries(allGateFailures).map(([k, v]) => `- ${k}: ${v}`),
    '',
    '## Sensitivity',
    '',
    ...Object.entries(sensitivity).map(([k, v]) => `- ${k}: ${v}`),
    '',
    '## Scheduler',
    '',
    ...Object.entries(schedulerAudit).map(([k, v]) => `- ${k}: ${Array.isArray(v) ? v.join('; ') : JSON.stringify(v)}`),
    '',
    '## Candle Audit',
    '',
    ...Object.entries(candleAudit).map(([k, v]) => `- ${k}: ${v}`),
    '',
    '## Risk Controls',
    '',
    ...Object.entries(riskAudit).map(([k, v]) => `- ${k}: ${JSON.stringify(v)}`),
    '',
    '## Kalshi API',
    '',
    ...Object.entries(kalshiAudit).map(([k, v]) => `- ${k}: ${JSON.stringify(v)}`),
    '',
    '## Rule-Pass Candidates',
    '',
    rulePassRows.length === 0 ? '- none' : rulePassRows.map((r) => `- ${r.target_window_start_utc} ET ${r.target_window_start_et}: ${r.live_reason} price=${r.live_selected_exec_price ?? ''} ev=${r.live_fee_adjusted_ev ?? ''}`).join('\n'),
    '',
  ].join('\n');

  writeFileSync(path.join(OUT_DIR, 'summary.json'), JSON.stringify(summary, null, 2), 'utf8');
  writeFileSync(path.join(OUT_DIR, 'report.md'), md, 'utf8');
  writeCsv(path.join(OUT_DIR, 'replay_rows.csv'), replayRows);
  writeFileSync(path.join(OUT_DIR, 'replay_rows.json'), JSON.stringify(replayRows, null, 2), 'utf8');
  writeCsv(path.join(OUT_DIR, 'feature_compare_rows.csv'), featureCompareRows);
  writeFileSync(path.join(OUT_DIR, 'feature_compare_rows.json'), JSON.stringify(featureCompareRows, null, 2), 'utf8');

  console.log(JSON.stringify({
    outDir: OUT_DIR,
    generatedAtUtc: summary.generated_at_utc,
    totalCandles: counts.total_candles_processed,
    potentialSignals: counts.potential_down_signals_before_kalshi_filters,
    executedTrades: counts.executed_trades,
    possibleMissed: counts.possible_missed_rule_pass_no_live_decision,
    skippedTargets: schedulerAudit.skipped_target_windows_without_any_live_row_or_order,
    maxFeatureDeltas,
  }, null, 2));
}

main().catch((e) => {
  console.error((e as Error).stack ?? e);
  process.exit(1);
});
