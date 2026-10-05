// SQLite live-trading ledger (node:sqlite, WAL) — Kronos 5 pattern, live shape.
// The Kalshi account balance is the authoritative equity; this DB is the
// complete local record of orders, fills, trades, settlements, and equity.
// No credentials are ever stored here.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  STRATEGY, DEFAULT_STAKE_DOLLARS, MAX_STAKE_DOLLARS, UNARMED_VALUE, ARMED_VALUE,
} from './config.js';
import type { Features, NoQuote } from './types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DB_PATH = path.join(__dirname, '..', 'db', 'kronos6.db');
const INIT_SQL = path.join(__dirname, '..', 'db', 'init.sql');

let db: DatabaseSync | null = null;

export function getDb(): DatabaseSync {
  if (db) return db;
  db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec(readFileSync(INIT_SQL, 'utf8'));
  ensureInstrumentationColumns(db);
  return db;
}

// Settlement-divergence instrumentation (2026-08-17, per operator): record the
// Kalshi strike and our index view at entry on every trade. DATA CAPTURE ONLY —
// nothing reads these columns and no decision logic depends on them. Idempotent
// ALTERs so existing live DBs migrate in place at startup.
function ensureInstrumentationColumns(d: DatabaseSync): void {
  const wanted: [string, string][] = [
    ['strike_price', 'REAL'],
    ['strike_type', 'TEXT'],
    ['index_price_at_entry', 'REAL'],
    ['index_price_source', 'TEXT'],
  ];
  // Both tables: `trades` covers bets actually placed, `decisions` keeps the data
  // flowing when the bot is halted (stop-loss trip) or otherwise not trading —
  // a halt must never blind the settlement-divergence study.
  for (const table of ['trades', 'decisions']) {
    const existing = new Set(
      (d.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name),
    );
    for (const [col, type] of wanted) {
      if (!existing.has(col)) d.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
    }
  }
}

export function getConfig(key: string): string | null {
  const r = getDb().prepare('SELECT value FROM config WHERE key = ?').get(key) as { value: string } | undefined;
  return r ? r.value : null;
}

export function setConfig(key: string, value: string): void {
  getDb().prepare('INSERT INTO config(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}

export function ensureDefaults(): void {
  const d = getDb();
  const now = Date.now();
  const defaults: Record<string, string> = {
    k6_env: 'LIVE (funded Kalshi account)',
    k6_live_trading_armed: UNARMED_VALUE,   // ARMED only via scripts/arm-live-trading.mjs
    k6_halt: '0',                           // 1 = operator/audit halt: no new trades
    k6_stake_dollars: DEFAULT_STAKE_DOLLARS.toFixed(2),
    k6_start_ts: String(now),
    k6_target_trades: '120',
  };
  for (const [k, v] of Object.entries(defaults)) {
    d.prepare('INSERT OR IGNORE INTO config(key, value) VALUES(?, ?)').run(k, v);
  }
}

// ── live-trading gates ───────────────────────────────────────────────────────
export function isArmed(): boolean {
  return getConfig('k6_live_trading_armed') === ARMED_VALUE;
}

export function isHalted(): boolean {
  return getConfig('k6_halt') === '1';
}

export function setHalt(on: boolean, reason: string): void {
  setConfig('k6_halt', on ? '1' : '0');
  setConfig('k6_halt_reason', on ? reason : '');
}

/** Fixed dollar stake, read from config each tick. Fail closed on bad values. */
export function getStakeDollars(): number {
  const v = Number(getConfig('k6_stake_dollars') ?? DEFAULT_STAKE_DOLLARS);
  if (!Number.isFinite(v) || v <= 0 || v > MAX_STAKE_DOLLARS) {
    throw new Error(`[K6 FATAL] k6_stake_dollars=${getConfig('k6_stake_dollars')} is invalid (must be in (0, ${MAX_STAKE_DOLLARS}]) — refusing to trade.`);
  }
  return v;
}

/**
 * Balance-floor stop loss, in dollars, or null when no stop is configured.
 * The key is absent by default (no stop) and is set only via
 * scripts/set-stop-loss.mjs. An invalid stored value is treated as "no stop"
 * and loudly logged — it must never silently arm or disarm the guard.
 */
export function getStopLossDollars(): number | null {
  const raw = getConfig('k6_stop_loss_dollars');
  if (raw == null || raw === '') return null;
  const v = Number(raw);
  if (!Number.isFinite(v) || v <= 0) {
    console.error(`[K6 WARN] k6_stop_loss_dollars=${raw} is not a positive number — treating stop loss as DISABLED. Fix with scripts/set-stop-loss.mjs.`);
    return null;
  }
  return v;
}

/**
 * Trailing distance for the stop loss, in dollars, or null when the stop is
 * static (or absent). Set only via scripts/set-trailing-stop.mjs. When present,
 * the scanner raises k6_stop_loss_dollars to (fresh balance - trail) whenever
 * that is higher than the current floor; the floor never moves down. Same
 * validation posture as getStopLossDollars: garbage disables loudly.
 */
export function getTrailStopDollars(): number | null {
  const raw = getConfig('k6_stop_loss_trail_dollars');
  if (raw == null || raw === '') return null;
  const v = Number(raw);
  if (!Number.isFinite(v) || v <= 0) {
    console.error(`[K6 WARN] k6_stop_loss_trail_dollars=${raw} is not a positive number — trailing DISABLED (static floor, if any, still applies). Fix with scripts/set-trailing-stop.mjs.`);
    return null;
  }
  return v;
}

// ── decisions ────────────────────────────────────────────────────────────────
export interface DecisionRow {
  ts: number;
  targetWindowStart: number | null;
  targetWindowEnd: number | null;
  decision: 'TRADE' | 'BLOCK' | 'DRY_RUN';
  reason: string;
  features?: Features | null;
  pDown?: number | null;
  seriesTicker?: string | null;
  eventTicker?: string | null;
  marketTicker?: string | null;
  quote?: NoQuote | null;
  selectedExecPrice?: number | null;
  estimatedFee?: number | null;
  feeAdjustedEv?: number | null;
  // instrumentation only — recorded even while halted
  strikePrice?: number | null;
  strikeType?: string | null;
  indexPriceAtEntry?: number | null;
  indexPriceSource?: string | null;
}

export function insertDecision(r: DecisionRow): void {
  getDb().prepare(`INSERT INTO decisions
    (ts, target_window_start, target_window_end, decision, reason,
     close_pos, ema20_slope3, ema100_dist, p_down,
     kalshi_series_ticker, kalshi_event_ticker, kalshi_market_ticker,
     yes_bid, yes_ask, no_bid, no_ask,
     selected_exec_price, spread, available_size, estimated_fee, fee_adjusted_ev, market_data_ts,
     strike_price, strike_type, index_price_at_entry, index_price_source)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(
      r.ts, r.targetWindowStart, r.targetWindowEnd, r.decision, r.reason,
      r.features?.closePos ?? null, r.features?.ema20Slope3 ?? null, r.features?.ema100Dist ?? null, r.pDown ?? null,
      r.seriesTicker ?? null, r.eventTicker ?? null, r.marketTicker ?? null,
      r.quote?.yesBid ?? null, r.quote?.yesAsk ?? null, r.quote?.noBid ?? null, r.quote?.noAsk ?? null,
      r.selectedExecPrice ?? null,
      r.quote && r.quote.noBid != null && r.quote.noAsk != null ? Number((r.quote.noAsk - r.quote.noBid).toFixed(6)) : null,
      r.quote?.size ?? null, r.estimatedFee ?? null, r.feeAdjustedEv ?? null, r.quote?.ts ?? null,
      r.strikePrice ?? null, r.strikeType ?? null,
      r.indexPriceAtEntry ?? null, r.indexPriceSource ?? null,
    );
  setConfig('k6_last_decision', JSON.stringify({ ts: r.ts, decision: r.decision, reason: r.reason.slice(0, 300) }));
}

// ── orders ───────────────────────────────────────────────────────────────────
export interface OrderIntent {
  localOrderUuid: string;
  clientOrderId: string;
  marketTicker: string;
  targetWindowStart: number;
  requestedPrice: number;      // NO dollars
  requestedYesPrice: number;
  requestedQuantity: number;
  estimatedFee: number;
  purpose?: 'strategy' | 'connectivity_test';
}

export function insertOrderIntent(o: OrderIntent): number {
  const res = getDb().prepare(`INSERT INTO orders
    (local_order_uuid, client_order_id, market_ticker, target_window_start,
     strategy_direction, kalshi_outcome, action, order_type, time_in_force,
     requested_price, requested_yes_price, requested_quantity, status, purpose,
     estimated_fee, submitted_at, updated_at)
    VALUES (?,?,?,?,'DOWN','no','buy','limit','good_till_canceled',?,?,?,'pending_submit',?,?,?,?)`)
    .run(
      o.localOrderUuid, o.clientOrderId, o.marketTicker, o.targetWindowStart,
      o.requestedPrice, o.requestedYesPrice, o.requestedQuantity,
      o.purpose ?? 'strategy', o.estimatedFee, Date.now(), Date.now(),
    );
  return Number(res.lastInsertRowid);
}

export function updateOrder(clientOrderId: string, fields: Record<string, string | number | null>): void {
  const keys = Object.keys(fields);
  if (keys.length === 0) return;
  const sets = keys.map((k) => `${k} = ?`).join(', ');
  getDb().prepare(`UPDATE orders SET ${sets}, updated_at = ? WHERE client_order_id = ?`)
    .run(...keys.map((k) => fields[k]), Date.now(), clientOrderId);
}

/** True if any order for this window is not in a terminal-failure state — the
 *  live-side duplicate guard (backs up the trades UNIQUE index and protects
 *  against the crash-after-submit / before-trade-row case). */
export function hasLiveOrderForWindow(targetWindowStart: number): boolean {
  const r = getDb().prepare(`SELECT id FROM orders
    WHERE target_window_start = ? AND purpose = 'strategy'
      AND status NOT IN ('submit_failed', 'rejected')`).get(targetWindowStart);
  return r !== undefined;
}

export function insertFill(f: {
  orderRowId: number; kalshiOrderId: string | null; kalshiTradeId: string | null;
  marketTicker: string; count: number; noPrice: number | null; yesPrice: number | null;
  fee: number | null; isTaker: number | null; source: string;
}): void {
  getDb().prepare(`INSERT INTO fills
    (order_row_id, kalshi_order_id, kalshi_trade_id, market_ticker, count,
     no_price, yes_price, fee, is_taker, source, observed_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(f.orderRowId, f.kalshiOrderId, f.kalshiTradeId, f.marketTicker, f.count,
      f.noPrice, f.yesPrice, f.fee, f.isTaker, f.source, Date.now());
}

// ── trades ───────────────────────────────────────────────────────────────────
export function hasTradeForWindow(targetWindowStart: number): boolean {
  const r = getDb().prepare('SELECT id FROM trades WHERE strategy = ? AND target_window_start = ?')
    .get(STRATEGY, targetWindowStart);
  return r !== undefined;
}

export interface NewTrade {
  targetWindowStart: number;
  targetWindowEnd: number;
  eventTicker: string;
  marketTicker: string;
  orderRowId: number;
  pDown: number;
  features: Features;
  limitPrice: number;
  priceSource: string;
  quote: NoQuote | null;
  liquidityWarning: string | null;
  intendedStake: number;
  contracts: number;
  requestedContracts: number;
  avgFillPrice: number;
  positionCost: number;
  feeAmount: number | null;
  feeAdjustedEv: number;
  partialFill: boolean;
  balanceBefore: number | null;
  // instrumentation only — see ensureInstrumentationColumns()
  strikePrice: number | null;
  strikeType: string | null;
  indexPriceAtEntry: number | null;
  indexPriceSource: string | null;
}

export function insertTrade(t: NewTrade): number {
  const res = getDb().prepare(`INSERT INTO trades
    (ts, strategy, symbol, interval, strategy_direction, kalshi_outcome,
     target_window_start, target_window_end, event_ticker, market_ticker, order_row_id,
     p_down, close_pos, ema20_slope3, ema100_dist,
     limit_price, price_source, yes_bid, yes_ask, no_bid, no_ask,
     book_no_ask, book_size, spread, liquidity_warning, market_data_ts,
     intended_stake, contracts, requested_contracts, avg_fill_price, position_cost,
     fee_amount, fee_adjusted_ev, partial_fill, balance_before, created_at,
     strike_price, strike_type, index_price_at_entry, index_price_source)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(
      Date.now(),
      STRATEGY, 'ETHUSD', '15m', 'DOWN', 'no',
      t.targetWindowStart, t.targetWindowEnd, t.eventTicker, t.marketTicker, t.orderRowId,
      t.pDown, t.features.closePos, t.features.ema20Slope3, t.features.ema100Dist,
      t.limitPrice, t.priceSource,
      t.quote?.yesBid ?? null, t.quote?.yesAsk ?? null, t.quote?.noBid ?? null, t.quote?.noAsk ?? null,
      t.quote?.bookNoAsk ?? null, t.quote?.size ?? null,
      t.quote && t.quote.noBid != null && t.quote.noAsk != null ? Number((t.quote.noAsk - t.quote.noBid).toFixed(6)) : null,
      t.liquidityWarning, t.quote?.ts ?? null,
      t.intendedStake, t.contracts, t.requestedContracts, t.avgFillPrice, t.positionCost,
      t.feeAmount, t.feeAdjustedEv, t.partialFill ? 1 : 0, t.balanceBefore, Date.now(),
      t.strikePrice, t.strikeType, t.indexPriceAtEntry, t.indexPriceSource,
    );
  const tradeId = Number(res.lastInsertRowid);
  getDb().prepare('UPDATE orders SET trade_id = ? WHERE id = ?').run(tradeId, t.orderRowId);
  return tradeId;
}

export function getOpenTrades(): Record<string, unknown>[] {
  return getDb().prepare('SELECT * FROM trades WHERE strategy = ? AND correct IS NULL ORDER BY created_at')
    .all(STRATEGY) as Record<string, unknown>[];
}

export interface SettleFields {
  kalshiResult: string | null;
  coinbaseComparison: string | null;
  correct: number;
  settlementRevenue: number;
  grossPnl: number;
  netPnl: number;
  balanceAfter: number | null;
  settlementSource: 'kalshi_live' | 'kalshi_settlements';
}

export function settleTrade(id: number, s: SettleFields): void {
  getDb().prepare(`UPDATE trades SET
    kalshi_result = ?, coinbase_comparison_result = ?, correct = ?,
    settlement_revenue = ?, gross_pnl = ?, net_pnl = ?,
    balance_after = ?, settlement_source = ?, settled_at = ?
    WHERE id = ?`)
    .run(s.kalshiResult, s.coinbaseComparison, s.correct, s.settlementRevenue,
      s.grossPnl, s.netPnl, s.balanceAfter, s.settlementSource, Date.now(), id);
}

// ── settlements / equity / heartbeat ────────────────────────────────────────
export function upsertSettlement(s: {
  marketTicker: string; marketResult: string | null; revenue: number | null;
  feeCost: number | null; noCount: number | null; noTotalCost: number | null; settledTime: string | null;
}): void {
  getDb().prepare(`INSERT OR IGNORE INTO settlements
    (market_ticker, market_result, revenue, fee_cost, no_count, no_total_cost, settled_time, fetched_at)
    VALUES (?,?,?,?,?,?,?,?)`)
    .run(s.marketTicker, s.marketResult, s.revenue, s.feeCost, s.noCount, s.noTotalCost, s.settledTime, Date.now());
}

export function recordEquity(balance: number, source: string): void {
  getDb().prepare('INSERT INTO equity(ts, balance, source) VALUES(?,?,?)').run(Date.now(), balance, source);
  setConfig('k6_last_balance', String(balance));
  setConfig('k6_last_balance_ts', String(Date.now()));
}

export function recordHeartbeat(status: string, armed: boolean, balance: number | null, message: string): void {
  getDb().prepare('INSERT INTO heartbeat(ts, status, armed, balance, message) VALUES(?,?,?,?,?)')
    .run(Date.now(), status, armed ? 1 : 0, balance, message.slice(0, 400));
  setConfig('k6_heartbeat_ts', String(Date.now()));
  setConfig('k6_heartbeat_status', status);
}
