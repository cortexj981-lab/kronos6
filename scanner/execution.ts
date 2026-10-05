// LIVE order execution via the Kalshi V2 order API — adapted from the
// Kronos 5 demo-phase module that was validated against real V2 orders.
//
// V2 quotes everything from the YES side of the book. Opening our NO
// position (strategy DOWN) is done with side='ask' (sell YES) at
// yesPrice = 1 - noPrice — economically identical to buying NO at noPrice.
// All NO-denominated numbers are stored in the DB; the YES translation is
// confined to this module.
//
// Lifecycle: local intent recorded BEFORE submission (restart-safe duplicate
// prevention), immediate-fill data taken from the V2 response, otherwise fill
// polling via GET order, cancellation of unfilled remainders after
// ORDER_FILL_TIMEOUT_MS. Never pretends a trade occurred: every quantity here
// comes from a Kalshi response.
import { randomUUID } from 'node:crypto';
import { ORDER_FILL_TIMEOUT_MS, ORDER_POLL_MS } from './config.js';
import { createOrderV2, getOrder, getOrders, cancelOrderV2, KalshiApiError } from './kalshi-client.js';
import { insertOrderIntent, updateOrder, insertFill, isArmed } from './db.js';
import type { KalshiOrder } from './types.js';
import { k6log } from './log.js';

export interface ExecutionResult {
  status: 'filled' | 'partial' | 'unfilled' | 'rejected' | 'error';
  orderRowId: number;
  clientOrderId: string;
  kalshiOrderId: string | null;
  filledQuantity: number;
  /** Average fill price in NO dollars. */
  averageFillPrice: number | null;
  actualFee: number;
  fillCost: number;
  errorMessage?: string;
}

/** NO-side stats from a polled Order object. */
function fillStatsFromOrder(o: KalshiOrder): { filled: number; avgNoPrice: number | null; fee: number; cost: number } {
  const filled = Number(o.fill_count_fp ?? 0);
  const fee = Number(o.taker_fees_dollars ?? 0) + Number(o.maker_fees_dollars ?? 0);
  // The polled Order reports our NO limit price; cost fields are on our side.
  const cost = Number(o.taker_fill_cost_dollars ?? 0) + Number(o.maker_fill_cost_dollars ?? 0);
  const avgNoPrice = filled > 0 && cost > 0 ? cost / filled : (filled > 0 ? Number(o.no_price_dollars) : null);
  return { filled, avgNoPrice, fee, cost };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Open a live NO position of `quantity` contracts at NO limit price
 * `priceDollars` (submitted as a V2 YES-side ask at 1 - priceDollars).
 * Blocks until filled, canceled, or timed out; cancels any unfilled
 * remainder. Refuses to run unless live trading is ARMED.
 */
export async function executeNoBuy(opts: {
  marketTicker: string;
  targetWindowStart: number;
  priceDollars: number;   // NO-side limit price
  quantity: number;       // integer contracts
  estimatedFee: number;
  purpose?: 'strategy' | 'connectivity_test';
  /** Shard of the market being traded; see CreateOrderV2Body.exchange_index. */
  exchangeIndex?: number;
}): Promise<ExecutionResult> {
  // Belt-and-braces: the main loop already checks, but no code path may reach
  // a live order without the human arming step.
  if (!isArmed()) throw new Error('[K6 FATAL] executeNoBuy called while live trading is not ARMED — refusing.');
  if (!Number.isInteger(opts.quantity) || opts.quantity <= 0) {
    throw new Error(`[K6 FATAL] invalid order quantity ${opts.quantity} — refusing.`);
  }

  const localOrderUuid = randomUUID();
  const clientOrderId = `k6-${opts.targetWindowStart}-${localOrderUuid.slice(0, 8)}`;
  const yesPrice = Number((1 - opts.priceDollars).toFixed(4));
  const orderRowId = insertOrderIntent({
    localOrderUuid,
    clientOrderId,
    marketTicker: opts.marketTicker,
    targetWindowStart: opts.targetWindowStart,
    requestedPrice: opts.priceDollars,
    requestedYesPrice: yesPrice,
    requestedQuantity: opts.quantity,
    estimatedFee: opts.estimatedFee,
    purpose: opts.purpose ?? 'strategy',
  });

  let orderId: string;
  let immediateFilled = 0;
  let immediateAvgNo: number | null = null;
  let immediateFee = 0;
  try {
    const res = await createOrderV2({
      ticker: opts.marketTicker,
      client_order_id: clientOrderId,
      side: 'ask',                       // sell YES == open NO position
      count: opts.quantity.toFixed(2),
      price: yesPrice.toFixed(4),        // YES-side price
      time_in_force: 'good_till_canceled',
      self_trade_prevention_type: 'taker_at_cross',
      cancel_order_on_pause: true,
      ...(opts.exchangeIndex != null ? { exchange_index: opts.exchangeIndex } : {}),
    });
    orderId = res.order_id;
    immediateFilled = Number(res.fill_count ?? 0);
    if (immediateFilled > 0) {
      // average_fill_price is YES-side VWAP; our NO price = 1 - yes VWAP.
      immediateAvgNo = res.average_fill_price != null ? Number((1 - Number(res.average_fill_price)).toFixed(6)) : opts.priceDollars;
      immediateFee = res.average_fee_paid != null ? Number(res.average_fee_paid) * immediateFilled : 0;
      insertFill({
        orderRowId, kalshiOrderId: orderId, kalshiTradeId: null,
        marketTicker: opts.marketTicker, count: immediateFilled,
        noPrice: immediateAvgNo, yesPrice: immediateAvgNo != null ? Number((1 - immediateAvgNo).toFixed(6)) : null,
        fee: immediateFee, isTaker: 1, source: 'v2_response',
      });
    }
  } catch (e) {
    const err = e as KalshiApiError;
    updateOrder(clientOrderId, {
      status: 'submit_failed',
      closed_at: Date.now(),
      raw_error_code: err.code ?? null,
      raw_error_message: (err.message ?? String(e)).slice(0, 400),
    });
    k6log(`[K6 ERROR] order submit failed: ${err.message ?? e}`);
    return { status: 'error', orderRowId, clientOrderId, kalshiOrderId: null, filledQuantity: 0, averageFillPrice: null, actualFee: 0, fillCost: 0, errorMessage: String(err.message ?? e) };
  }

  updateOrder(clientOrderId, { kalshi_order_id: orderId, status: immediateFilled >= opts.quantity ? 'executed' : 'resting' });
  k6log(`[K6 ORDER] LIVE NO market=${opts.marketTicker} qty=${opts.quantity} limit(no)=${opts.priceDollars.toFixed(4)} [v2 ask yes@${yesPrice.toFixed(4)}] kalshi_id=${orderId} immediate_fill=${immediateFilled}`);

  // Fast path: fully filled on placement.
  if (immediateFilled >= opts.quantity) {
    updateOrder(clientOrderId, {
      filled_quantity: immediateFilled, average_fill_price: immediateAvgNo,
      actual_fee: immediateFee, fill_cost: immediateAvgNo != null ? Number((immediateAvgNo * immediateFilled).toFixed(6)) : null,
      status: 'executed', closed_at: Date.now(),
    });
    k6log(`[K6 FILL] full fill qty=${immediateFilled} avg(no)=${immediateAvgNo?.toFixed(4)} fee=$${immediateFee.toFixed(4)}`);
    return { status: 'filled', orderRowId, clientOrderId, kalshiOrderId: orderId, filledQuantity: immediateFilled, averageFillPrice: immediateAvgNo, actualFee: immediateFee, fillCost: (immediateAvgNo ?? opts.priceDollars) * immediateFilled };
  }

  // Poll for fills until executed/canceled or timeout.
  const deadline = Date.now() + ORDER_FILL_TIMEOUT_MS;
  let current: KalshiOrder | null = null;
  for (;;) {
    await sleep(ORDER_POLL_MS);
    try {
      current = (await getOrder(orderId)).order;
      if (current.status !== 'resting') break;
    } catch (e) {
      k6log(`[K6 ERROR] order poll failed (will retry): ${(e as Error).message}`);
    }
    if (Date.now() >= deadline) break;
  }

  let canceledByUs = false;
  if (!current || current.status === 'resting') {
    // Timeout — cancel the remainder. Partial fills remain a position.
    try {
      const c = await cancelOrderV2(orderId);
      canceledByUs = true;
      k6log(`[K6 CANCEL] unfilled remainder canceled kalshi_id=${orderId} reduced_by=${c.reduced_by}`);
    } catch (e) {
      k6log(`[K6 ERROR] cancel failed: ${(e as Error).message}`);
    }
    try { current = (await getOrder(orderId)).order; } catch { /* keep last known */ }
  }

  const f = current ? fillStatsFromOrder(current) : { filled: immediateFilled, avgNoPrice: immediateAvgNo, fee: immediateFee, cost: 0 };
  if (current && f.filled > immediateFilled) {
    insertFill({
      orderRowId, kalshiOrderId: orderId, kalshiTradeId: null,
      marketTicker: opts.marketTicker, count: f.filled - immediateFilled,
      noPrice: f.avgNoPrice, yesPrice: f.avgNoPrice != null ? Number((1 - f.avgNoPrice).toFixed(6)) : null,
      fee: Number((f.fee - immediateFee).toFixed(6)), isTaker: null, source: 'order_poll',
    });
  }
  // A just-canceled order can still read 'resting' for a moment — record the
  // truth we know rather than the stale snapshot.
  const rawStatus = current?.status === 'resting' && canceledByUs ? 'canceled' : (current?.status ?? 'canceled');
  const finalStatus = rawStatus === 'canceled' && f.filled > 0 ? 'partial' : rawStatus;
  updateOrder(clientOrderId, {
    status: finalStatus,
    filled_quantity: f.filled,
    average_fill_price: f.avgNoPrice,
    actual_fee: f.fee,
    fill_cost: f.cost > 0 ? f.cost : (f.avgNoPrice != null ? Number((f.avgNoPrice * f.filled).toFixed(6)) : null),
    canceled_by_us: canceledByUs ? 1 : 0,
    closed_at: Date.now(),
  });

  if (f.filled >= opts.quantity) {
    k6log(`[K6 FILL] full fill qty=${f.filled} avg(no)=${f.avgNoPrice?.toFixed(4)} fee=$${f.fee.toFixed(4)}`);
    return { status: 'filled', orderRowId, clientOrderId, kalshiOrderId: orderId, filledQuantity: f.filled, averageFillPrice: f.avgNoPrice, actualFee: f.fee, fillCost: f.cost };
  }
  if (f.filled > 0) {
    k6log(`[K6 PARTIAL] partial fill qty=${f.filled}/${opts.quantity} avg(no)=${f.avgNoPrice?.toFixed(4)} fee=$${f.fee.toFixed(4)}`);
    return { status: 'partial', orderRowId, clientOrderId, kalshiOrderId: orderId, filledQuantity: f.filled, averageFillPrice: f.avgNoPrice, actualFee: f.fee, fillCost: f.cost };
  }
  k6log(`[K6 CANCEL] order ended unfilled status=${current?.status ?? 'unknown'}`);
  return { status: 'unfilled', orderRowId, clientOrderId, kalshiOrderId: orderId, filledQuantity: 0, averageFillPrice: null, actualFee: 0, fillCost: 0 };
}

/**
 * Startup recovery: adopt orders left non-terminal by a crash. Fail closed —
 * anything still resting on the exchange is canceled; fills discovered here
 * are recorded so the ledger never loses a real position. Returns the number
 * of orders needing operator attention (fills without a trade row).
 */
export async function recoverOrphanOrders(db: import('node:sqlite').DatabaseSync): Promise<number> {
  const orphans = db.prepare(`SELECT id, client_order_id, kalshi_order_id, market_ticker, requested_quantity
    FROM orders WHERE status IN ('pending_submit', 'resting')`).all() as Array<{ id: number; client_order_id: string; kalshi_order_id: string | null; market_ticker: string; requested_quantity: number }>;
  let needsAttention = 0;
  for (const o of orphans) {
    k6log(`[K6 RECOVER] found non-terminal order ${o.client_order_id} (status pre-crash) — reconciling with exchange`);
    let kalshiId = o.kalshi_order_id;
    try {
      if (!kalshiId) {
        // Submitted-but-unrecorded case: search recent orders by client_order_id.
        const res = await getOrders({ limit: 100 });
        const match = (res.orders ?? []).find((x) => x.client_order_id === o.client_order_id);
        if (!match) {
          updateOrder(o.client_order_id, { status: 'submit_failed', closed_at: Date.now(), raw_error_message: 'recovery: no matching order on exchange' });
          k6log(`[K6 RECOVER] ${o.client_order_id}: not found on exchange — marked submit_failed`);
          continue;
        }
        kalshiId = match.order_id;
        updateOrder(o.client_order_id, { kalshi_order_id: kalshiId });
      }
      let order = (await getOrder(kalshiId)).order;
      if (order.status === 'resting') {
        try {
          await cancelOrderV2(kalshiId);
          k6log(`[K6 RECOVER] canceled resting orphan ${o.client_order_id}`);
        } catch (e) {
          k6log(`[K6 ERROR] recovery cancel failed for ${o.client_order_id}: ${(e as Error).message}`);
        }
        try { order = (await getOrder(kalshiId)).order; } catch { /* keep last known */ }
      }
      const f = fillStatsFromOrder(order);
      const finalStatus = order.status === 'resting' ? 'canceled' : (f.filled > 0 && f.filled < o.requested_quantity ? 'partial' : order.status);
      updateOrder(o.client_order_id, {
        status: finalStatus, filled_quantity: f.filled, average_fill_price: f.avgNoPrice,
        actual_fee: f.fee, fill_cost: f.cost, closed_at: Date.now(),
      });
      if (f.filled > 0) {
        insertFill({
          orderRowId: o.id, kalshiOrderId: kalshiId, kalshiTradeId: null,
          marketTicker: o.market_ticker, count: f.filled, noPrice: f.avgNoPrice,
          yesPrice: f.avgNoPrice != null ? Number((1 - f.avgNoPrice).toFixed(6)) : null,
          fee: f.fee, isTaker: null, source: 'order_poll',
        });
        const hasTrade = db.prepare('SELECT id FROM trades WHERE order_row_id = ?').get(o.id);
        if (!hasTrade) {
          needsAttention++;
          k6log(`[K6 RECOVER] !! order ${o.client_order_id} has ${f.filled} filled contracts but no trade row — operator attention required (position exists on exchange)`);
        }
      }
    } catch (e) {
      needsAttention++;
      k6log(`[K6 ERROR] recovery failed for ${o.client_order_id}: ${(e as Error).message}`);
    }
  }
  return needsAttention;
}
