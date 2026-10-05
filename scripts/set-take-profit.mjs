// Set the take-profit ceiling: when the live balance reaches this figure,
// trading halts. The mirror image of set-stop-loss.mjs.
//
//   node --experimental-sqlite scripts\set-take-profit.mjs 300
//   node --experimental-sqlite scripts\set-take-profit.mjs off
//
// HOW IT IS ENFORCED, AND WHY IT IS NOT IN THE SCANNER.
// The scanner has no take-profit logic, and adding some would mean editing
// live-money trading code and restarting it under pm2 (which needs an elevated
// terminal here). It is not necessary: the scanner already reads k6_halt fresh
// from this database at the LAST gate before an order is placed. So an outside
// watcher that sets k6_halt stops trading just as hard as the stop loss does,
// with no change to the trading path at all.
//
// The watcher is scripts/take-profit-watch.mjs, run every minute by the
// scheduled task "Kronos6 Take Profit Watch".
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const db = new DatabaseSync(path.join(__dirname, '..', 'db', 'kronos6.db'));
const get = (k) => db.prepare('SELECT value FROM config WHERE key=?').get(k)?.value ?? null;
const set = (k, v) => db.prepare(
  'INSERT INTO config(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value'
).run(k, v);

const arg = (process.argv[2] ?? '').trim();
const prev = get('k6_take_profit_dollars');
const bal = Number(get('k6_last_balance') ?? 0);

if (arg.toLowerCase() === 'off' || arg.toLowerCase() === 'none') {
  db.prepare("DELETE FROM config WHERE key='k6_take_profit_dollars'").run();
  console.log(`[K6 TAKE-PROFIT] removed ceiling (was $${prev ?? '(none)'}). Take profit is now DISABLED.`);
  process.exit(0);
}

const v = Number(arg);
if (!Number.isFinite(v) || v <= 0) {
  console.error('Usage: set-take-profit.mjs <dollars>   (a positive balance ceiling, e.g. 300)');
  console.error('       set-take-profit.mjs off         (remove the ceiling)');
  process.exit(1);
}
if (v <= bal) {
  console.error(`[K6 TAKE-PROFIT] REFUSED: ceiling $${v.toFixed(2)} is at or below the current ` +
                `balance $${bal.toFixed(2)} — that would halt immediately. Pick a higher figure, ` +
                `or halt by hand if that is what you meant.`);
  process.exit(1);
}
const floor = get('k6_stop_loss_dollars');
if (floor && v <= Number(floor)) {
  console.error(`[K6 TAKE-PROFIT] REFUSED: ceiling $${v.toFixed(2)} is at or below the stop-loss ` +
                `floor $${Number(floor).toFixed(2)}.`);
  process.exit(1);
}

set('k6_take_profit_dollars', v.toFixed(2));
console.log(`[K6 TAKE-PROFIT] balance ceiling set: $${prev ?? '(none)'} -> $${v.toFixed(2)}`);
console.log(`[K6 TAKE-PROFIT] current balance: $${bal.toFixed(2)}  (room to ceiling: $${(v - bal).toFixed(2)})`);
if (floor) console.log(`[K6 TAKE-PROFIT] stop-loss floor remains $${Number(floor).toFixed(2)}.`);
console.log('[K6 TAKE-PROFIT] On trip: new trading halts until you run scripts/clear-halt.mjs.');
console.log('[K6 TAKE-PROFIT] Filled positions still settle normally — nothing is sold or cancelled.');
