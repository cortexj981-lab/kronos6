/**
 * Repair `trades.balance_after` on settled trades.
 *
 * WHY: resolver.ts used to write a LIVE Kalshi balance read as the trade's closing
 * balance. For a loss that read was frequently taken after the NEXT trade had already
 * been placed, so it was low by that next trade's cost + fee — a closing balance that
 * belonged to no point in time. Two consecutive losses could show an identical balance.
 * resolver.ts now computes it from the ledger; this repairs the rows written before that.
 *
 * balance_after := balance_before + net_pnl, which is exact: `net_pnl` is derived from
 * contracts/price/fee and is NOT touched here, so running P/L, the audit and the
 * reported bankroll are all unchanged. This only makes the displayed column agree with
 * the arithmetic already in the row.
 *
 * Read-only unless --apply is passed.
 */
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';

// Resolved from this file's location so the repo can live anywhere.
const DB = path.join(import.meta.dirname, '..', 'db', 'kronos6.db');
const APPLY = process.argv.includes('--apply');
const db = new DatabaseSync(DB, { readOnly: !APPLY });

const rows = db.prepare(
  `SELECT id, ts, market_ticker, net_pnl, balance_before, balance_after, correct
     FROM trades
    WHERE settled_at IS NOT NULL AND balance_before IS NOT NULL AND balance_after IS NOT NULL
    ORDER BY ts`
).all();

const fix = [];
for (const r of rows) {
  const expected = Number((Number(r.balance_before) + Number(r.net_pnl)).toFixed(4));
  if (Math.abs(expected - Number(r.balance_after)) > 0.005) {
    fix.push({ ...r, expected, delta: expected - Number(r.balance_after) });
  }
}

console.log(`settled trades examined : ${rows.length}`);
console.log(`rows needing repair     : ${fix.length}`);
if (fix.length) {
  console.log('\n  id    when              result  balance_before   net_pnl   stored ->   correct    delta');
  for (const f of fix) {
    console.log(
      `  ${String(f.id).padStart(4)}  ${new Date(f.ts).toISOString().slice(5, 16)}  ` +
      `${f.correct ? 'WIN ' : 'LOSS'}    ${Number(f.balance_before).toFixed(4).padStart(9)}  ` +
      `${Number(f.net_pnl).toFixed(4).padStart(8)}  ${Number(f.balance_after).toFixed(4).padStart(9)} -> ` +
      `${f.expected.toFixed(4).padStart(9)}  ${f.delta >= 0 ? '+' : ''}${f.delta.toFixed(4)}`
    );
  }
}

if (!APPLY) {
  console.log('\nDRY RUN — nothing written. Re-run with --apply to commit.');
} else {
  const upd = db.prepare('UPDATE trades SET balance_after = ? WHERE id = ?');
  db.exec('BEGIN');
  try {
    for (const f of fix) upd.run(f.expected, f.id);
    db.exec('COMMIT');
    console.log(`\nAPPLIED — ${fix.length} rows updated.`);
  } catch (e) {
    db.exec('ROLLBACK');
    console.error('ROLLED BACK:', e.message);
    process.exit(1);
  }
}
db.close();
