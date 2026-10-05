// Remove the balance-floor stop loss (disables the guard).
//   node --experimental-sqlite ..\scripts\clear-stop-loss.mjs
//
// This only removes the floor. It does NOT clear a halt the stop already
// tripped — if the scanner is halted, resume with scripts/clear-halt.mjs.
//
// NOTE on resuming after a stop-loss trip: while halted no trading occurs, so
// the balance stays put. If you clear the halt but leave the floor in place and
// the balance is still at/below it, the very next tick re-trips the stop. To
// actually resume you must either lower/remove the floor (this script, or
// set-stop-loss.mjs with a lower value) or add funds so balance rises above it.
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, '..', 'db', 'kronos6.db');

const db = new DatabaseSync(DB_PATH);
const prev = db.prepare("SELECT value FROM config WHERE key='k6_stop_loss_dollars'").get()?.value;
const prevTrail = db.prepare("SELECT value FROM config WHERE key='k6_stop_loss_trail_dollars'").get()?.value;
db.prepare("DELETE FROM config WHERE key='k6_stop_loss_dollars'").run();
db.prepare("DELETE FROM config WHERE key='k6_stop_loss_trail_dollars'").run();
db.prepare("DELETE FROM config WHERE key='k6_stop_loss_tripped_ts'").run();
console.log(`[K6 STOP-LOSS] removed balance floor (was $${prev ?? '(none)'}) and trail (was $${prevTrail ?? '(none)'}). Stop loss is now DISABLED.`);
const halt = db.prepare("SELECT value FROM config WHERE key='k6_halt'").get()?.value;
if (halt === '1') {
  console.log('[K6 STOP-LOSS] NOTE: the scanner is still halted. Run scripts/clear-halt.mjs to resume trading.');
}
