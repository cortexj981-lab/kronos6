// LIVE settlement resolution.
//  - Authoritative: the real Kalshi market result (GET /markets/{t}) plus the
//    account's own settlement records (GET /portfolio/settlements), which are
//    stored verbatim for reconciliation.
//  - Money math comes from OUR recorded fills: a NO contract pays $1.00 when
//    the market settles 'no', $0 otherwise. settlement_revenue is
//    contracts * $1 on a win, 0 on a loss; net P/L subtracts actual entry
//    fees (no settlement fee on this series).
//  - There is NO Coinbase money fallback in live trading — real money settles
//    only on Kalshi's result. The Coinbase candle direction is recorded purely
//    as research metadata. If Kalshi is slow, the trade stays open and we
//    retry (never guess).
import { SETTLE_BUFFER_MS } from './config.js';
import { getMarket, getSettlements } from './kalshi-client.js';
import { fetchCandles } from './candles.js';
import { getOpenTrades, settleTrade, upsertSettlement, recordEquity } from './db.js';
import { k6log } from './log.js';

const SETTLED_STATUSES = new Set(['determined', 'finalized', 'settled']);

async function coinbaseDirection(targetWindowStart: number): Promise<'UP' | 'DOWN' | null> {
  try {
    const candles = await fetchCandles('ETHUSD', 240);
    const c = candles.find((x) => x.ts === targetWindowStart);
    if (!c) return null;
    return c.close >= c.open ? 'UP' : 'DOWN'; // tie = UP, like Kalshi
  } catch {
    return null;
  }
}

/** Pull recent account settlements into the local ledger (best-effort). */
async function syncSettlements(): Promise<void> {
  try {
    const res = await getSettlements({ limit: 50 });
    for (const s of res.settlements ?? []) {
      upsertSettlement({
        marketTicker: s.ticker,
        marketResult: s.market_result ?? null,
        revenue: s.revenue_dollars != null ? Number(s.revenue_dollars) : (s.revenue != null ? s.revenue / 100 : null),
        feeCost: s.fee_cost != null ? Number(s.fee_cost) : null,
        noCount: s.no_count_fp != null ? Number(s.no_count_fp) : null,
        noTotalCost: s.no_total_cost_dollars != null ? Number(s.no_total_cost_dollars) : null,
        settledTime: s.settled_time ?? null,
      });
    }
  } catch (e) {
    k6log(`[K6 ERROR] settlements sync failed (non-fatal): ${(e as Error).message}`);
  }
}

export async function resolveTrades(): Promise<void> {
  const open = getOpenTrades();
  if (open.length === 0) return;
  const now = Date.now();
  let settledAny = false;

  for (const t of open) {
    const windowStart = Number(t.target_window_start);
    const windowEnd = Number(t.target_window_end);
    if (windowEnd + SETTLE_BUFFER_MS > now) continue; // not due yet

    const ticker = String(t.market_ticker);
    let kalshiResult: 'yes' | 'no' | null = null;
    try {
      const { market } = await getMarket(ticker);
      if (SETTLED_STATUSES.has(market.status) && (market.result === 'yes' || market.result === 'no')) {
        kalshiResult = market.result;
      }
    } catch (e) {
      k6log(`[K6 ERROR] resolver getMarket(${ticker}) failed: ${(e as Error).message}`);
    }

    if (kalshiResult === null) {
      k6log(`[K6 RESOLVE] ${ticker} not settled on Kalshi yet — leaving open, will retry (live money settles only on the official result)`);
      continue;
    }

    const won = kalshiResult === 'no'; // strategy DOWN ⇔ Kalshi NO
    const contracts = Number(t.contracts);
    const positionCost = Number(t.position_cost);
    const fee = Number(t.fee_amount ?? 0);
    const settlementRevenue = won ? Number((contracts * 1.0).toFixed(6)) : 0;
    const grossPnl = Number((settlementRevenue - positionCost).toFixed(6));
    const netPnl = Number((grossPnl - fee).toFixed(6));
    const comparison = await coinbaseDirection(windowStart); // research metadata only

    // balance_after is THIS TRADE's closing balance, so it is computed from the
    // ledger — balance_before + netPnl — and never from a live account read.
    //
    // A live read was the old behaviour and it was wrong in both directions:
    //   • WIN  — Kalshi can credit settlement revenue >75s after the market settles,
    //            so the read came in low (the phantom -$20.02 drift, trade #74,
    //            2026-07-30). A `creditPending` guard was added for this case.
    //   • LOSS — the guard did NOT cover losses, and by the time the resolver runs
    //            the scanner has often already placed the NEXT trade, whose cost and
    //            fee are debited from the live account. The read therefore came in
    //            low by that next trade's cost, and the row showed a closing balance
    //            that belonged to no point in time. 18 of 233 settled trades were
    //            wrong this way, by up to $9.84, and two consecutive rows could show
    //            an identical balance despite both being losses (spotted 2026-09-11).
    //
    // The ledger value is exact and knowable the moment the result is known; the live
    // balance reflects whatever else has happened on the account since, which is the
    // reconciler's job to check, not this column's. `runAudit` still compares the live
    // balance against startBalance + sum(net_pnl) independently, so dropping the read
    // here loses no safety.
    const balanceAfter: number | null = t.balance_before != null
      ? Number((Number(t.balance_before) + netPnl).toFixed(4))
      : null;
    if (balanceAfter != null) recordEquity(balanceAfter, 'post_settlement');

    settleTrade(Number(t.id), {
      kalshiResult,
      coinbaseComparison: comparison,
      correct: won ? 1 : 0,
      settlementRevenue,
      grossPnl,
      netPnl,
      balanceAfter,
      settlementSource: 'kalshi_live',
    });
    settledAny = true;
    k6log(`[K6 RESOLVE] ${won ? 'WIN ' : 'LOSS'} market=${ticker} result=${kalshiResult} revenue=$${settlementRevenue.toFixed(2)} net=$${netPnl.toFixed(4)} balance=${balanceAfter != null ? `$${balanceAfter.toFixed(2)}` : 'n/a'}`);
  }

  if (settledAny) await syncSettlements();
}
