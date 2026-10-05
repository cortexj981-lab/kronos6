# Kronos 6 v1 — Documentation

Implemented 2026-07-12. LIVE-trading evolution of Kronos 5; strategy frozen.

## Architecture

```
C:\Claude\Kronos6\
├── KalshiAPIKeyFullAccess.txt   full-access live key (git-ignored, never logged)
├── ecosystem.config.cjs         PM2: kronos6-scanner + kronos6-dashboard
├── db\
│   ├── init.sql                 schema (below)
│   └── kronos6.db               ledger (git-ignored)
├── scanner\                     Node 25 + tsx, node:sqlite — Kronos 5 layout
│   ├── config.ts                frozen constants + request gate + arming values
│   ├── strategy.ts              features/rules — byte-for-byte Kronos 5
│   ├── indicators.ts  candles.ts  fees.ts  ev.ts  types.ts  log.ts
│   ├── kalshi-auth.ts           RSA-PSS signing (same scheme as K5)
│   ├── kalshi-client.ts         live client; EVERY request passes assertAllowedRequest()
│   ├── kalshi-markets.ts        discovery + NO-quote (identical to K5)
│   ├── sizing.ts                fixed-$ stake -> integer contracts (fees inside stake)
│   ├── execution.ts             V2 limit orders, fill polling, timeout-cancel, crash recovery
│   ├── validate.ts              8-point fail-closed startup validation
│   ├── resolver.ts              live settlement (Kalshi result only; Coinbase = metadata)
│   ├── reconciler.ts            balance-vs-ledger audit; drift > $0.50 => halt
│   └── index.ts                 main loop (15s poll)
├── dashboard\server.mjs         LIVE MONEY dashboard on :3006 (reads db read-only)
└── scripts\                     arm / disarm / clear-halt / set-stake / connectivity_test
```

## Execution flow (per tick)

resolve settlements → audit (15 min) → validation gate → window gates (first
90 s only) → duplicate guards (trades UNIQUE + order-intent rows) → Coinbase
signal candle → frozen rules → market discovery (close_ts pinning) → live NO
quote (book ask = 1 − best YES bid) → MAX_NO_PRICE 0.515 → EV > 0.03 → halt
check → live balance → fixed-$5 sizing → **ARMING GATE** → V2 limit order
(side='ask' yes@1−price, GTC, 45 s timeout-cancel) → trade row from ACTUAL
fills → settlement when Kalshi publishes the result.

## Order lifecycle states

`pending_submit → resting → executed | partial | canceled | rejected | submit_failed`.
Intent is written BEFORE the POST; `recoverOrphanOrders()` reconciles any
non-terminal order at startup (cancels resting remainders, adopts fills,
flags fills-without-trade-row for the operator).

## P/L definitions

- `position_cost` = filled contracts × NO VWAP (actual, from fills)
- `settlement_revenue` = contracts × $1.00 on win, $0 on loss
- `gross_pnl` = revenue − position_cost; `net_pnl` = gross − actual entry fees
- Equity = live account balance snapshots (`equity` table); audit reconciles
  balance vs. session start + Σ net_pnl − open exposure.

## Config keys (db.config)

`k6_live_trading_armed` (unarmed|ARMED), `k6_halt`, `k6_halt_reason`,
`k6_stake_dollars` (default 5.00, hard cap 25), `k6_session_start_balance`,
`k6_last_balance`, `k6_last_decision`, `k6_last_market_ticker`,
`k6_heartbeat_ts`, `k6_start_ts`, `k6_target_trades`.

## Deviations from Kronos 5 (all required by live trading)

1. Fixed $5 stake (prompt requirement) instead of 1% bankroll; integer
   contracts (exchange requirement) sized so cost+fee ≤ stake and ≤ balance.
2. No Coinbase settlement fallback for money — real money settles only on the
   official Kalshi result; Coinbase direction is recorded as research metadata.
3. Request gate is an allowlist (K5's was GET-only); POST/DELETE only on the
   V2 order endpoints.
4. Clock-skew estimate uses a median of the last 5 response Date headers
   (a single stale header produced a false validation failure in testing).
5. Dashboard is its own server on :3006 (prompt requirement) rather than a tab
   in the shared :3000 dashboard.

## Known gotchas inherited from K5 notes

- V1 `POST /portfolio/orders` is deprecated (410) — V2
  `POST /portfolio/events/orders` used exclusively; YES-side quoting
  (`side:'ask'` at 1−noPrice opens NO); count/price are fixed-point strings.
- Market discovery must pin `min_close_ts = max_close_ts = window end`
  (the `status=open` filter is laggy and returned stale markets).
- Books return bids only: executable NO ask = 1 − best YES bid.
- `average_fill_price` on the V2 response is YES-side VWAP (converted);
  polled orders report our-side cost directly.

## Audit-drift incidents (false halts) and their fixes

The ledger audit is fail-closed: expected balance = session start + Σ settled
net P/L − open exposure, and a drift over $0.50 halts new trades. Three false
halts have come from settlement timing, none from real ledger corruption.

1. **2026-07-15 — session-baseline bug.** A balance observed after trades
   already existed was stored as the session start, double-counting past P/L.
   Fixed by `reconstructSessionStart()`, which backs the existing ledger out of
   an observed balance.
2. **2026-07-30 — Kalshi credits late.** Trade #74's $20 payout landed after
   the audit read → phantom −$20.02 drift. Fixed by requiring the breach to
   persist through `DRIFT_RECHECKS` re-reads of the live balance.
3. **2026-08-19 — our ledger closes late (mirror of #2).** Trade #143's window
   closed at 12:30:00; Kalshi credited the $1.91 payout at 12:30:02, but the
   trade was still open in our ledger, so live exceeded expected by $1.86. The
   recheck loop could not heal it: `resolveTrades()` is what closes a trade
   internally, and it runs in the same single-threaded tick that the recheck
   loop blocks with `sleep()`. The four rechecks re-read only the balance, the
   halt fired at 12:32:18, and the resolver settled the trade at 12:32:33 — on
   the first tick after the audit released the loop. Fixed by calling
   `resolveTrades()` at the top of each recheck iteration in `reconciler.ts`,
   so our ledger can catch up while we wait. Note the audit interval
   (15 min) aligns with the 15-minute market windows, so the audit reads
   at roughly the worst possible moment — just after a window closes; the
   settle path normally completes ~95–155s after close (`SETTLE_BUFFER_MS`
   is 90s), which straddles the old 120s recheck window.
