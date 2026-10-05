// Kalshi-specific fee model — identical to Kronos 5, verified against
// GET /series/KXETH15M (fee_type=quadratic, fee_multiplier=1) and the Kalshi
// fee schedule (effective 2026-06-29), confirmed to the cent against a real
// fill.
//
// Taker fee per order: fees = roundup(0.07 * C * P * (1 - P))
// where C = contracts, P = execution price in dollars, rounded UP to the
// next centicent ($0.0001). Maker fills on this series pay no fee; we
// budget conservatively assuming taker fills. No settlement fee.
import { KALSHI_FEE_RATE } from './config.js';

/** Round a dollar amount UP to the next centicent ($0.0001). */
export function ceilToCenticent(x: number): number {
  return Math.ceil(x * 10_000 - 1e-9) / 10_000;
}

/** Taker fee in dollars for an order of `contracts` at price `price`. */
export function takerFee(contracts: number, price: number): number {
  if (contracts <= 0 || price <= 0 || price >= 1) return 0;
  return ceilToCenticent(KALSHI_FEE_RATE * contracts * price * (1 - price));
}

/** Continuous per-contract fee (no rounding) — used for EV math. */
export function feePerContract(price: number): number {
  if (price <= 0 || price >= 1) return 0;
  return KALSHI_FEE_RATE * price * (1 - price);
}
