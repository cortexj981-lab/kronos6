# Kronos 6 — LIVE Kalshi execution of the frozen Kronos 5 strategy

**THIS SYSTEM TRADES REAL MONEY WHEN ARMED.**

> **Read this before you clone.** Kronos 6 places real limit orders on
> [Kalshi](https://kalshi.com), a CFTC-regulated US event-contract exchange.
> It is published as an engineering reference, not as investment advice, and
> **its edge has never been demonstrated**: a pre-registered search over 21
> alternative strategies found none that survived correction for multiple
> comparisons. Assume you will lose money. See [LICENSE](LICENSE).
>
> There is no wallet, no seed phrase, no RPC endpoint and no smart contract
> anywhere in this project. It bets on the *price direction* of ETH through a
> regulated exchange account; it never holds cryptocurrency.

**New here? Start with [INSTALL.md](INSTALL.md)** — a clean-machine setup
guide that ends with a dry run and never arms live trading.

Kronos 6 is a controlled evolution of Kronos 5 from paper trading to live
trading. The strategy is **frozen** — identical features, thresholds, timing,
market discovery, EV and fee math. The only functional change: after signal
generation, simulated bets become real Kalshi V2 limit orders.

| | Kronos 5 | Kronos 6 |
|---|---|---|
| Execution | simulated (paper_bets) | **real V2 limit orders** |
| Bankroll | internal SQLite $1,000 | **the real Kalshi account balance** |
| Sizing | 1% of bankroll | **fixed $5.00/trade** (config `k6_stake_dollars`) |
| Settlement money | internal number | **real Kalshi settlement** |
| Dashboard | :3000/kronos5 tab | **own server :3006, LIVE MONEY banner** |

## Safety model

1. **Unarmed by default.** The scanner runs the full pipeline and records
   `DRY_RUN` decisions, but will not POST an order until
   `scripts/arm-live-trading.mjs` is run interactively and the phrase
   `ARM LIVE TRADING` typed. Disarm any time with `disarm-live-trading.mjs`.
2. **Fail-closed startup validation** (credentials, auth, balance, exchange
   status, series fee model, market discovery, permissions, clock skew) —
   any failure keeps the scanner alive but non-trading.
3. **Request gate**: every HTTP request is checked; POST/DELETE are allowed
   only on the single order-create/cancel endpoint; deposits, withdrawals,
   transfers, api_keys, account paths are unreachable by construction.
4. **Halt switch**: ledger audit drift or the operator (`k6_halt=1`) blocks
   new trades; open trades still settle. Clear with `scripts/clear-halt.mjs`.
5. **Duplicate protection**: UNIQUE(strategy, window) on trades + order-intent
   rows written before submission + crash recovery that cancels orphaned
   resting orders on startup.

## Run

```
cd <repo>\scanner
npm install
npm run init-db
npm run test-fees
node --experimental-sqlite --import tsx/esm ..\scripts\connectivity_test.mjs   # read-only, no orders
npm run scan-once                                                              # one tick, UNARMED
pm2 start ..\ecosystem.config.cjs
pm2 save
```

Dashboard: http://localhost:3006

## Arming (the manual last step before real money)

```
cd <repo>\scanner
node --experimental-sqlite ..\scripts\arm-live-trading.mjs
```

## Operator scripts (`scripts/`)

- `arm-live-trading.mjs` — interactive, typed-phrase arming
- `disarm-live-trading.mjs` — immediate disarm (always safe)
- `clear-halt.mjs` — clear an audit halt after investigating
- `set-stake.mjs <dollars>` — change the fixed stake (≤ $25 hard cap)
- `connectivity_test.mjs` — read-only live checks, never places orders

## Credentials

`KalshiAPIKeyFullAccess.txt` (API key ID + PEM private key). Never logged,
never stored in SQLite, git-ignored. Parsed only by `scanner/kalshi-auth.ts`.

See DOCUMENTATION.md for architecture and schema details.
