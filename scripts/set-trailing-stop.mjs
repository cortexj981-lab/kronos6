// Arm a TRAILING stop loss without touching code.
//   node --experimental-sqlite ..\scripts\set-trailing-stop.mjs 200
//
// Sets k6_stop_loss_trail_dollars and initializes the floor
// (k6_stop_loss_dollars) to last-known-balance minus the trail, unless an
// existing floor is already higher (the floor never moves down). From then on
// the scanner raises the floor every time a fresh Kalshi balance reading
// exceeds floor + trail; when the balance falls to or below the floor it trips
// k6_halt exactly like the static stop (clear with scripts/clear-halt.mjs).
//
// Remove trail + floor together with scripts/clear-stop-loss.mjs.
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, '..', 'db', 'kronos6.db');

const trail = Number(process.argv[2]);
if (!Number.isFinite(trail) || trail <= 0) {
  console.error('Usage: set-trailing-stop.mjs <dollars>   (positive trail distance, e.g. 200)');
  process.exit(1);
}

const db = new DatabaseSync(DB_PATH);
const get = (k) => db.prepare('SELECT value FROM config WHERE key=?').get(k)?.value;
const set = (k, v) => db.prepare('INSERT INTO config(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k, v);

const bal = get('k6_last_balance') != null ? Number(get('k6_last_balance')) : null;
const prevFloor = get('k6_stop_loss_dollars') != null ? Number(get('k6_stop_loss_dollars')) : null;
const prevTrail = get('k6_stop_loss_trail_dollars');

set('k6_stop_loss_trail_dollars', trail.toFixed(2));
console.log(`[K6 TRAIL-STOP] trail distance set: $${prevTrail ?? '(none)'} -> $${trail.toFixed(2)}`);

if (bal == null) {
  console.log('[K6 TRAIL-STOP] no k6_last_balance yet — floor will initialize on the scanner\'s next fresh balance read.');
} else {
  const candidate = bal - trail;
  if (candidate <= 0) {
    console.log(`[K6 TRAIL-STOP] balance $${bal.toFixed(2)} <= trail — floor unchanged (will arm once balance exceeds the trail).`);
  } else if (prevFloor != null && candidate <= prevFloor) {
    console.log(`[K6 TRAIL-STOP] existing floor $${prevFloor.toFixed(2)} already >= $${candidate.toFixed(2)} — keeping it (floor never moves down).`);
  } else {
    set('k6_stop_loss_dollars', candidate.toFixed(2));
    console.log(`[K6 TRAIL-STOP] floor initialized: $${prevFloor?.toFixed(2) ?? '(none)'} -> $${candidate.toFixed(2)} (balance $${bal.toFixed(2)} - $${trail.toFixed(2)}).`);
  }
}
console.log('[K6 TRAIL-STOP] On trip: new trading halts until you run scripts/clear-halt.mjs. Filled positions still settle normally.');
