// Live-ledger audit. The Kalshi account balance is the authoritative equity;
// this audit cross-checks it against our recorded trade history:
//   expected balance ≈ session start balance + Σ settled net P/L
//                      − Σ open-position costs+fees (cash tied up in contracts)
// A drift beyond tolerance means our ledger and the real account disagree
// (crash mid-trade, manual trading on the same account, missed fill...).
// Per the fail-closed philosophy, a corrupted state HALTS new trades
// (config k6_halt=1) until the operator investigates and clears it with
// scripts/clear-halt.mjs. Existing open trades still resolve.
import { getDb, getConfig, setConfig, setHalt, isHalted } from './db.js';
import { STRATEGY } from './config.js';
import { getBalance, formatBalanceBreakdown } from './kalshi-client.js';
import { resolveTrades } from './resolver.js';
import { k6log } from './log.js';

const DRIFT_TOLERANCE_DOLLARS = 0.50;

// A drift breach must PERSIST before halting. Kalshi credits settlement
// revenue with a lag (observed >75s on 2026-07-30: trade #74's $20 payout
// landed after the audit read, causing a phantom -$20.02 drift and a false
// halt). Transient lag self-heals on re-read; real ledger corruption does not.
//
// The lag also runs the other way: Kalshi credits the payout at window close
// while OUR ledger still shows the trade open, so live > expected by the
// payout (2026-08-19: trade #143's $1.91 credit landed at 12:30:02, the audit
// read at 12:30:18, phantom +$1.86 drift, false halt). That side cannot heal
// by re-reading the balance alone — only resolveTrades() closes the trade in
// our ledger, and it runs in the same single-threaded tick this recheck loop
// blocks. So each recheck drives the resolver itself before re-reading.
const DRIFT_RECHECKS = 4;
const DRIFT_RECHECK_DELAY_MS = 30_000;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface AuditReport {
  ts: number;
  startBalance: number | null;
  liveBalance: number;
  settledN: number;
  openN: number;
  sumNetPnl: number;
  openExposure: number;
  expectedBalance: number | null;
  driftDollars: number | null;
  halted: boolean;
}

// Baseline for a balance observed AFTER trades already exist in the ledger
// (key cleared by clear-halt.mjs, or never set before a restart): that balance
// already contains their P/L, so back the ledger out — otherwise the audit
// double-counts past trades and halts on a phantom drift equal to −Σ net_pnl.
export function reconstructSessionStart(liveBalanceDollars: number): number {
  const db = getDb();
  const settled = db.prepare(`SELECT net_pnl FROM trades WHERE strategy = ? AND correct IS NOT NULL`).all(STRATEGY) as Array<{ net_pnl: number }>;
  const open = db.prepare(`SELECT position_cost, fee_amount FROM trades WHERE strategy = ? AND correct IS NULL`).all(STRATEGY) as Array<{ position_cost: number; fee_amount: number }>;
  const sumNetPnl = settled.reduce((a, b) => a + (b.net_pnl ?? 0), 0);
  const openExposure = open.reduce((a, b) => a + (b.position_cost ?? 0) + (b.fee_amount ?? 0), 0);
  return Number((liveBalanceDollars - sumNetPnl + openExposure).toFixed(4));
}

function computeAudit(liveBalance: number): AuditReport {
  const db = getDb();
  const startRaw = getConfig('k6_session_start_balance');
  const startBalance = startRaw != null ? Number(startRaw) : null;

  const settled = db.prepare(`SELECT net_pnl FROM trades WHERE strategy = ? AND correct IS NOT NULL`).all(STRATEGY) as Array<{ net_pnl: number }>;
  const open = db.prepare(`SELECT position_cost, fee_amount FROM trades WHERE strategy = ? AND correct IS NULL`).all(STRATEGY) as Array<{ position_cost: number; fee_amount: number }>;

  const sumNetPnl = settled.reduce((a, b) => a + (b.net_pnl ?? 0), 0);
  const openExposure = open.reduce((a, b) => a + (b.position_cost ?? 0) + (b.fee_amount ?? 0), 0);
  const expectedBalance = startBalance != null ? startBalance + sumNetPnl - openExposure : null;
  const driftDollars = expectedBalance != null ? Number((liveBalance - expectedBalance).toFixed(4)) : null;

  return {
    ts: Date.now(),
    startBalance,
    liveBalance,
    settledN: settled.length,
    openN: open.length,
    sumNetPnl: Number(sumNetPnl.toFixed(4)),
    openExposure: Number(openExposure.toFixed(4)),
    expectedBalance: expectedBalance != null ? Number(expectedBalance.toFixed(4)) : null,
    driftDollars,
    halted: isHalted(),
  };
}

function persistAudit(report: AuditReport): void {
  setConfig('k6_last_audit_ts', String(report.ts));
  setConfig('k6_last_audit', JSON.stringify(report));
  // Keep the dashboard's balance live even while halted — the 2026-07-30
  // incident froze the displayed balance at a stale pre-settlement read.
  setConfig('k6_last_balance', String(report.liveBalance));
  setConfig('k6_last_balance_ts', String(report.ts));
}

const breached = (r: AuditReport) =>
  r.driftDollars != null && Math.abs(r.driftDollars) > DRIFT_TOLERANCE_DOLLARS;

export async function auditLedger(): Promise<AuditReport | null> {
  let liveBalance: number;
  let shardNote = '';
  try {
    const bal = await getBalance();
    liveBalance = bal.balanceDollars;
    // Log every shard. Collateral stranded outside the trading shard is invisible
    // otherwise, and on 2026-09-04 it presented as unexplained ledger drift.
    const stranded = bal.totalDollars - bal.balanceDollars;
    shardNote = ` shards[${formatBalanceBreakdown(bal.breakdown)}]`
      + (stranded > 0.01 ? ` !! $${stranded.toFixed(2)} outside the trading shard` : '');
  } catch (e) {
    k6log(`[K6 ERROR] audit: balance read failed: ${(e as Error).message}`);
    return null;
  }

  let report = computeAudit(liveBalance);
  persistAudit(report);
  k6log(`[K6 AUDIT]${shardNote}`);
  k6log(`[K6 AUDIT] balance=$${report.liveBalance.toFixed(2)} expected=${report.expectedBalance != null ? `$${report.expectedBalance.toFixed(2)}` : 'n/a'} drift=${report.driftDollars != null ? `$${report.driftDollars.toFixed(2)}` : 'n/a'} settled=${report.settledN} open=${report.openN}${breached(report) ? ' !! DRIFT BREACH — rechecking' : ''}`);

  // Breach: re-read before halting. Settlement-credit lag self-heals within
  // a couple of minutes; genuine ledger corruption persists through every
  // recheck. Expected balance is recomputed each pass in case a settlement
  // lands in our own ledger while we wait.
  if (breached(report) && !isHalted()) {
    for (let i = 1; i <= DRIFT_RECHECKS && breached(report); i++) {
      await sleep(DRIFT_RECHECK_DELAY_MS);
      // Let our own ledger catch up: a just-closed window is only settled
      // internally by the resolver, which is otherwise starved while we wait.
      try { await resolveTrades(); } catch (e) {
        k6log(`[K6 AUDIT] recheck ${i}/${DRIFT_RECHECKS}: resolver pass failed: ${(e as Error).message}`);
      }
      try {
        liveBalance = (await getBalance()).balanceDollars;
      } catch (e) {
        k6log(`[K6 AUDIT] recheck ${i}/${DRIFT_RECHECKS}: balance read failed: ${(e as Error).message}`);
        continue;
      }
      report = computeAudit(liveBalance);
      persistAudit(report);
      k6log(`[K6 AUDIT] recheck ${i}/${DRIFT_RECHECKS}: balance=$${report.liveBalance.toFixed(2)} drift=${report.driftDollars != null ? `$${report.driftDollars.toFixed(2)}` : 'n/a'}${breached(report) ? ' — still breached' : ' — resolved (transient settlement lag)'}`);
    }
  }

  if (breached(report) && !isHalted()) {
    setHalt(true, `audit drift $${report.driftDollars!.toFixed(2)} persisted through ${DRIFT_RECHECKS} rechecks over ${(DRIFT_RECHECKS * DRIFT_RECHECK_DELAY_MS / 1000).toFixed(0)}s at ${new Date().toISOString()}`);
    k6log('[K6 AUDIT] !! HALTED new trades (k6_halt=1). Investigate (manual account activity? missed fill?), then clear with scripts/clear-halt.mjs.');
  }
  return report;
}
