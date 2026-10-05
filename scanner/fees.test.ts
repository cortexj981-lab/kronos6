// Deterministic test cases for the Kalshi fee / EV / sizing / live-P&L math.
// Fee and EV cases are carried verbatim from the Kronos 5 test suite; the
// settlement cases are restated for live contract economics, and sizing
// cases cover the Kronos 6 fixed-$5 stake.
// Run: npm run test-fees   (exits non-zero on failure)
import { takerFee, feePerContract, ceilToCenticent } from './fees.js';
import { feeAdjustedEv, tradeEconomics } from './ev.js';
import { sizeOrder } from './sizing.js';

let failures = 0;
function eq(name: string, got: number, want: number, tol = 1e-9): void {
  if (Math.abs(got - want) > tol) {
    console.error(`FAIL ${name}: got ${got}, want ${want}`);
    failures++;
  } else {
    console.log(`ok   ${name} = ${got}`);
  }
}

// --- fee formula: 0.07 * C * P * (1-P), ceil to centicent -----------------
eq('takerFee(1, 0.50)', takerFee(1, 0.50), 0.0175);
eq('takerFee(1, 0.515)', takerFee(1, 0.515), 0.0175);
eq('takerFee(10, 0.515)', takerFee(10, 0.515), 0.1749);
eq('takerFee(100, 0.50)', takerFee(100, 0.50), 1.75);
eq('takerFee(19, 0.52)', takerFee(19, 0.52), 0.332);
eq('feePerContract(0.5)', feePerContract(0.5), 0.0175);
eq('takerFee(5, 0)', takerFee(5, 0), 0);
eq('takerFee(5, 1)', takerFee(5, 1), 0);
eq('ceilToCenticent(0.01748425)', ceilToCenticent(0.01748425), 0.0175);
eq('ceilToCenticent(0.0175)', ceilToCenticent(0.0175), 0.0175);

// --- EV gate (identical to Kronos 5) ----------------------------------------
eq('feeAdjustedEv(0.566, 0.515)', feeAdjustedEv(0.566, 0.515), 0.566 / 0.53248425 - 1, 1e-12);
eq('feeAdjustedEv(0.566, 0.55) < 0.03', feeAdjustedEv(0.566, 0.55) < 0.03 ? 1 : 0, 1);
eq('feeAdjustedEv(0.566, 0)', feeAdjustedEv(0.566, 0), -1);

// --- trade economics ---------------------------------------------------------
const t = tradeEconomics(0.566, 0.50, 20);
eq('econ.positionCost', t.positionCost, 10.0);
eq('econ.estimatedFee', t.estimatedFee, 0.35);
eq('econ.expectedGross', t.expectedGross, 1.32, 1e-12);
eq('econ.expectedNet', t.expectedNet, 0.97, 1e-12);

// --- fixed-stake sizing ($5, integer contracts, fees inside the stake) ------
// $5 @ 0.50 -> floor(10) = 10; cost 5.00 + fee 0.175 = 5.175 > 5 -> walk to 9
// 9: cost 4.50 + fee ceil(0.07*9*0.25)=0.1575 -> 4.6575 <= 5 OK
{
  const s = sizeOrder(5.00, 100, 0.50);
  eq('sizing $5 @0.50 contracts', s.contracts, 9);
  eq('sizing $5 @0.50 totalCost <= 5', s.totalCost <= 5 ? 1 : 0, 1);
}
// $5 @ 0.40 -> floor(12.5)=12; cost 4.80 + fee ceil(0.07*12*0.24)=0.2016->0.2016
// 4.80+0.2016=5.0016 > 5 -> 11: 4.40+0.1849 (0.07*11*0.24=0.1848->ceil 0.1848? 0.18480 exact*)
// 0.07*11*0.4*0.6 = 0.1848 exactly -> 4.5848 <= 5 OK
{
  const s = sizeOrder(5.00, 100, 0.40);
  eq('sizing $5 @0.40 contracts', s.contracts, 11);
  eq('sizing $5 @0.40 totalCost <= 5', s.totalCost <= 5 ? 1 : 0, 1);
}
// Balance is the binding constraint: $3 balance, $5 stake @ 0.50 -> max 5
// 5: 2.50 + 0.0875 = 2.5875 <= 3 OK ; 6: 3.00 + 0.105 = 3.105 > 3
{
  const s = sizeOrder(5.00, 3.00, 0.50);
  eq('sizing balance-bound contracts', s.contracts, 5);
}
// Unaffordable -> 0 contracts (trade must be rejected)
{
  const s = sizeOrder(5.00, 0.10, 0.50);
  eq('sizing unaffordable -> 0', s.contracts, 0);
}
// Stake never scales: same result regardless of a big balance
{
  const a = sizeOrder(5.00, 100, 0.45);
  const b = sizeOrder(5.00, 100_000, 0.45);
  eq('fixed stake independent of balance', a.contracts, b.contracts);
}

// --- live settlement math (NO contract pays $1 on win) -----------------------
// win: 9 contracts @ avg 0.50, cost 4.50, fee 0.1575:
//   revenue 9.00, gross 4.50, net 4.3425
{
  const contracts = 9, avg = 0.50, cost = contracts * avg, fee = takerFee(contracts, avg);
  const revenue = contracts * 1.0;
  eq('live win gross', revenue - cost, 4.50);
  eq('live win net', revenue - cost - fee, 4.3425);
  // loss: revenue 0, gross -4.50, net -4.6575
  eq('live loss net', 0 - cost - fee, -4.6575);
}

if (failures > 0) {
  console.error(`${failures} test(s) FAILED`);
  process.exit(1);
}
console.log('All fee/EV/sizing tests passed.');
