// Kalshi LIVE REST client for Kronos 6.
// Every request — reads AND writes — passes assertAllowedRequest() before it
// is built: approved host only, GET allowlist, POST/DELETE restricted to the
// single order-create / order-cancel endpoint. There are deliberately NO
// functions for transfers, deposits, withdrawals, or account management.
//
// Order endpoints use the V2 API (validated during the Kronos 5 demo phase;
// the V1 POST /portfolio/orders returns 410 deprecated_v1_order_endpoint).
import { KALSHI_REST_URL, KALSHI_EXCHANGE_INDEX, assertAllowedRequest } from './config.js';
import { signRequest } from './kalshi-auth.js';

const API_PREFIX = new URL(KALSHI_REST_URL).pathname; // /trade-api/v2

export class KalshiApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    public body: string,
    message: string,
  ) {
    super(message);
  }
}

let lastApiSuccessTs = 0;
export function getLastApiSuccessTs(): number { return lastApiSuccessTs; }

// Server clock skew estimate (ms; local - server) from response Date headers.
// A single header can be stale or second-rounded, so the estimate is the
// median of the last few responses rather than the most recent one.
const recentSkews: number[] = [];
export function getLastClockSkewMs(): number | null {
  if (recentSkews.length === 0) return null;
  const sorted = [...recentSkews].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

async function request<T>(method: 'GET' | 'POST' | 'DELETE', apiPath: string, opts: { query?: Record<string, string | number | undefined>; body?: unknown; auth?: boolean } = {}): Promise<T> {
  const url = new URL(KALSHI_REST_URL + apiPath);
  if (opts.query) {
    for (const [k, v] of Object.entries(opts.query)) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
  }
  assertAllowedRequest(method, url.toString()); // fail-closed gate on EVERY request
  const headers: Record<string, string> = {
    'Accept': 'application/json',
    'User-Agent': 'kronos6-scanner/1.0 (live)',
  };
  if (opts.auth !== false) {
    Object.assign(headers, signRequest(method, API_PREFIX + apiPath));
  }
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(url, {
    method,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  const dateHeader = res.headers.get('date');
  if (dateHeader) {
    const serverMs = Date.parse(dateHeader);
    if (Number.isFinite(serverMs)) {
      recentSkews.push(Date.now() - serverMs);
      if (recentSkews.length > 5) recentSkews.shift();
    }
  }
  const text = await res.text();
  if (!res.ok) {
    let code = '';
    try { code = JSON.parse(text)?.error?.code ?? ''; } catch { /* not json */ }
    throw new KalshiApiError(res.status, code, text.slice(0, 500), `[K6 ERROR] Kalshi ${method} ${apiPath} -> HTTP ${res.status} ${code}`);
  }
  lastApiSuccessTs = Date.now();
  return text ? JSON.parse(text) as T : (undefined as T);
}

// ---- portfolio reads ----
/**
 * Usable collateral for the markets Kronos 6 trades.
 *
 * Kalshi splits an account's collateral across exchange shards (0 Default,
 * 1 Combos, 2 Crypto, 3 Tennis & Baseball). `balance_dollars` is the ACCOUNT-WIDE
 * total, but an ETH order can only draw on the Crypto shard. Reconciling against
 * the total made money stranded in another shard look like ledger drift and
 * halted the bot on 2026-09-04 ($0.93 sitting in Exchange 0).
 *
 * The shard breakdown already arrives in this allowlisted response, so no extra
 * endpoint or query parameter is needed. Falls back to the account total if the
 * breakdown is ever absent, so an API shape change degrades rather than crashes.
 */
export async function getBalance(): Promise<{
  balanceCents: number; balanceDollars: number;
  totalDollars: number; breakdown: Array<{ exchange_index: number; balance: string }>;
}> {
  const r = await request<{
    balance: number; balance_dollars: string;
    balance_breakdown?: Array<{ balance: string; exchange_index: number }>;
  }>('GET', '/portfolio/balance');

  const total = Number(r.balance_dollars ?? r.balance / 100);
  const breakdown = r.balance_breakdown ?? [];
  const shard = breakdown.find((b) => b.exchange_index === KALSHI_EXCHANGE_INDEX);
  const dollars = shard ? Number(shard.balance) : total;

  if (!shard && breakdown.length) {
    console.warn(`[K6 BALANCE] exchange_index ${KALSHI_EXCHANGE_INDEX} missing from breakdown; falling back to account total $${total.toFixed(4)}`);
  }
  return {
    balanceCents: Math.round(dollars * 100),
    balanceDollars: dollars,
    totalDollars: total,
    breakdown,
  };
}

/** Human-readable shard breakdown, for audit logs. */
export function formatBalanceBreakdown(breakdown: Array<{ exchange_index: number; balance: string }>): string {
  if (!breakdown.length) return '(no breakdown returned)';
  return breakdown.map((b) => `ex${b.exchange_index}=$${Number(b.balance).toFixed(4)}`).join(' ');
}

export async function getOrder(orderId: string): Promise<{ order: import('./types.js').KalshiOrder }> {
  return request('GET', `/portfolio/orders/${orderId}`);
}

export async function getOrders(query: Record<string, string | number | undefined> = {}): Promise<{ orders: import('./types.js').KalshiOrder[]; cursor: string }> {
  return request('GET', '/portfolio/orders', { query });
}

export async function getPositions(query: Record<string, string | number | undefined> = {}): Promise<{ market_positions?: Array<{ ticker: string; position?: number; position_fp?: string; total_traded?: number; market_exposure?: number }>; event_positions?: unknown[]; cursor?: string }> {
  return request('GET', '/portfolio/positions', { query });
}

export async function getSettlements(query: Record<string, string | number | undefined> = {}): Promise<{ settlements: Array<{ ticker: string; market_result: string; revenue?: number; revenue_dollars?: string; fee_cost?: string; settled_time: string; no_count_fp?: string; no_total_cost_dollars?: string; yes_count_fp?: string; yes_total_cost_dollars?: string }>; cursor?: string }> {
  return request('GET', '/portfolio/settlements', { query });
}

export async function getFills(query: Record<string, string | number | undefined> = {}): Promise<{ fills: import('./types.js').KalshiFill[]; cursor?: string }> {
  return request('GET', '/portfolio/fills', { query });
}

// ---- orders (V2 — the ONLY mutating calls in Kronos 6) ----
export interface CreateOrderV2Body {
  ticker: string;
  client_order_id: string;
  side: 'bid' | 'ask';
  count: string;             // FixedPointCount, e.g. "10.00"
  price: string;             // YES-side FixedPointDollars, e.g. "0.5900"
  time_in_force: 'fill_or_kill' | 'good_till_canceled' | 'immediate_or_cancel';
  self_trade_prevention_type: 'taker_at_cross' | 'maker';
  post_only?: boolean;
  cancel_order_on_pause?: boolean;
  /**
   * Exchange shard to route the order to. Kalshi's docs say this auto-routes
   * from the ticker when omitted, but in practice omitting it returns
   * 404 market_not_found for any market off shard 0 (KXETH15M moved to shard 2
   * on 2026-08-25 and every order failed until this was sent explicitly).
   * Always pass the shard from the discovered market object.
   */
  exchange_index?: number;
}

export interface CreateOrderV2Response {
  order_id: string;
  client_order_id?: string;
  fill_count: string;
  remaining_count: string;
  average_fill_price?: string; // YES-side VWAP, present when fill_count > 0
  average_fee_paid?: string;   // per-contract fee, present when fill_count > 0
  ts_ms: number;
}

export async function createOrderV2(body: CreateOrderV2Body): Promise<CreateOrderV2Response> {
  return request('POST', '/portfolio/events/orders', { body });
}

export async function cancelOrderV2(orderId: string): Promise<{ order_id: string; client_order_id?: string; reduced_by: string; ts_ms: number }> {
  return request('DELETE', `/portfolio/events/orders/${orderId}`);
}

// ---- market data ----
export async function getMarkets(query: Record<string, string | number | undefined>): Promise<{ markets: import('./types.js').KalshiMarket[]; cursor: string }> {
  return request('GET', '/markets', { query });
}

export async function getMarket(ticker: string): Promise<{ market: import('./types.js').KalshiMarket }> {
  return request('GET', `/markets/${ticker}`);
}

export async function getOrderbook(ticker: string, depth = 8): Promise<{ orderbook_fp: { yes_dollars: [string, string][]; no_dollars: [string, string][] } }> {
  return request('GET', `/markets/${ticker}/orderbook`, { query: { depth } });
}

export async function getSeries(seriesTicker: string): Promise<{ series: { ticker: string; fee_type?: string; fee_multiplier?: number; settlement_sources?: unknown[] } }> {
  return request('GET', `/series/${seriesTicker}`);
}

export async function getExchangeStatus(): Promise<{ trading_active: boolean; exchange_active: boolean }> {
  return request('GET', '/exchange/status', { auth: false });
}
