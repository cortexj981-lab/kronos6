// Set the balance-floor stop loss without touching code.
//   node --experimental-sqlite ..\scripts\set-stop-loss.mjs 125.00
//
// When the live Kalshi account balance falls to or below this dollar floor, the
// scanner trips k6_halt: no new orders are placed, and trading stays stopped
// until an operator clears the halt (scripts/clear-halt.mjs). Any position
// already filled when the stop trips still settles normally (Kalshi binaries
// auto-settle within their 15-minute window); there is no forced early exit.
//
// Remove the stop with scripts/clear-stop-loss.mjs.
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, '..', 'db', 'kronos6.db');

const v = Number(process.argv[2]);
if (!Number.isFinite(v) || v <= 0) {
  console.error('Usage: set-stop-loss.mjs <dollars>   (a positive balance floor, e.g. 125.00)');
  process.exit(1);
}

const db = new DatabaseSync(DB_PATH);
const prev = db.prepare("SELECT value FROM config WHERE key='k6_stop_loss_dollars'").get()?.value;
const bal = db.prepare("SELECT value FROM config WHERE key='k6_last_balance'").get()?.value;
const balNum = bal != null ? Number(bal) : null;

db.prepare("INSERT INTO config(key,value) VALUES('k6_stop_loss_dollars',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(v.toFixed(2));

console.log(`[K6 STOP-LOSS] balance floor set: $${prev ?? '(none)'} -> $${v.toFixed(2)} (picked up next poll).`);
if (balNum != null) {
  console.log(`[K6 STOP-LOSS] last known balance: $${balNum.toFixed(2)}`);
  if (balNum <= v) {
    console.log(`[K6 STOP-LOSS] WARNING: floor $${v.toFixed(2)} is at/above current balance $${balNum.toFixed(2)} — the scanner will halt on the next tick.`);
  } else {
    console.log(`[K6 STOP-LOSS] room to floor: $${(balNum - v).toFixed(2)}.`);
  }
}
console.log('[K6 STOP-LOSS] On trip: new trading halts until you run scripts/clear-halt.mjs. Filled positions still settle normally.');
