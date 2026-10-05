// PM2 configuration for Kronos 6 (LIVE Kalshi trading).
//
// PATHS ARE RESOLVED AT RUNTIME, so this file works from wherever you cloned
// the repository - there is nothing to edit before `pm2 start`.
//   __dirname         -> this repo's folder
//   process.execPath  -> the node.exe PM2 itself is running under
// (The original ran from a fixed C:\Claude\Kronos6 and hardcoded both.)
//
// NOTE: the scanner starts UNARMED — it validates, scans, and records DRY_RUN
// decisions but places no orders until scripts/arm-live-trading.mjs is run by
// a human.
const path = require('node:path');

const ROOT = __dirname;
const NODE = process.execPath;

/** One app entry, with logs written next to the code it runs. */
function app(name, cwd, args) {
  const dir = path.join(ROOT, cwd);
  return {
    name,
    script: NODE,
    args,
    interpreter: 'none',
    cwd: dir,
    watch: false,
    autorestart: true,
    max_restarts: 10,
    restart_delay: 5000,
    windowsHide: true,
    merge_logs: true,
    out_file: path.join(dir, `${cwd}.log`),
    error_file: path.join(dir, `${cwd}.err`),
  };
}

module.exports = {
  apps: [
    app('kronos6-scanner', 'scanner', '--experimental-sqlite --import tsx/esm index.ts'),

    // Instrumentation recorder: 9-day EMA + UTC-session VWAP into the
    // candle_metrics table. Deliberately a separate process from the scanner
    // so it can never add latency or a failure mode to a live-money scan.
    // It writes only candle_metrics; nothing reads it to make a trade.
    {
      ...app('kronos6-metrics', 'scripts', '--experimental-sqlite record-metrics.mjs'),
      restart_delay: 15000,
    },

    app('kronos6-dashboard', 'dashboard', '--experimental-sqlite server.mjs'),
  ],
};
