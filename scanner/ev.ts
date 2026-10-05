// Expected-value math for Kalshi NO contracts — identical to Kronos 5.
// A NO contract bought at price P costs P + fee(P) per contract and pays
// $1.00 if the market settles NO. With win probability p:
//   EV per dollar spent = p / (P + feePerContract(P)) - 1
import { feePerContract, takerFee } from './fees.js';

export function feeAdjustedEv(p: number, price: number): number {
  if (price <= 0 || price >= 1) return -1;
  const cost = price + feePerContract(price);
  return p / cost - 1;
}

export interface TradeEconomics {
  contracts: number;
  price: number;
  positionCost: number;   // contracts * price
  estimatedFee: number;   // taker, ceil-to-centicent
  totalCost: number;
  expectedGross: number;
  expectedNet: number;
  feeAdjustedEv: number;  // per dollar spent
}

export function tradeEconomics(p: number, price: number, contracts: number): TradeEconomics {
  const positionCost = contracts * price;
  const estimatedFee = takerFee(contracts, price);
  const winPnl = contracts * (1 - price);
  const losePnl = -positionCost;
  const expectedGross = p * winPnl + (1 - p) * losePnl;
  return {
    contracts,
    price,
    positionCost,
    estimatedFee,
    totalCost: positionCost + estimatedFee,
    expectedGross,
    expectedNet: expectedGross - estimatedFee,
    feeAdjustedEv: feeAdjustedEv(p, price),
  };
}
