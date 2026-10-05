// Disarm live trading immediately (no confirmation needed — disarming is
// always safe). The running scanner picks this up within one 15s poll and
// reverts to DRY_RUN decisions. Open positions still settle normally.
//   node --experimental-sqlite ..\scripts\disarm-live-trading.mjs
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, '..', 'db', 'kronos6.db');

const db = new DatabaseSync(DB_PATH);
db.prepare("INSERT INTO config(key,value) VALUES('k6_live_trading_armed','unarmed') ON CONFLICT(key) DO UPDATE SET value='unarmed'").run();
console.log('[K6 DISARM] live trading DISARMED — scanner reverts to DRY_RUN. Open positions still settle.');
