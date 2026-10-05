// Kronos 6 v1 — frozen configuration (LIVE-trading evolution of Kronos 5, 2026-07-12).
// Strategy constants are carried forward VERBATIM from Kronos 5 v1 (which carried
// them from Kronos 4 v1). There is NO strategy development in Kronos 6: the only
// change from Kronos 5 is that simulated execution becomes real Kalshi execution.
// Do not tune anything in this file.

export const STRATEGY = 'kronos6_down_exhaustion_15m_live_v1' as const;
export const SYMBOL = 'ETHUSD' as const;
export const INTERVAL = '15m' as const;
export const STRATEGY_DIRECTION = 'DOWN' as const;

// ---------------------------------------------------------------------------
// LIVE-MONEY SAFETY BOUNDARY (hard architectural invariants)
// ---------------------------------------------------------------------------
// Kronos 6 trades REAL MONEY on the live Kalshi exchange. The safety model is
// therefore the inverse of Kronos 5's read-only wall — instead of forbidding
// all writes, it permits EXACTLY the writes live trading requires and nothing
// else, and it refuses to submit any order until a human has explicitly armed
// live trading (config key `k6_live_trading_armed` = 'ARMED', set only by
// scripts/arm-live-trading.mjs, which requires typed confirmation).
//
//   - Approved host only (external-api.kalshi.com).
//   - POST is allowed ONLY to /portfolio/events/orders          (create order)
//   - DELETE is allowed ONLY to /portfolio/events/orders/{id}   (cancel order)
//   - GET is allowed for market data and portfolio reads.
//   - Everything else (transfers, deposits, withdrawals, api_keys, account,
//     communications, fcm...) is refused before the request is built.
export const KALSHI_ENV = 'live_trading' as const;
export const KALSHI_REST_URL = 'https://external-api.kalshi.com/trade-api/v2' as const;
/**
 * Kalshi splits collateral across exchange shards; ETH 15m markets settle on the
 * Crypto shard (index 2). Balance reads must use this shard, not the account-wide
 * total — see getBalance(). Override with K6_EXCHANGE_INDEX if Kalshi renumbers.
 */
export const KALSHI_EXCHANGE_INDEX = Number(process.env.K6_EXCHANGE_INDEX ?? 2);
export const APPROVED_REST_HOST = 'external-api.kalshi.com' as const;

// The ONLY mutating endpoints Kronos 6 may ever call.
const ALLOWED_POST_PATHS = [/^\/trade-api\/v2\/portfolio\/events\/orders$/] as const;
const ALLOWED_DELETE_PATHS = [/^\/trade-api\/v2\/portfolio\/events\/orders\/[A-Za-z0-9._-]+$/] as const;
// GET prefixes needed for market data + order/position/settlement tracking.
const ALLOWED_GET_PREFIXES = [
  '/trade-api/v2/markets',
  '/trade-api/v2/series',
  '/trade-api/v2/exchange/status',
  '/trade-api/v2/portfolio/balance',
  '/trade-api/v2/portfolio/orders',
  '/trade-api/v2/portfolio/positions',
  '/trade-api/v2/portfolio/settlements',
  '/trade-api/v2/portfolio/fills',
] as const;
// Never touch these no matter what (defense in depth on top of the allowlists).
const FORBIDDEN_PATH_FRAGMENTS = ['/api_keys', '/communications', '/account', '/fcm', 'transfer', 'deposit', 'withdraw'] as const;

/**
 * Fail-closed request gate. Called by the HTTP client on EVERY request before
 * it is sent. Anything not explicitly allowed is refused.
 */
export function assertAllowedRequest(method: string, urlToCheck: string): void {
  const u = new URL(urlToCheck);
  if (u.host.toLowerCase() !== APPROVED_REST_HOST) {
    throw new Error(`[K6 FATAL] request host ${u.host} is not the approved Kalshi host — refusing request.`);
  }
  const p = u.pathname;
  for (const frag of FORBIDDEN_PATH_FRAGMENTS) {
    if (p.toLowerCase().includes(frag)) {
      throw new Error(`[K6 FATAL] request path ${p} touches forbidden surface (${frag}) — refusing request.`);
    }
  }
  const m = method.toUpperCase();
  if (m === 'GET') {
    if (!ALLOWED_GET_PREFIXES.some((pre) => p.startsWith(pre))) {
      throw new Error(`[K6 FATAL] GET ${p} is not on the allowlist — refusing request.`);
    }
    return;
  }
  if (m === 'POST') {
    if (!ALLOWED_POST_PATHS.some((re) => re.test(p))) {
      throw new Error(`[K6 FATAL] POST ${p} is not the order-create endpoint — refusing request.`);
    }
    return;
  }
  if (m === 'DELETE') {
    if (!ALLOWED_DELETE_PATHS.some((re) => re.test(p))) {
      throw new Error(`[K6 FATAL] DELETE ${p} is not the order-cancel endpoint — refusing request.`);
    }
    return;
  }
  throw new Error(`[K6 FATAL] HTTP method ${method} is never used by Kronos 6 — refusing request.`);
}

// ---------------------------------------------------------------------------
// Live-trading arming (the human safeguard)
// ---------------------------------------------------------------------------
// Values of config key `k6_live_trading_armed`. The scanner runs the full
// pipeline while UNARMED — validation, signals, market discovery, EV — and
// records DRY_RUN decisions where a live order would have been placed, but it
// will not POST an order until the key is exactly ARMED_VALUE.
export const ARMED_VALUE = 'ARMED' as const;
export const UNARMED_VALUE = 'unarmed' as const;

// ---------------------------------------------------------------------------
// Position sizing — FIXED DOLLAR STAKE (Kronos 6 change; not 1% of bankroll)
// ---------------------------------------------------------------------------
// Seeded into config as `k6_stake_dollars` and read from config every tick so
// the operator can change it without code changes (scripts/set-stake.mjs).
// The stake never scales with balance, wins, or losses.
export const DEFAULT_STAKE_DOLLARS = 5.00;
// Hard ceiling: even via config, the stake can never exceed this (typo guard).
export const MAX_STAKE_DOLLARS = 25.00;

// ---------------------------------------------------------------------------
// Market / series (identical to Kronos 5)
// ---------------------------------------------------------------------------
export const SERIES_TICKER = 'KXETH15M' as const;
export const KALSHI_OUTCOME = 'no' as const; // strategy DOWN maps to Kalshi NO (see strategy.ts)

// ---------------------------------------------------------------------------
// Timing (identical to Kronos 5 — 15-minute window, UTC :00/:15/:30/:45)
// ---------------------------------------------------------------------------
export const POLL_MS = 15_000;
export const CANDLE_MS = 15 * 60 * 1000;
export const MAX_TARGET_AGE_MS = 90_000;       // entry only in first 90s of window
export const MIN_TARGET_REMAINING_MS = 780_000;
export const SETTLE_BUFFER_MS = 90_000;
export const KALSHI_RESULT_WAIT_MS = 15 * 60 * 1000;
// Order lifecycle (carried from the Kronos 5 demo-execution phase, which is
// where these were validated against the real V2 order API):
export const ORDER_FILL_TIMEOUT_MS = 45_000;   // cancel unfilled remainder after this
export const ORDER_POLL_MS = 5_000;
// Startup validation: maximum tolerated |local clock − Kalshi server clock|.
export const MAX_CLOCK_SKEW_MS = 10_000;

// ---------------------------------------------------------------------------
// Frozen strategy constants (identical to Kronos 5 / Kronos 4 v1 — DO NOT TUNE)
// ---------------------------------------------------------------------------
export const P_DOWN_RAW = 0.594;
export const P_DOWN_CONSERVATIVE = 0.566;
export const MAX_NO_PRICE = 0.515;
export const MIN_FEE_ADJUSTED_EV = 0.03;
export const RULES = {
  closePosMin: 0.8240,
  ema20Slope3Min: 0.0018,
  ema100DistMin: 0.2474,
} as const;

// ---------------------------------------------------------------------------
// Kalshi fee model (identical to Kronos 5; verified against GET /series/KXETH15M
// fee_type=quadratic fee_multiplier=1 and a real fill on 2026-07-08)
// ---------------------------------------------------------------------------
export const KALSHI_FEE_RATE = 0.07;

export const CANDLE_HISTORY = 240; // closed 15m candles fetched for EMA100 safety
