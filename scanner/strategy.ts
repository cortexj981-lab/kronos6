// Frozen DOWN-exhaustion feature/rule logic, evaluated on 15-minute candles.
// Byte-for-byte the Kronos 5 logic (which is byte-for-byte the Kronos 4 math).
import type { Candle, Features } from './types.js';
import { RULES, STRATEGY_DIRECTION, KALSHI_OUTCOME } from './config.js';
import { emaSeries } from './indicators.js';

export function computeFeatures(candles: Candle[]): Features | null {
  if (candles.length < 104) return null; // EMA100 + 3-candle slope headroom
  const closes = candles.map((c) => c.close);
  const c = candles[candles.length - 1]; // most recent CLOSED candle
  const range = c.high - c.low;
  if (range <= 0) return null;
  const e20 = emaSeries(closes, 20);
  const e100 = emaSeries(closes, 100);
  const now20 = e20[e20.length - 1];
  const prev20 = e20[e20.length - 4]; // 3 candles ago
  const now100 = e100[e100.length - 1];
  if (now20 == null || prev20 == null || now100 == null || prev20 === 0 || now100 === 0) return null;
  return {
    closePos: (c.close - c.low) / range,
    ema20Slope3: ((now20 - prev20) / prev20) * 100,
    ema100Dist: ((c.close - now100) / now100) * 100,
  };
}

export function passesRules(f: Features): boolean {
  return f.closePos >= RULES.closePosMin
    && f.ema20Slope3 >= RULES.ema20Slope3Min
    && f.ema100Dist >= RULES.ema100DistMin;
}

export function ruleReason(f: Features): string {
  return `closePos=${f.closePos.toFixed(4)} ema20Slope3=${f.ema20Slope3.toFixed(4)} ema100Dist=${f.ema100Dist.toFixed(4)}`;
}

/**
 * Explicit strategy-direction → Kalshi-outcome mapping for KXETH15M.
 *
 * KXETH15M markets have strike_type=greater_or_equal with floor_strike set to
 * the start-of-interval reference price (CF Benchmarks ETHUSDRTI 60s average).
 * YES settles when the end-of-interval reference >= floor_strike (i.e. ETH
 * finished UP-or-flat; an exact tie resolves YES/UP). Therefore the strategy
 * direction DOWN corresponds economically to buying NO.
 *
 * Both concepts are preserved separately in the database:
 *   strategy_direction = 'DOWN', kalshi_outcome = 'no'.
 */
export function strategyDirectionToKalshiOutcome(direction: typeof STRATEGY_DIRECTION): typeof KALSHI_OUTCOME {
  if (direction !== 'DOWN') throw new Error(`[K6 FATAL] unsupported strategy direction: ${direction}`);
  return 'no';
}
