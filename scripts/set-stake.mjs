// Change the fixed dollar stake without touching code.
//   node --experimental-sqlite ..\scripts\set-stake.mjs 5.00
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, '..', 'db', 'kronos6.db');
const MAX_STAKE = 25.00; // must match MAX_STAKE_DOLLARS in scanner/config.ts

const v = Number(process.argv[2]);
if (!Number.isFinite(v) || v <= 0 || v > MAX_STAKE) {
  console.error(`Usage: set-stake.mjs <dollars>   (0 < dollars <= ${MAX_STAKE})`);
  process.exit(1);
}
const db = new DatabaseSync(DB_PATH);
const prev = db.prepare("SELECT value FROM config WHERE key='k6_stake_dollars'").get()?.value;
db.prepare("INSERT INTO config(key,value) VALUES('k6_stake_dollars',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(v.toFixed(2));
console.log(`[K6 STAKE] fixed stake changed: $${prev ?? '?'} -> $${v.toFixed(2)} per trade (picked up next poll).`);
