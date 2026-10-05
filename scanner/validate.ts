// Startup validation — every check must pass before Kronos 6 will trade.
// Fail closed: any failure leaves the scanner alive but non-trading; it
// re-validates periodically and logs why it is not trading.
import {
  SERIES_TICKER, MAX_CLOCK_SKEW_MS,
} from './config.js';
import { credentialSummary } from './kalshi-auth.js';
import {
  getBalance, getExchangeStatus, getSeries, getMarkets, getOrders, getLastClockSkewMs,
} from './kalshi-client.js';
import { getStakeDollars } from './db.js';
import { takerFee } from './fees.js';
import { k6log } from './log.js';

export interface ValidationReport {
  ok: boolean;
  ts: number;
  balanceDollars: number | null;
  failures: string[];
  notes: string[];
}

export async function validateStartup(): Promise<ValidationReport> {
  const failures: string[] = [];
  const notes: string[] = [];
  let balanceDollars: number | null = null;

  // 1. Credentials parse (never logs key material).
  try {
    const c = credentialSummary();
    notes.push(`credentials: ${c.file}, key id ${c.apiKeyIdPrefix}, parsed=${c.keyParsed}`);
    if (!c.keyParsed) failures.push('private key did not parse as a private key');
  } catch (e) {
    failures.push(`credential load failed: ${(e as Error).message}`);
    return { ok: false, ts: Date.now(), balanceDollars, failures, notes }; // nothing else can work
  }

  // 2. Exchange status (public).
  try {
    const ex = await getExchangeStatus();
    notes.push(`exchange_active=${ex.exchange_active} trading_active=${ex.trading_active}`);
    if (!ex.exchange_active || !ex.trading_active) failures.push('Kalshi exchange/trading is not active');
  } catch (e) {
    failures.push(`exchange status failed: ${(e as Error).message}`);
  }

  // 3. Authentication + account access + balance.
  try {
    const b = await getBalance();
    balanceDollars = b.balanceDollars;
    notes.push(`account balance $${b.balanceDollars.toFixed(2)}`);
    const stake = getStakeDollars();
    const worstFee = takerFee(Math.floor(stake / 0.01), 0.5); // ultra-conservative headroom
    if (b.balanceDollars < stake + worstFee) {
      failures.push(`balance $${b.balanceDollars.toFixed(2)} below stake+fee headroom ($${(stake + worstFee).toFixed(2)})`);
    }
  } catch (e) {
    failures.push(`balance/auth failed: ${(e as Error).message}`);
  }

  // 4. Order-read permission (no order is placed).
  try {
    await getOrders({ limit: 1 });
    notes.push('portfolio order read OK (permissions confirmed)');
  } catch (e) {
    failures.push(`portfolio orders read failed (permissions?): ${(e as Error).message}`);
  }

  // 5. Series fee metadata must still match the frozen fee model.
  try {
    const s = await getSeries(SERIES_TICKER);
    notes.push(`series ${SERIES_TICKER}: fee_type=${s.series.fee_type} fee_multiplier=${s.series.fee_multiplier}`);
    if (s.series.fee_type !== 'quadratic' || Number(s.series.fee_multiplier ?? 1) !== 1) {
      failures.push(`series fee model changed (fee_type=${s.series.fee_type}, multiplier=${s.series.fee_multiplier}) — fee math would be wrong`);
    }
  } catch (e) {
    failures.push(`series metadata failed: ${(e as Error).message}`);
  }

  // 6. ETH 15-minute markets exist / market discovery surface works.
  try {
    const res = await getMarkets({ series_ticker: SERIES_TICKER, limit: 10 });
    if (!res.markets || res.markets.length === 0) failures.push(`no ${SERIES_TICKER} markets listed`);
    else notes.push(`${SERIES_TICKER} markets listed: ${res.markets.length} (discovery surface OK)`);
  } catch (e) {
    failures.push(`market listing failed: ${(e as Error).message}`);
  }

  // 7. Clock synchronization (signature timestamps + window math depend on it).
  const skew = getLastClockSkewMs();
  if (skew == null) {
    failures.push('no clock-skew estimate available (no successful API response)');
  } else if (Math.abs(skew) > MAX_CLOCK_SKEW_MS) {
    failures.push(`local clock skew ${Math.round(skew)}ms exceeds ${MAX_CLOCK_SKEW_MS}ms — fix system time`);
  } else {
    notes.push(`clock skew ${Math.round(skew)}ms (OK)`);
  }

  // 8. Configured stake is sane (getStakeDollars throws on invalid values).
  try {
    notes.push(`fixed stake $${getStakeDollars().toFixed(2)} per trade`);
  } catch (e) {
    failures.push((e as Error).message);
  }

  const ok = failures.length === 0;
  k6log(`[K6 VALIDATE] ${ok ? 'ALL CHECKS PASSED' : `${failures.length} CHECK(S) FAILED — trading disabled`}`);
  for (const n of notes) k6log(`[K6 VALIDATE]   ok: ${n}`);
  for (const f of failures) k6log(`[K6 VALIDATE]   FAIL: ${f}`);
  return { ok, ts: Date.now(), balanceDollars, failures, notes };
}
