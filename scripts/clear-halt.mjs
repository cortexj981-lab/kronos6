// Clear the audit/operator halt flag after investigating an inconsistency.
// Only do this once you understand WHY the ledger and the live balance
// disagreed (see the [K6 AUDIT] log lines and the equity/trades tables).
//   node --experimental-sqlite ..\scripts\clear-halt.mjs
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, '..', 'db', 'kronos6.db');

const db = new DatabaseSync(DB_PATH);
const reason = db.prepare("SELECT value FROM config WHERE key='k6_halt_reason'").get()?.value ?? '(none recorded)';
console.log(`[K6 HALT] previous halt reason: ${reason}`);
db.prepare("INSERT INTO config(key,value) VALUES('k6_halt','0') ON CONFLICT(key) DO UPDATE SET value='0'").run();
db.prepare("INSERT INTO config(key,value) VALUES('k6_halt_reason','') ON CONFLICT(key) DO UPDATE SET value=''").run();
// Re-baseline the audit so the cleared discrepancy doesn't immediately re-halt:
// the operator has accepted the current live balance as the new reference point.
db.prepare("DELETE FROM config WHERE key='k6_session_start_balance'").run();
console.log('[K6 HALT] halt cleared; session start balance re-baselines on the next validation pass.');
