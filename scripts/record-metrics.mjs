// Kronos 6 — candle metrics recorder (9-day EMA + session VWAP).
//
// WHY THIS IS A SEPARATE PROCESS
// ------------------------------
// Kronos 6 trades real money and its strategy is frozen mid-evaluation. This
// recorder therefore runs OUTSIDE the trading tick: it never imports scanner
// code, never touches the trades/orders/decisions/config tables, and cannot add
// latency or a failure mode to a scan. If it dies, trading is unaffected.
//
// It writes exactly one table — candle_metrics — and nothing reads that table
// to make a trading decision. It is data capture for backtesting and for
// whatever strategy work comes after the current 300-trade sample closes.
//
// Usage:
//   node --experimental-sqlite record-metrics.mjs --once
//   node --experimental-sqlite record-metrics.mjs --backfill=60
//   node --experimental-sqlite record-metrics.mjs            (loop, for PM2)
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchCandlesDeep } from '../shared/candles.mjs';
import { computeMetrics, EMA_9D_MIN_HISTORY } from '../shared/indicators.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, '..', 'db', 'kronos6.db');

const SYMBOL = 'ETHUSD';
const INTERVAL = '15m';
const GRANULARITY_S = 900;
const LOOP_MS = 5 * 60 * 1000;          // candles close every 15m; 5m is ample
const DEFAULT_FETCH = EMA_9D_MIN_HISTORY + 240; // 1968 candles ~= 20.5 days

const args = process.argv.slice(2);
const ONCE = args.includes('--once');
const backfillArg = args.find((a) => a.startsWith('--backfill='));
const BACKFILL_DAYS = backfillArg ? Number(backfillArg.split('=')[1]) : 0;

const log = (m) => console.log(`[K6-METRICS ${new Date().toISOString()}] ${m}`);

let db = null;
function getDb() {
  if (db) return db;
  db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA busy_timeout = 10000');
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS candle_metrics (
      ts             INTEGER PRIMARY KEY,   -- candle OPEN time, epoch ms UTC
      symbol         TEXT NOT NULL,
      interval       TEXT NOT NULL,
      open           REAL,
      high           REAL,
      low            REAL,
      close          REAL,
      volume         REAL,
      ema_9d         REAL,                  -- 9-DAY EMA (864 x 15m periods)
      ema_9c         REAL,                  -- classic 9-CANDLE EMA (2h15m)
      vwap_session   REAL,                  -- VWAP anchored to UTC midnight
      vwap_anchor_ts INTEGER,               -- the UTC midnight it is anchored to
      updated_at     INTEGER NOT NULL
    )`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_k6_candle_metrics_anchor ON candle_metrics(vwap_anchor_ts)');
  return db;
}

function upsert(rows) {
  const d = getDb();
  const stmt = d.prepare(`INSERT INTO candle_metrics
    (ts, symbol, interval, open, high, low, close, volume,
     ema_9d, ema_9c, vwap_session, vwap_anchor_ts, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(ts) DO UPDATE SET
      open=excluded.open, high=excluded.high, low=excluded.low, close=excluded.close,
      volume=excluded.volume,
      -- COALESCE, NOT plain assignment. A shallow run (the 5-minute loop fetches
      -- ~1968 candles) computes ema_9d=NULL for every row outside its own warm-up
      -- window. Without this, each loop pass would silently wipe the deep-backfilled
      -- history it cannot see. Never let a narrower view delete a wider one.
      ema_9d=COALESCE(excluded.ema_9d, candle_metrics.ema_9d),
      ema_9c=COALESCE(excluded.ema_9c, candle_metrics.ema_9c),
      vwap_session=COALESCE(excluded.vwap_session, candle_metrics.vwap_session),
      vwap_anchor_ts=COALESCE(excluded.vwap_anchor_ts, candle_metrics.vwap_anchor_ts),
      updated_at=excluded.updated_at`);
  const now = Date.now();
  d.exec('BEGIN');
  try {
    for (const r of rows) {
      stmt.run(r.ts, SYMBOL, INTERVAL, r.open, r.high, r.low, r.close, r.volume,
        r.ema9d, r.ema9c, r.vwapSession, r.vwapAnchorTs, now);
    }
    d.exec('COMMIT');
  } catch (err) {
    d.exec('ROLLBACK');
    throw err;
  }
}

async function runOnce(fetchCount, writeMostRecent = null) {
  const candles = await fetchCandlesDeep(SYMBOL, fetchCount, GRANULARITY_S);
  if (candles.length === 0) { log('no candles returned — skipping'); return 0; }

  const metrics = computeMetrics(candles);

  // Persist only rows carrying at least one usable metric. Candles before the
  // 9-day EMA warm-up have a null ema_9d by construction.
  let rows = metrics.filter((m) => m.ema9d != null || m.vwapSession != null);

  // Loop mode writes only the tail. Values for long-closed candles do not
  // change, and the live scanner shares this database — there is no reason to
  // churn ~2000 rows of WAL every five minutes underneath a money process.
  if (writeMostRecent != null) rows = rows.slice(-writeMostRecent);
  upsert(rows);

  const withEma = rows.filter((r) => r.ema9d != null).length;
  const last = metrics[metrics.length - 1];
  log(`upserted ${rows.length} rows (${withEma} with ema_9d) | last candle ${new Date(last.ts).toISOString()} `
    + `close=${last.close} ema9d=${last.ema9d == null ? 'null' : last.ema9d.toFixed(2)} `
    + `ema9c=${last.ema9c == null ? 'null' : last.ema9c.toFixed(2)} `
    + `vwap=${last.vwapSession == null ? 'null' : last.vwapSession.toFixed(2)}`);
  return rows.length;
}

async function main() {
  if (BACKFILL_DAYS > 0) {
    // Enough candles to cover the requested span PLUS the EMA warm-up ahead of it.
    const need = Math.ceil(BACKFILL_DAYS * 96) + EMA_9D_MIN_HISTORY;
    log(`backfill: ${BACKFILL_DAYS} days (fetching ${need} candles incl. EMA warm-up)`);
    await runOnce(need);
    log('backfill complete');
    return;
  }

  // First pass writes the full fetched span so a fresh install is populated;
  // subsequent loop passes only touch the tail.
  await runOnce(DEFAULT_FETCH);
  if (ONCE) return;

  log(`loop mode — refreshing every ${LOOP_MS / 60000} min`);
  setInterval(() => {
    runOnce(DEFAULT_FETCH, 300).catch((err) => console.error(`[K6-METRICS ERROR] ${err.message}`));
  }, LOOP_MS);
}

main().catch((err) => {
  console.error(`[K6-METRICS FATAL] ${err.stack || err.message}`);
  process.exit(1);
});
