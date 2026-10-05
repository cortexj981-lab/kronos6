// Contract sizing for the FIXED dollar stake (Kronos 6 change vs Kronos 5's
// 1%-of-bankroll). Converts the configured stake into a valid integer
// contract count, fees included, never exceeding either the stake or the
// available live balance. contracts = 0 means the trade must be rejected.
import { takerFee } from './fees.js';

export interface Sizing {
  balanceDollars: number;
  stakeDollars: number;
  contracts: number;      // 0 => trade must be rejected
  positionCost: number;
  estimatedFee: number;
  totalCost: number;
}

export function sizeOrder(stakeDollars: number, balanceDollars: number, price: number): Sizing {
  let contracts = Math.floor(stakeDollars / price);
  // Walk down until position cost + estimated taker fee fits inside both the
  // fixed stake and the available balance.
  while (contracts > 0) {
    const positionCost = contracts * price;
    const fee = takerFee(contracts, price);
    if (positionCost + fee <= stakeDollars && positionCost + fee <= balanceDollars) break;
    contracts--;
  }
  const positionCost = contracts * price;
  const estimatedFee = takerFee(contracts, price);
  return {
    balanceDollars,
    stakeDollars,
    contracts,
    positionCost,
    estimatedFee,
    totalCost: positionCost + estimatedFee,
  };
}
