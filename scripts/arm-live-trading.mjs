// THE manual arming step — the last safeguard before real money moves.
// Kronos 6 will not submit a single live order until this script has been run
// by a human and the exact confirmation phrase typed interactively.
//
//   cd C:\Claude\Kronos6\scanner
//   node --experimental-sqlite ..\scripts\arm-live-trading.mjs
//
// This cannot be piped or automated trivially: it requires a TTY.
import { DatabaseSync } from 'node:sqlite';
import { createInterface } from 'node:readline/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, '..', 'db', 'kronos6.db');
const PHRASE = 'ARM LIVE TRADING';

if (!process.stdin.isTTY) {
  console.error('[K6 ARM] refusing: this script must be run interactively by a human (no TTY detected).');
  process.exit(1);
}

const db = new DatabaseSync(DB_PATH);
const get = (k) => db.prepare('SELECT value FROM config WHERE key=?').get(k)?.value ?? null;

console.log('=== Kronos 6 — ARM LIVE TRADING ===');
console.log('');
console.log('  This will allow the scanner to place REAL MONEY orders on your');
console.log('  funded Kalshi account whenever the frozen strategy signals.');
console.log('');
console.log(`  Current state : ${get('k6_live_trading_armed') ?? 'unarmed'}`);
console.log(`  Fixed stake   : $${get('k6_stake_dollars') ?? '5.00'} per trade`);
console.log(`  Halt flag     : ${get('k6_halt') === '1' ? `HALTED (${get('k6_halt_reason')})` : 'clear'}`);
console.log(`  Last balance  : $${get('k6_last_balance') ?? 'unknown'}`);
console.log('');

const rl = createInterface({ input: process.stdin, output: process.stdout });
const answer = await rl.question(`Type exactly "${PHRASE}" to arm (anything else aborts): `);
rl.close();

if (answer.trim() !== PHRASE) {
  console.log('[K6 ARM] aborted — live trading remains unarmed.');
  process.exit(0);
}

db.prepare("INSERT INTO config(key,value) VALUES('k6_live_trading_armed','ARMED') ON CONFLICT(key) DO UPDATE SET value='ARMED'").run();
db.prepare("INSERT INTO config(key,value) VALUES('k6_armed_at',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(Date.now()));
console.log('');
console.log('[K6 ARM] LIVE TRADING IS NOW ARMED. The running scanner picks this up within one 15s poll.');
console.log('[K6 ARM] Disarm at any time with: node --experimental-sqlite ..\\scripts\\disarm-live-trading.mjs');
