// Coinbase Exchange public API — native 15-minute candles (granularity=900).
// Identical to Kronos 5. Candles are UTC-aligned to :00/:15/:30/:45 by
// construction; the in-progress candle is explicitly dropped so the last
// element is always the most recently CLOSED 15-minute candle.
import type { Candle } from './types.js';
import { CANDLE_MS } from './config.js';

const COINBASE = 'https://api.exchange.coinbase.com/products';
const SYMBOL_MAP: Record<string, string> = { ETHUSD: 'ETH-USD', ETHUSDT: 'ETH-USD', BTCUSD: 'BTC-USD' };
const GRANULARITY_S = CANDLE_MS / 1000; // 900

export async function fetchCandles(symbol = 'ETHUSD', limit = 240): Promise<Candle[]> {
  const product = SYMBOL_MAP[symbol] ?? symbol;
  const actualLimit = Math.min(300, Math.max(120, limit)); // Coinbase caps 300/request
  const nowS = Math.floor(Date.now() / 1000);
  const startS = nowS - GRANULARITY_S * actualLimit;
  const url = `${COINBASE}/${product}/candles?granularity=${GRANULARITY_S}&start=${startS}&end=${nowS}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'kronos6-scanner/1.0' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`[K6 ERROR] Coinbase candles HTTP ${res.status}`);
  const rows = (await res.json()) as [number, number, number, number, number, number][];
  // Coinbase rows: [time, low, high, open, close, volume], newest first.
  const candles: Candle[] = rows
    .map((r) => ({ ts: r[0] * 1000, low: r[1], high: r[2], open: r[3], close: r[4], volume: r[5] }))
    .reverse();
  const currentStart = Math.floor(Date.now() / CANDLE_MS) * CANDLE_MS;
  return candles.filter((c) => c.ts < currentStart); // drop in-progress candle
}
