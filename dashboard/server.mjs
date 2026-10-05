// Self-contained Kronos 6 LIVE-MONEY dashboard (Kronos 5 dashboard style).
//   node --experimental-sqlite server.mjs  →  http://localhost:3006
// Reads kronos6.db read-only. Does NOT talk to Kalshi (no credentials here);
// everything shown comes from the scanner's ledger. Candle data for the chart
// is proxied from Coinbase's public API.
import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, '..', 'db', 'kronos6.db');
const PORT = Number(process.env.K6_DASH_PORT ?? 3006);
const STRATEGY = 'kronos6_down_exhaustion_15m_live_v1';
const LIB = readFileSync(path.join(__dirname, 'vendor', 'lightweight-charts.js'), 'utf8');

function withDb(fn) {
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  try { return fn(db); } finally { db.close(); }
}

// ── Time-frame selection for the Trades / Decisions tables (?h=<hours>|all) ──
const TF_CHOICES = [[24, '24h'], [48, '48h'], [72, '72h'], [96, '4d'], [240, '10d'], [null, 'ALL']];
const TF_ROW_CAP = 5000;
function parseTfHours(url) {
  const v = url.searchParams.get('h');
  if (v === 'all') return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 && n <= 8760 ? n : 24;
}
const tfCut = (h) => (h == null ? 0 : Date.now() - h * 3600_000);
const tfSeg = (h) => `<div class="seg">${TF_CHOICES.map(([v, label]) =>
  `<a class="segbtn ${v === h ? 'on' : ''}" href="/?h=${v == null ? 'all' : v}">${label}</a>`).join('')}</div>`;
const tfNote = (shown, total) => `<div class="muted" style="margin:2px 0 8px;font-size:12px">${shown === total ? `${shown} rows in window` : `showing newest ${shown} of ${total} rows in window`}</div>`;

const esc = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const num = (v, d = 2) => (v === null || v === undefined ? 'n/a' : Number(v).toFixed(d));
const dtET = (ms) => ms == null ? 'n/a' : new Date(Number(ms)).toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true });

// ── snapshot ─────────────────────────────────────────────────────────────────
function snapshot(tfHours = 24) {
  return withDb((db) => {
    const cfg = (k) => { const r = db.prepare('SELECT value FROM config WHERE key=?').get(k); return r ? r.value : null; };
    const cut = tfCut(tfHours);
    const settled = db.prepare(`SELECT * FROM trades WHERE strategy='${STRATEGY}' AND correct IS NOT NULL ORDER BY created_at`).all();
    const openTrades = db.prepare(`SELECT * FROM trades WHERE strategy='${STRATEGY}' AND correct IS NULL ORDER BY created_at DESC`).all();
    const recentTrades = db.prepare(`SELECT * FROM trades WHERE strategy='${STRATEGY}' AND created_at >= ? ORDER BY created_at DESC LIMIT ?`).all(cut, TF_ROW_CAP);
    const tradesWindowN = db.prepare(`SELECT COUNT(*) c FROM trades WHERE strategy='${STRATEGY}' AND created_at >= ?`).get(cut).c;
    const recentDecisions = db.prepare('SELECT * FROM decisions WHERE ts >= ? ORDER BY ts DESC LIMIT ?').all(cut, TF_ROW_CAP);
    const decisionsWindowN = db.prepare('SELECT COUNT(*) c FROM decisions WHERE ts >= ?').get(cut).c;
    const firstBetTs = db.prepare(`SELECT MIN(created_at) m FROM trades WHERE strategy='${STRATEGY}'`).get().m;
    const lastOrder = db.prepare('SELECT * FROM orders ORDER BY id DESC LIMIT 1').get();
    const lastFill = db.prepare('SELECT * FROM fills ORDER BY id DESC LIMIT 1').get();
    const lastSignalDec = db.prepare("SELECT * FROM decisions WHERE decision IN ('TRADE','DRY_RUN') OR reason LIKE 'rules failed%' ORDER BY ts DESC LIMIT 1").get();
    const lastHeartbeat = db.prepare('SELECT * FROM heartbeat ORDER BY id DESC LIMIT 1').get();

    const dayStartET = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
    dayStartET.setHours(0, 0, 0, 0);
    // Convert the ET midnight back to a real epoch: take now minus the ET time-of-day.
    const nowEt = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const todayStartMs = Date.now() - (nowEt.getTime() - dayStartET.getTime());
    const todays = db.prepare(`SELECT * FROM trades WHERE strategy='${STRATEGY}' AND created_at >= ?`).all(todayStartMs);

    const wins = settled.filter((b) => b.correct === 1);
    const losses = settled.filter((b) => b.correct === 0);
    const net = settled.reduce((a, b) => a + (b.net_pnl ?? 0), 0);
    const gross = settled.reduce((a, b) => a + (b.gross_pnl ?? 0), 0);
    const fees = settled.reduce((a, b) => a + (b.fee_amount ?? 0), 0)
      + openTrades.reduce((a, b) => a + (b.fee_amount ?? 0), 0);
    const sumWin = wins.reduce((a, b) => a + (b.net_pnl ?? 0), 0);
    const sumLossAbs = Math.abs(losses.reduce((a, b) => a + (b.net_pnl ?? 0), 0));

    let lastDecision = cfg('k6_last_decision') ?? 'none';
    try { const d = JSON.parse(lastDecision); lastDecision = `${d.decision}: ${d.reason}`; } catch { /* plain string */ }

    return {
      armed: cfg('k6_live_trading_armed') === 'ARMED',
      halted: cfg('k6_halt') === '1',
      haltReason: cfg('k6_halt_reason') ?? '',
      stake: Number(cfg('k6_stake_dollars') ?? 5),
      stopLoss: cfg('k6_stop_loss_dollars') != null ? Number(cfg('k6_stop_loss_dollars')) : null,
      balance: cfg('k6_last_balance') != null ? Number(cfg('k6_last_balance')) : null,
      balanceTs: cfg('k6_last_balance_ts') != null ? Number(cfg('k6_last_balance_ts')) : null,
      sessionStartBalance: cfg('k6_session_start_balance') != null ? Number(cfg('k6_session_start_balance')) : null,
      startTs: Number(cfg('k6_start_ts') ?? Date.now()),
      target: Number(cfg('k6_target_trades') ?? 120),
      heartbeat: lastHeartbeat ?? null,
      lastAuditTs: cfg('k6_last_audit_ts') != null ? Number(cfg('k6_last_audit_ts')) : null,
      marketTicker: cfg('k6_last_market_ticker') ?? 'none yet',
      lastDecision,
      lastSignal: lastSignalDec ?? null,
      lastOrder: lastOrder ?? null,
      lastFill: lastFill ?? null,
      openTrades,
      recentTrades,
      recentDecisions,
      tradesWindowN, decisionsWindowN, firstBetTs,
      todaysN: todays.length,
      todaysNet: todays.reduce((a, b) => a + (b.net_pnl ?? 0), 0),
      settledN: settled.length,
      openN: openTrades.length,
      winsN: wins.length,
      wr: settled.length ? (wins.length / settled.length) * 100 : 0,
      net, gross, fees,
      avgWin: wins.length ? sumWin / wins.length : 0,
      avgLoss: losses.length ? -(sumLossAbs / losses.length) : 0,
      profitFactor: sumLossAbs > 0 ? sumWin / sumLossAbs : (sumWin > 0 ? Infinity : 0),
    };
  });
}

// Equity rows are only written at pre_trade and post_settlement, so between trades
// the series flatlines at the last settled balance and misses anything that moves the
// account outside a trade — a deposit, a withdrawal, a manual bet. That is what made
// the chart disagree with the live balance after a deposit landed 36h past the last
// trade (the deposit, less Kalshi's fee, moved the account with no ledger row). Cap
// the series with the audit's
// live balance so the right-hand end of the line always equals the real account.
function equity() {
  return withDb((db) => {
    const rows = db.prepare('SELECT ts, balance FROM equity ORDER BY ts').all();
    const m = new Map();
    for (const r of rows) m.set(Math.floor(r.ts / 1000), r.balance);
    try {
      const raw = db.prepare("SELECT value FROM config WHERE key='k6_last_audit'").get();
      const a = raw ? JSON.parse(raw.value) : null;
      if (a && Number.isFinite(a.liveBalance) && Number.isFinite(a.ts)) {
        const t = Math.floor(a.ts / 1000);
        const lastT = m.size ? Math.max(...m.keys()) : -Infinity;
        if (t >= lastT) m.set(t, a.liveBalance);
      }
    } catch { /* audit unreadable — fall back to ledger points only */ }
    return [...m.entries()].sort((a, z) => a[0] - z[0]).map(([time, value]) => ({ time, value }));
  });
}

// Cumulative Kalshi fees actually paid, from the first ledger point onward. Fees are
// charged at fill, so each step lands on the trade's entry ts; the series is anchored
// at $0 on the first equity point and carried flat to the latest one so the line spans
// the whole chart.
function fees() {
  return withDb((db) => {
    const bounds = db.prepare('SELECT MIN(ts) AS first, MAX(ts) AS last FROM equity').get();
    const rows = db.prepare(`SELECT ts, fee_amount FROM trades WHERE strategy='${STRATEGY}' AND fee_amount IS NOT NULL ORDER BY ts`).all();
    const m = new Map();
    if (bounds?.first != null) m.set(Math.floor(bounds.first / 1000), 0);
    let cum = 0;
    for (const r of rows) {
      cum += r.fee_amount;
      m.set(Math.floor(r.ts / 1000), Math.round(cum * 10000) / 10000);
    }
    if (bounds?.last != null) {
      const t = Math.floor(bounds.last / 1000);
      if (!m.has(t)) m.set(t, Math.round(cum * 10000) / 10000);
    }
    return [...m.entries()].sort((a, z) => a[0] - z[0]).map(([time, value]) => ({ time, value }));
  });
}

function tradeMarkers() {
  return withDb((db) => {
    const rows = db.prepare(`SELECT target_window_start, correct, avg_fill_price, position_cost FROM trades WHERE strategy='${STRATEGY}' ORDER BY target_window_start`).all();
    return rows.map((r) => ({
      time: Math.floor(r.target_window_start / 1000),
      correct: r.correct,
      price: r.avg_fill_price,
      amount: r.position_cost,
    }));
  });
}

// ── Coinbase candle proxy (public data; same shape the K3 dashboard serves) ──
async function fetchCoinbaseCandles(granularity, days) {
  const end = Math.floor(Date.now() / 1000);
  const maxPer = 300 * granularity;
  const want = Math.floor(days * 86400 / granularity);
  const chunks = [];
  let cursor = end;
  let remaining = want;
  while (remaining > 0) {
    const n = Math.min(remaining, 300);
    const start = cursor - n * granularity;
    const url = `https://api.exchange.coinbase.com/products/ETH-USD/candles?granularity=${granularity}&start=${start}&end=${cursor}`;
    const res = await fetch(url, { headers: { 'User-Agent': 'kronos6-dash' }, signal: AbortSignal.timeout(12000) });
    if (!res.ok) break;
    chunks.push(await res.json());
    cursor = start;
    remaining -= n;
    if (chunks.length > 10) break;
  }
  const rows = chunks.flat()
    .map((r) => ({ time: r[0], low: r[1], high: r[2], open: r[3], close: r[4], volume: r[5] }))
    .sort((a, b) => a.time - b.time);
  const seen = new Set();
  return rows.filter((r) => (seen.has(r.time) ? false : (seen.add(r.time), true)));
}

// ── indicator overlays for the ETH 15m chart ────────────────────────────────
// Read straight out of candle_metrics, which scripts/record-metrics.mjs keeps
// current. Nothing is recomputed here, so the blue/red lines on the chart are
// literally the values stored in the database for backtesting — if the chart
// and a backtest ever disagree, that is a real bug and not a display artifact.
// Rows the recorder has not reached yet simply produce a gap in the line.
function indicators(days) {
  const from = Date.now() - days * 86400_000;
  return withDb((db) => {
    let rows = [];
    try {
      rows = db.prepare(
        `SELECT ts, ema_9d, ema_9c, vwap_session
           FROM candle_metrics
          WHERE ts >= ? AND interval = '15m'
          ORDER BY ts`,
      ).all(from);
    } catch {
      return { ema9d: [], vwap: [], ema9c: [], available: false };
    }
    const line = (key) => rows
      .filter((r) => r[key] != null)
      .map((r) => ({ time: Math.floor(r.ts / 1000), value: r[key] }));
    return {
      ema9d: line('ema_9d'),
      ema9c: line('ema_9c'),
      vwap: line('vwap_session'),
      available: true,
    };
  });
}

// ── page ─────────────────────────────────────────────────────────────────────
function html(s, tfH = 24) {
  const badgeArm = s.armed
    ? '<span class="badge live-danger">ARMED — REAL ORDERS</span>'
    : '<span class="badge paper">UNARMED · DRY RUN</span>';
  const badgeHalt = s.halted ? `<span class="badge halt" title="${esc(s.haltReason)}">HALTED</span>` : '';
  const pf = s.profitFactor === Infinity ? '∞' : num(s.profitFactor, 2);
  const openRow = s.openTrades.length
    ? s.openTrades.map((t) => `<div class="mono">${esc(t.market_ticker)} — ${num(t.contracts, 0)} NO @ ${num(t.avg_fill_price, 4)} (cost $${num(t.position_cost)})${t.partial_fill ? ' <span class="open">partial</span>' : ''}</div>`).join('')
    : '<span class="muted">none</span>';
  const lastOrderTxt = s.lastOrder
    ? `${esc(s.lastOrder.status)} — ${esc(s.lastOrder.market_ticker)} ${s.lastOrder.requested_quantity} NO @ ${num(s.lastOrder.requested_price, 4)} (filled ${num(s.lastOrder.filled_quantity ?? 0, 2)}${s.lastOrder.average_fill_price != null ? ` @ ${num(s.lastOrder.average_fill_price, 4)}` : ''}) ${dtET(s.lastOrder.submitted_at)}`
    : 'none yet';
  const lastFillTxt = s.lastFill
    ? `${num(s.lastFill.count, 2)} @ ${num(s.lastFill.no_price, 4)} NO on ${esc(s.lastFill.market_ticker)} (${esc(s.lastFill.source)}) ${dtET(s.lastFill.observed_at)}`
    : 'none yet';
  const lastSignalTxt = s.lastSignal
    ? `${esc(s.lastSignal.decision)} ${dtET(s.lastSignal.ts)} — ${esc(String(s.lastSignal.reason ?? '').slice(0, 160))}`
    : 'none yet';
  const hbAge = s.heartbeat ? Math.round((Date.now() - s.heartbeat.ts) / 1000) : null;
  const hbTxt = s.heartbeat ? `${esc(s.heartbeat.status)} · ${hbAge}s ago` : 'none';

  const tradeRows = s.recentTrades.length ? s.recentTrades.map((b) => {
    const res = b.correct === null ? '<span class="open">open</span>' : (b.correct === 1 ? '<span class="win">WIN</span>' : '<span class="loss">LOSS</span>');
    const pnl = b.net_pnl == null ? '' : `${b.net_pnl >= 0 ? '+' : ''}$${num(b.net_pnl)}`;
    const after = b.balance_after == null ? '' : `<span class="mono" style="font-weight:700">$${num(b.balance_after)}</span>`;
    const liq = b.liquidity_warning ? ` <span class="open" title="${esc(b.liquidity_warning)}">liq!</span>` : '';
    const part = b.partial_fill ? ' <span class="open">partial</span>' : '';
    return `<tr><td>${dtET(b.created_at)}</td><td class="mono">${esc(b.market_ticker ?? '')}</td><td>DOWN → NO${part}</td><td>${num(b.contracts, 0)}/${b.requested_contracts}</td><td>${num(b.avg_fill_price, 4)}<span class="muted"> ${esc(b.price_source ?? '')}</span>${liq}</td><td>$${num(b.position_cost)}</td><td>$${num(b.fee_amount, 4)}</td><td>${res}</td><td>${pnl}</td><td>${after}</td></tr>`;
  }).join('') : '<tr><td colspan="10" class="muted">No Kronos 6 trades yet.</td></tr>';

  const decisionRows = s.recentDecisions.map((d) =>
    `<tr><td>${dtET(d.ts)}</td><td>${d.decision === 'TRADE' ? '<b style="color:var(--dn)">TRADE</b>' : esc(d.decision)}</td><td>${esc(d.reason ?? '')}</td><td>${num(d.close_pos, 3)}</td><td>${num(d.ema20_slope3, 4)}</td><td>${num(d.ema100_dist, 3)}</td><td>${num(d.selected_exec_price, 3)}</td><td>${num(d.fee_adjusted_ev, 3)}</td></tr>`).join('');

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Kronos 6 — LIVE MONEY</title>
<script src="/vendor/lightweight-charts.js"></script>
<style>
:root{--bg:#f4f6f9;--card:#fff;--bd:#e3e7ec;--ink:#1f2328;--mut:#5b6470;--accent:#dc2626;--up:#1a7f37;--dn:#cf222e}
*{box-sizing:border-box}body{background:var(--bg);color:var(--ink);font:14px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;padding:28px;max-width:1320px;margin:0 auto}
.mono{font-family:ui-monospace,Menlo,Consolas,monospace}h1{font-size:20px;margin:0 0 4px}h2{font-size:16px;margin:0 0 10px}.sub{color:var(--mut);font-size:13px;margin-bottom:18px}.card{background:#fff;border:1px solid var(--bd);border-radius:14px;padding:18px 20px;margin-bottom:18px;box-shadow:0 1px 3px rgba(16,24,40,.04)}.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:14px}.grid6{display:grid;grid-template-columns:repeat(6,1fr);gap:14px}.stat{background:#fafbfc;border:1px solid var(--bd);border-radius:10px;padding:14px}.muted{color:var(--mut)}.big{font-size:28px;font-weight:700}.mid{font-size:20px;font-weight:700}.chart{height:320px}.tall{height:420px}table{width:100%;border-collapse:collapse}td,th{text-align:left;padding:7px 8px;border-bottom:1px solid #eef1f4;font-size:13px}th{color:var(--mut);font-size:11px;text-transform:uppercase;letter-spacing:.04em}.win{color:var(--up);font-weight:700}.loss{color:var(--dn);font-weight:700}.open{color:#9a6700;font-weight:700}.row{display:flex;justify-content:space-between;gap:12px;align-items:center;flex-wrap:wrap}.seg{display:inline-flex;background:#eef1f5;border-radius:9px;padding:3px}.seg button{border:0;background:transparent;color:var(--mut);font:600 12px/1 inherit;padding:6px 11px;border-radius:7px;cursor:pointer}.seg button.on{background:#fff;color:var(--ink);box-shadow:0 1px 2px rgba(16,24,40,.12)}.tscroll{overflow-x:auto}
.appbar{display:flex;align-items:center;gap:18px;background:#fff;border:1px solid var(--bd);border-radius:16px;padding:13px 18px;margin:0 0 10px;box-shadow:0 1px 3px rgba(16,24,40,.06);flex-wrap:wrap}
.brand{display:flex;align-items:center;gap:12px}
.brand-mark{width:40px;height:40px;border-radius:11px;background:linear-gradient(135deg,#ef4444,#b91c1c);color:#fff;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:21px;box-shadow:0 3px 8px rgba(220,38,38,.40)}
.brand-title{font-size:18px;font-weight:800;letter-spacing:-.02em;line-height:1.1;color:var(--ink)}
.brand-sub{font-size:10.5px;color:var(--mut);font-weight:700;text-transform:uppercase;letter-spacing:.07em;margin-top:2px}
.spacer{flex:1}
.badge{font-size:11px;font-weight:700;padding:4px 11px;border-radius:20px;text-transform:uppercase;letter-spacing:.04em;white-space:nowrap}
.badge.paper{background:#eef2ff;color:#4338ca;border:1px solid #c7d2fe}
.badge.live-danger{background:#fef2f2;color:#b91c1c;border:1px solid #fecaca}
.badge.halt{background:#fffbeb;color:#92400e;border:1px solid #fde68a}
.live-banner{background:#fff;color:var(--ink);border:1px solid var(--bd);border-radius:10px;padding:12px 16px;margin-bottom:18px;font-weight:800;letter-spacing:.02em;font-size:15px;box-shadow:0 1px 3px rgba(16,24,40,.04)}
.live-banner .sub2{display:block;font-weight:600;font-size:12px;color:var(--mut);margin-top:3px}
.kv{display:grid;grid-template-columns:repeat(3,1fr);gap:10px 22px}.kv div{font-size:13px}.kv .k{color:var(--mut);font-size:11px;text-transform:uppercase;letter-spacing:.04em}
.seg a.segbtn{display:inline-block;color:var(--mut);font:600 12px/1 inherit;padding:6px 11px;border-radius:7px;text-decoration:none}.seg a.segbtn.on{background:#fff;color:var(--ink);box-shadow:0 1px 2px rgba(16,24,40,.12)}.tbox{max-height:520px;overflow:auto}.tbox th{position:sticky;top:0;background:#fff;z-index:1}.lg{display:inline-flex;align-items:center;gap:6px;color:var(--mut);font-size:12px;font-weight:600}.lg i{width:14px;height:3px;border-radius:2px;display:inline-block}
.about p{margin:8px 0;max-width:920px}
.about .stage{border:1px solid var(--bd);border-left:4px solid var(--accent);border-radius:10px;background:#fafbfc;padding:12px 16px;margin:10px 0;max-width:920px}
.about .stage b.t{display:block;margin-bottom:4px}
.about ul{margin:6px 0 2px;padding-left:20px}.about li{margin:4px 0}
@media(max-width:900px){.grid{grid-template-columns:1fr 1fr}.grid6{grid-template-columns:1fr 1fr 1fr}}
</style></head><body>
<header class="appbar">
  <div class="brand">
    <div class="brand-mark">K6</div>
    <div><div class="brand-title">Kronos 6</div><div class="brand-sub">Live Kalshi ETH 15m</div></div>
  </div>
  <div class="spacer"></div>
  <div>${badgeHalt} ${badgeArm} <span class="badge live-danger">LIVE MONEY</span></div>
</header>
<div class="live-banner">LIVE MONEY — this system places REAL orders on a funded Kalshi account when armed.
<span class="sub2">Fixed stake $${num(s.stake)} per trade · frozen Kronos 5 strategy · DOWN only (Kalshi NO) · one trade per 15m window · first bet ${s.firstBetTs ? dtET(s.firstBetTs) : 'none yet'} · all times Eastern · auto-refreshes</span></div>
${s.halted ? `<div class="card" style="border-color:#f59e0b;background:#fffbeb"><b>HALTED:</b> <span class="mono">${esc(s.haltReason)}</span> — new trades are blocked until cleared (scripts/clear-halt.mjs).</div>` : ''}
<div class="card"><div class="grid">
  <div class="stat"><div class="muted">Account Balance (live)</div><div class="big mono">${s.balance != null ? `$${num(s.balance)}` : 'n/a'}</div><div class="muted">as of ${dtET(s.balanceTs)}${s.sessionStartBalance != null ? ` · session start $${num(s.sessionStartBalance)}` : ''}</div></div>
  <div class="stat"><div class="muted">Running Net P/L</div><div class="big mono" style="color:${s.net >= 0 ? 'var(--up)' : 'var(--dn)'}">${s.net >= 0 ? '+' : ''}$${num(s.net)}</div><div class="muted">gross ${s.gross >= 0 ? '+' : ''}$${num(s.gross)} · fees $${num(s.fees)}</div></div>
  <div class="stat"><div class="muted">Win Rate</div><div class="big mono">${num(s.wr, 1)}%</div><div class="muted">${s.winsN}W ${s.settledN - s.winsN}L of ${s.settledN} settled · ${s.openN} open</div></div>
  <div class="stat"><div class="muted">Today</div><div class="big mono">${s.todaysN}</div><div class="muted">trades · net ${s.todaysNet >= 0 ? '+' : ''}$${num(s.todaysNet)}</div></div>
</div></div>
<div class="card"><div class="grid6">
  <div class="stat"><div class="muted">Avg Win</div><div class="mid mono" style="color:var(--up)">+$${num(s.avgWin)}</div></div>
  <div class="stat"><div class="muted">Avg Loss</div><div class="mid mono" style="color:var(--dn)">$${num(s.avgLoss)}</div></div>
  <div class="stat"><div class="muted">Profit Factor</div><div class="mid mono">${pf}</div></div>
  <div class="stat"><div class="muted">Stake / Trade</div><div class="mid mono">$${num(s.stake)}</div><div class="muted">stop-loss floor ${s.stopLoss != null ? `$${num(s.stopLoss)}` : 'none'}</div></div>
  <div class="stat"><div class="muted">Trades Target</div><div class="mid mono">${s.settledN}/${s.target}</div></div>
  <div class="stat"><div class="muted">Heartbeat</div><div class="mid mono" style="font-size:15px">${hbTxt}</div></div>
</div></div>
<div class="card"><h2>Status</h2><div class="kv">
  <div><div class="k">Mode</div><div class="mono">${s.armed ? 'LIVE — ARMED (real orders)' : 'LIVE code, UNARMED (dry-run)'}</div></div>
  <div><div class="k">Current market</div><div class="mono">${esc(s.marketTicker)}</div></div>
  <div><div class="k">Open position</div><div class="mono">${openRow}</div></div>
  <div><div class="k">Last signal</div><div class="mono">${lastSignalTxt}</div></div>
  <div><div class="k">Last order</div><div class="mono">${lastOrderTxt}</div></div>
  <div><div class="k">Last fill</div><div class="mono">${lastFillTxt}</div></div>
  <div><div class="k">Stop-loss floor</div><div class="mono">${s.stopLoss != null ? `$${num(s.stopLoss)} — halts new trading at/below this balance` : 'none set'}</div></div>
  <div><div class="k">Last ledger audit</div><div class="mono">${dtET(s.lastAuditTs)}</div></div>
  <div><div class="k">Started</div><div class="mono">${dtET(s.startTs)}</div></div>
  <div><div class="k">Latest decision</div><div class="mono" style="color:#b91c1c">${esc(s.lastDecision)}</div></div>
</div></div>
<div class="card"><h2>Frozen Strategy (identical to Kronos 5 — live execution only)</h2><div class="kv">
  <div><div class="k">Asset / interval / direction</div><div class="mono">ETH · 15m · DOWN (Kalshi outcome: NO)</div></div>
  <div><div class="k">closePos ≥</div><div class="mono">0.8240</div></div>
  <div><div class="k">ema20Slope3 ≥</div><div class="mono">0.0018</div></div>
  <div><div class="k">ema100Dist ≥</div><div class="mono">0.2474</div></div>
  <div><div class="k">pDown (conservative)</div><div class="mono">0.566</div></div>
  <div><div class="k">Max NO price</div><div class="mono">$0.515</div></div>
  <div><div class="k">Min fee-adjusted EV</div><div class="mono">+0.03</div></div>
  <div><div class="k">Sizing</div><div class="mono">FIXED $${num(s.stake)} per trade (never scales)</div></div>
  <div><div class="k">Entry window</div><div class="mono">first 90s of 15m window · limit orders, 45s fill timeout</div></div>
</div></div>
<div class="card"><div class="row"><h2>Equity (live account balance)</h2><div class="row" style="gap:14px"><span class="lg"><i style="background:#dc2626"></i>Account balance</span></div></div><div id="equity" class="chart" style="position:relative"><div style="position:absolute;right:8px;top:6px;z-index:3;font:700 11px/1 ui-monospace,Menlo,Consolas,monospace;color:#dc2626;background:rgba(255,255,255,.85);padding:3px 6px;border-radius:4px;letter-spacing:.04em;pointer-events:none">BALANCE $ &#9650;</div></div></div>
<div class="card"><div class="row"><h2>ETH 15m Trade Graph</h2><div class="row" style="gap:14px"><span class="lg"><i style="background:#2962FF"></i><span id="emaLbl">9-day EMA</span></span><span class="lg"><i style="background:#E53935"></i>VWAP (UTC session)</span><div class="seg" id="emasel"><button data-e="9d" class="on">9-day</button><button data-e="9c">9-candle</button></div><div class="seg" id="scalesel"><button data-s="overlay" class="on" title="EMA floats on its own scale — always visible and candles keep their shape, but EMA height is not comparable to price">Overlay</button><button data-s="shared" title="EMA shares the price scale — heights comparable to price (crossovers readable), but on short windows the EMA sits low and the candles compress">Shared scale</button></div><div class="seg" id="win"><button data-d="1" class="on">1d</button><button data-d="3">3d</button><button data-d="7">7d</button><button data-d="14">14d</button></div></div></div><div id="tradechart" class="chart tall"></div><div id="msg" class="muted"></div><div class="muted" style="font-size:12px;margin-top:6px">Overlays are read from <span class="mono">candle_metrics</span> &mdash; the same stored values a backtest sees. Instrumentation only: the frozen trading rules use EMA20/EMA100 and are unchanged. VWAP re-anchors at 00:00&nbsp;UTC, so it steps at each day boundary on multi-day views.</div></div>
<div class="card"><div class="row"><h2>Recent Kronos 6 Trades (LIVE)</h2>${tfSeg(tfH)}</div>${tfNote(s.recentTrades.length, s.tradesWindowN)}<div class="tscroll tbox"><table><tr><th>Time</th><th>Market</th><th>Direction</th><th>Filled/Req</th><th>Avg Entry (NO)</th><th>Cost</th><th>Fee</th><th>Result</th><th>Net P/L</th><th>Balance After</th></tr>${tradeRows}</table></div></div>
<div class="card"><div class="row"><h2>Recent Decisions</h2>${tfSeg(tfH)}</div>${tfNote(s.recentDecisions.length, s.decisionsWindowN)}<div class="tscroll tbox"><table><tr><th>Time</th><th>Decision</th><th>Reason</th><th>ClosePos</th><th>EMA20 Slope3</th><th>EMA100 Dist</th><th>NO Price</th><th>EV</th></tr>${decisionRows}</table></div></div>

<div class="card about"><h2>About — How Kronos 6 Decides to Bet</h2>
<p><b>What it bets on.</b> Kalshi runs a market every 15 minutes asking one question: will the price of
Ethereum finish this 15-minute window higher or lower than it started? A contract costs under $1 and pays
exactly $1 if you're right, $0 if you're wrong. Kronos 6 only ever bets one way: <b>DOWN</b> (buying the
Kalshi "NO" side).</p>
<p><b>The core idea.</b> When a price has been climbing hard and fast, the rally is often running out of
buyers &mdash; like a sprinter at the end of a sprint. That moment <i>looks</i> strongest exactly when it's
most likely to stall, so the crowd tends to overpay for "it keeps going up," which makes the "down" side
slightly cheap. We're not predicting a crash &mdash; just a modest lean toward a breather over the next
15 minutes.</p>
<p><b>Every 15 minutes the bot runs this checklist, in order. A single "no" at any stage means no bet.</b></p>

<div class="stage"><b class="t">Stage 1 &mdash; Is it early enough?</b>
We only enter in the <b>first 90 seconds</b> of a new window, judging from the 15-minute candle that just
closed. Our win-rate statistics were measured for bets placed right at the window open &mdash; entering
later means the move we're betting on may have already happened and the price has already adjusted, which
makes it a different bet with unknown odds. Miss the window, skip it.</div>

<div class="stage"><b class="t">Stage 2 &mdash; Does the chart show "exhaustion"? (all three must be true)</b>
<ul>
<li><b>The last candle closed at its very top</b> (top 18% of its 15-minute range) &mdash; buyers were still
shoving the price up at the closing bell. That looks like strength, but statistically it's often the peak:
everyone eager to buy has just bought.</li>
<li><b>The short-term trend is rising</b> (the 20-candle average is sloping up vs 45 minutes ago) &mdash;
this proves there's a real, sustained climb in progress, not just a random blip in a flat market. You can't
have a tired sprinter unless somebody's been sprinting.</li>
<li><b>The price is stretched</b> (at least ~0.25% above its 100-candle, ~25-hour average) &mdash; like a
rubber band pulled well above its home base. Stretched <i>and still accelerating</i> leans toward a snap-back.</li>
</ul>
Each rule alone is weak; together they describe one rare moment: a real rally, stretched thin, that just hit
maximum frenzy. Top speed doesn't last &mdash; and we only need it to slow down for 15 minutes.</div>

<div class="stage"><b class="t">Stage 3 &mdash; Is the price right?</b>
Never pay more than <b>$0.515</b> for a NO contract. Above that, even a good setup doesn't leave enough profit.</div>

<div class="stage"><b class="t">Stage 4 &mdash; Is there enough edge after fees?</b>
From history this setup wins about <b>56.6%</b> of the time (deliberately set below the raw measured rate to
stay conservative). The bot computes the expected profit at the actual market price, subtracts Kalshi's fee,
and requires at least <b>+3 cents per dollar risked</b>. Close-to-fair isn't good enough &mdash; skip.</div>

<div class="stage"><b class="t">Stage 5 &mdash; Can we get filled without chasing?</b>
A limit order is placed at our price &mdash; never "whatever the market asks." If it isn't filled within
<b>45 seconds</b> it's cancelled and we walk away. Chasing a worse price would destroy the edge from Stage 4.</div>

<p><b>Money management.</b> Every bet is a fixed <b>$${num(s.stake)}</b> (as many whole contracts as the stake
covers, fees included &mdash; never scales with winnings).${s.stopLoss != null ? ` If the account balance ever falls to
<b>$${num(s.stopLoss)}</b>, the bot halts itself and won't trade again until a human clears it.` : ''} It also audits its own
books every cycle &mdash; if its ledger disagrees with the real Kalshi balance by more than 50 cents, it halts
on principle.</p>
<p><b>The most important part: it almost always says no.</b> These conditions are rare &mdash; the bot passes on
the vast majority of windows (see the Decisions table above), and has gone days without a single bet when the
market wasn't offering its setup. That's not broken; that's the strategy working. The rules are frozen &mdash;
no tweaking based on a good or bad week &mdash; until ${s.target} settled trades allow an honest judgment.</p>
</div>
<script>
const LWC=window.LightweightCharts, ET='America/New_York';
const fmtAxis=(t)=>new Date(t*1000).toLocaleString('en-US',{timeZone:ET,month:'short',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:true});
const baseOpts={layout:{background:{color:'#fff'},textColor:'#1f2328',fontFamily:'ui-monospace,Menlo,Consolas,monospace'},grid:{vertLines:{color:'#eef1f4'},horzLines:{color:'#eef1f4'}},timeScale:{timeVisible:true,secondsVisible:false,tickMarkFormatter:fmtAxis},autoSize:true};
if(LWC){
 const eq=LWC.createChart(document.getElementById('equity'),baseOpts);
 const area=eq.addAreaSeries({lineColor:'#dc2626',topColor:'rgba(220,38,38,.20)',bottomColor:'rgba(220,38,38,0)',lineWidth:2,priceFormat:{type:'price',precision:2,minMove:.01}});
 eq.applyOptions({leftPriceScale:{visible:false},rightPriceScale:{borderVisible:false,textColor:'#dc2626'}});
 fetch('/api/equity').then(r=>r.json()).then((d)=>{area.setData(d);eq.timeScale().fitContent();});
 const bc=LWC.createChart(document.getElementById('tradechart'),baseOpts);
 const cs=bc.addCandlestickSeries({upColor:'#1a7f37',downColor:'#cf222e',borderVisible:false,wickUpColor:'#1a7f37',wickDownColor:'#cf222e'});
 const lineOpts={lineWidth:2,priceLineVisible:false,crosshairMarkerVisible:false,priceFormat:{type:'price',precision:2,minMove:.01}};
 const emaS=bc.addLineSeries(Object.assign({color:'#2962FF',title:'EMA 9D'},lineOpts));
 // Second EMA series on its OWN price scale. In 'overlay' mode the line floats
 // over the candles at its own vertical scale, so a 9-day EMA sitting 30+ points
 // below price no longer forces the candles to compress. The trade-off is that
 // its height is then NOT comparable to price — shape only, no crossovers.
 const emaOv=bc.addLineSeries(Object.assign({color:'#2962FF',title:'EMA (overlay)',priceScaleId:'emaov',lineStyle:0},lineOpts));
 bc.priceScale('emaov').applyOptions({scaleMargins:{top:.12,bottom:.12}});
 const vwapS=bc.addLineSeries(Object.assign({color:'#E53935',title:'VWAP'},lineOpts));
 // A 9-DAY EMA is 864 15m periods, so on a 1-day view it sits far below price
 // (e.g. EMA ~2398 while candles trade 2422-2459). Without an explicit autoscale
 // the line is clipped off the bottom of the plot area and looks missing.
 // Widen the margins and force the right scale to fit every series.
 bc.priceScale('right').applyOptions({autoScale:true,scaleMargins:{top:.06,bottom:.06}});
 // Chart state is URL-addressable (?d=1|3|7|14&ema=9d|9c&scale=shared|overlay)
 // so a given view can be linked or bookmarked, and so each mode can be loaded
 // fresh rather than only reached by clicking.
 const qp=new URLSearchParams(location.search);
 let days=[1,3,7,14].includes(Number(qp.get('d')))?Number(qp.get('d')):1;
 let emaKind=qp.get('ema')==='9c'?'9c':'9d';
 // Overlay is the DEFAULT. On every window shorter than 14d the 9-day EMA sits
 // below the candles (23 pts below on 1d), so on the shared scale it collapses
 // into an unreadable sliver on the chart floor. Visible-by-default beats
 // price-comparable-by-default; ?scale=shared (or the toggle) gets the strict
 // reading back, and at 14d the EMA falls inside the price range anyway.
 let scaleMode=qp.get('scale')==='shared'?'shared':'overlay';
 const msg=document.getElementById('msg');
 const syncSeg=(id,attr,val)=>document.querySelectorAll('#'+id+' button').forEach(x=>x.classList.toggle('on',x.dataset[attr]===val));
 syncSeg('emasel','e',emaKind); syncSeg('scalesel','s',scaleMode); syncSeg('win','d',String(days));
 function load(fit){Promise.all([fetch('/api/candles?g=900&days='+days).then(r=>r.json()),fetch('/api/trades').then(r=>r.json()),fetch('/api/indicators?days='+days).then(r=>r.json()).catch(()=>({ema9d:[],vwap:[]}))]).then(([rows,trades,ind])=>{cs.setData(rows);cs.setMarkers((trades||[]).map(b=>({time:b.time,position:'aboveBar',color:b.correct===1?'#1a7f37':b.correct===0?'#cf222e':'#d4a017',shape:'arrowDown',text:'DOWN'+(b.correct==null?'':b.correct?' WIN':' LOSS')})));const e=(ind&&(emaKind==='9d'?ind.ema9d:ind.ema9c))||[],v=(ind&&ind.vwap)||[];const ov=scaleMode==='overlay';emaS.setData(ov?[]:e);emaOv.setData(ov?e:[]);vwapS.setData(v);emaS.applyOptions({title:emaKind==='9d'?'EMA 9D':'EMA 9C'});if(fit)bc.timeScale().fitContent();const lbl=emaKind==='9d'?'9-day EMA':'9-candle EMA';document.getElementById('emaLbl').textContent=lbl+(ov?' (overlay scale)':'');const rng=e.length?' · '+lbl+' '+Math.min.apply(null,e.map(p=>p.value)).toFixed(0)+'-'+Math.max.apply(null,e.map(p=>p.value)).toFixed(0):'';msg.textContent=rows.length+' candles · '+(trades||[]).length+' K6 live trades marked · '+e.length+' EMA pts · '+v.length+' VWAP pts'+rng+(ov?' · overlay scale: shape only, height not comparable to price':'')+(e.length?'':' (run scripts/record-metrics.mjs to populate)');});}
 document.querySelectorAll('#scalesel button').forEach(b=>b.addEventListener('click',()=>{document.querySelectorAll('#scalesel button').forEach(x=>x.classList.remove('on'));b.classList.add('on');scaleMode=b.dataset.s;load(true);}));
 document.querySelectorAll('#emasel button').forEach(b=>b.addEventListener('click',()=>{document.querySelectorAll('#emasel button').forEach(x=>x.classList.remove('on'));b.classList.add('on');emaKind=b.dataset.e;load(true);}));
 document.querySelectorAll('#win button').forEach(b=>b.addEventListener('click',()=>{document.querySelectorAll('#win button').forEach(x=>x.classList.remove('on'));b.classList.add('on');days=Number(b.dataset.d);load(true);}));
 load(true); setInterval(()=>load(false),60000);
}
setTimeout(()=>location.reload(),120000);
</script></body></html>`;
}

http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/vendor/lightweight-charts.js') {
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'max-age=86400' });
      res.end(LIB); return;
    }
    if (url.pathname === '/api/status') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(snapshot())); return;
    }
    if (url.pathname === '/api/fees') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(fees())); return;
    }
    if (url.pathname === '/api/equity') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(equity())); return;
    }
    if (url.pathname === '/api/trades') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(tradeMarkers())); return;
    }
    if (url.pathname === '/api/indicators') {
      const days = Math.min(60, Math.max(0.1, Number(url.searchParams.get('days') || 1)));
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(indicators(days))); return;
    }
    if (url.pathname === '/api/candles') {
      const g = Math.max(60, Number(url.searchParams.get('g') || 900));
      const days = Math.min(60, Math.max(0.1, Number(url.searchParams.get('days') || 1)));
      const rows = await fetchCoinbaseCandles(g, days);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(rows)); return;
    }
    const h = parseTfHours(url);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store, must-revalidate' });
    res.end(html(snapshot(h), h));
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'text/plain' }); res.end(`error: ${String(e)}`);
  }
}).listen(PORT, () => console.log(`[K6 DASH] http://localhost:${PORT}  (db: ${DB_PATH})`));
