// KXETH15M market discovery + live quote reading — identical to Kronos 5.
// Never guesses ticker timestamp conventions — markets are discovered via the
// API and matched to the target window by their open_time/close_time.
import { SERIES_TICKER, CANDLE_MS } from './config.js';
import { getMarkets, getOrderbook } from './kalshi-client.js';
import type { KalshiMarket, NoQuote } from './types.js';
import { k6log } from './log.js';

/**
 * Find the KXETH15M market whose window is exactly
 * [targetWindowStart, targetWindowStart + 15min). Pins the exact market via
 * close_ts filters; rejects stale/closed/paused/mismatched windows.
 */
export async function discoverTargetMarket(targetWindowStart: number): Promise<{ market: KalshiMarket; rejected: string[] } | { market: null; rejected: string[] }> {
  const targetEnd = targetWindowStart + CANDLE_MS;
  const rejected: string[] = [];
  const res = await getMarkets({
    series_ticker: SERIES_TICKER,
    min_close_ts: Math.floor(targetEnd / 1000),
    max_close_ts: Math.floor(targetEnd / 1000),
    limit: 100,
  });
  for (const m of res.markets) {
    const openMs = Date.parse(m.open_time);
    const closeMs = Date.parse(m.close_time);
    if (closeMs !== targetEnd) { rejected.push(`${m.ticker}: close_time ${m.close_time} != target end`); continue; }
    if (openMs > targetWindowStart) { rejected.push(`${m.ticker}: opens after window start`); continue; }
    if (m.status !== 'active') { rejected.push(`${m.ticker}: status=${m.status} (not active yet)`); continue; }
    return { market: m, rejected };
  }
  if (res.markets.length === 0) rejected.push(`no ${SERIES_TICKER} market with close_ts=${new Date(targetEnd).toISOString()}`);
  return { market: null, rejected };
}

const parsePrice = (v: string | null | undefined): number | null => {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 && n < 1 ? n : null;
};

/**
 * Read a live NO quote — identical selection logic to Kronos 5.
 *
 * Preferred source is the order book: Kalshi books return bids only, so the
 * executable NO ask = 1 − best YES bid, sized by that level. If the book is
 * empty/unusable we fall back to the market object's no_ask quote and record
 * a liquidity warning. Returns null only when no usable price exists at all.
 * (In Kronos 6 the price becomes a LIMIT price, so an aggressive-but-capped
 * order is safe even against a thin book — the limit order simply rests and
 * the unfilled remainder is canceled after ORDER_FILL_TIMEOUT_MS.)
 */
export async function readLiveNoQuote(m: KalshiMarket): Promise<NoQuote | null> {
  let bookNoAsk: number | null = null;
  let size: number | null = null;
  let warning: string | null = null;
  try {
    const ob = await getOrderbook(m.ticker, 8);
    const yesLevels = (ob.orderbook_fp?.yes_dollars ?? [])
      .map(([p, c]) => ({ price: Number(p), count: Number(c) }))
      .filter((l) => Number.isFinite(l.price) && l.price > 0 && l.price < 1 && l.count > 0)
      .sort((a, b) => b.price - a.price);
    if (yesLevels.length > 0) {
      bookNoAsk = Number((1 - yesLevels[0].price).toFixed(4));
      size = yesLevels[0].count;
    } else {
      warning = 'order book empty (no YES bids)';
    }
  } catch (e) {
    warning = `orderbook read failed: ${(e as Error).message}`;
  }

  const marketNoAsk = parsePrice(m.no_ask_dollars);
  let execPrice: number | null = bookNoAsk;
  let priceSource: 'orderbook' | 'market_quote' = 'orderbook';
  if (execPrice == null) {
    execPrice = marketNoAsk;
    priceSource = 'market_quote';
    if (execPrice != null && warning) warning += '; using market-object no_ask quote';
  } else if (marketNoAsk != null && Math.abs(marketNoAsk - execPrice) > 0.011) {
    k6log(`[K6 MARKET] WARN book-derived NO ask ${execPrice} differs from market no_ask ${marketNoAsk} (${m.ticker})`);
  }
  if (execPrice == null) return null; // no usable price data at all

  return {
    execPrice,
    priceSource,
    bookNoAsk,
    size,
    yesBid: parsePrice(m.yes_bid_dollars),
    yesAsk: parsePrice(m.yes_ask_dollars),
    noBid: parsePrice(m.no_bid_dollars),
    noAsk: marketNoAsk,
    warning,
    ts: Date.now(),
  };
}

export function describeMarket(m: KalshiMarket): string {
  return `series=${SERIES_TICKER} event=${m.event_ticker} market=${m.ticker} status=${m.status} `
    + `open=${m.open_time} close=${m.close_time} `
    + `yesBid=${m.yes_bid_dollars} yesAsk=${m.yes_ask_dollars} noBid=${m.no_bid_dollars} noAsk=${m.no_ask_dollars}`;
}
