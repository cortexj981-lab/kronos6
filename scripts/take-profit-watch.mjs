// Take-profit watcher: halt Kronos 6 when the live balance reaches the ceiling
// set by scripts/set-take-profit.mjs. Run every minute by the scheduled task
// "Kronos6 Take Profit Watch".
//
// WHY A WATCHER AND NOT SCANNER CODE. The scanner reads k6_halt FRESH from this
// database at the last gate before an order is placed (scanner/index.ts, the
// `if (isHalted())` check that sits after the EV gate and before the balance
// read). So setting that flag from outside stops trading exactly as hard as the
// built-in stop loss, without editing live-money code or restarting pm2.
//
// WHAT IT DOES NOT DO. It does not sell, cancel, or close anything. Positions
// already filled settle normally. It only prevents NEW trades, and only by
// setting the same flag an operator would set by hand.
//
// IT IS DELIBERATELY ONE-WAY. It never clears a halt and never lowers the
// ceiling. Resuming is a human decision: scripts/clear-halt.mjs.
import { DatabaseSync } from 'node:sqlite';
import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const LOG = path.join(ROOT, 'logs', 'take_profit_watch.log');
mkdirSync(path.dirname(LOG), { recursive: true });
const log = (m) => {
  const line = `${new Date().toISOString()}  ${m}`;
  console.log(line);
  try { appendFileSync(LOG, line + '\n'); } catch { /* logging must never break the watch */ }
};

const db = new DatabaseSync(path.join(ROOT, 'db', 'kronos6.db'));
const get = (k) => db.prepare('SELECT value FROM config WHERE key=?').get(k)?.value ?? null;
const set = (k, v) => db.prepare(
  'INSERT INTO config(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value'
).run(k, v);

const ceilingRaw = get('k6_take_profit_dollars');
if (ceilingRaw == null) process.exit(0);            // no ceiling configured: nothing to do
const ceiling = Number(ceilingRaw);
if (!Number.isFinite(ceiling) || ceiling <= 0) {
  log(`WARN k6_take_profit_dollars=${ceilingRaw} is not a positive number — treating as DISABLED`);
  process.exit(0);
}

// Prefer the freshest balance the bot knows: the audit writes k6_last_balance
// after every settlement, and trades record balance_after. Take the later of the
// two so a just-settled win is not missed for a whole minute.
const cfgBal = Number(get('k6_last_balance') ?? NaN);
const cfgTs = Number(get('k6_last_balance_ts') ?? 0);
const t = db.prepare(
  'SELECT balance_after ba, ts FROM trades WHERE balance_after IS NOT NULL ORDER BY ts DESC LIMIT 1'
).get();
let balance = cfgBal, src = 'k6_last_balance';
if (t && Number(t.ts) > cfgTs && Number.isFinite(Number(t.ba))) {
  balance = Number(t.ba); src = 'trades.balance_after';
}
if (!Number.isFinite(balance)) {
  log('WARN no usable balance figure — skipping this pass');
  process.exit(0);
}

const halted = get('k6_halt') === '1';
if (balance < ceiling) {
  // quiet success: only log on a state change or every 30th minute, to keep the
  // log readable when this runs 1,440 times a day
  if (new Date().getUTCMinutes() % 30 === 0) {
    log(`ok      balance $${balance.toFixed(2)} < ceiling $${ceiling.toFixed(2)} ` +
        `(room $${(ceiling - balance).toFixed(2)}, via ${src})`);
  }
  process.exit(0);
}

if (halted) {
  log(`reached ceiling $${ceiling.toFixed(2)} at balance $${balance.toFixed(2)} — already halted, nothing to do`);
  process.exit(0);
}

const reason = `TAKE-PROFIT: balance $${balance.toFixed(2)} >= ceiling $${ceiling.toFixed(2)} ` +
               `(take_profit_watch). New trading halted until an operator approves restart ` +
               `(scripts/clear-halt.mjs).`;
set('k6_halt', '1');
set('k6_halt_reason', reason);
set('k6_take_profit_tripped_ts', String(Date.now()));
log(`*** TRIPPED *** ${reason}`);
log(`    source: ${src}. Filled positions still settle normally; nothing was sold or cancelled.`);
