-- Kronos 6 v1 schema (LIVE trading — completely isolated from Kronos 3/4/5).
-- No credentials or auth material are ever stored here.
-- Everything needed to reconstruct trading history lives in these tables.

-- Every scan decision: BLOCK (a gate failed), DRY_RUN (signal fired but live
-- trading is not armed), TRADE (a live order was submitted).
CREATE TABLE IF NOT EXISTS decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  target_window_start INTEGER,
  target_window_end INTEGER,
  decision TEXT NOT NULL,              -- BLOCK | DRY_RUN | TRADE
  reason TEXT,
  close_pos REAL,
  ema20_slope3 REAL,
  ema100_dist REAL,
  p_down REAL,
  kalshi_series_ticker TEXT,
  kalshi_event_ticker TEXT,
  kalshi_market_ticker TEXT,
  yes_bid REAL,
  yes_ask REAL,
  no_bid REAL,
  no_ask REAL,
  selected_exec_price REAL,
  spread REAL,
  available_size REAL,
  estimated_fee REAL,
  fee_adjusted_ev REAL,
  market_data_ts INTEGER
);
CREATE INDEX IF NOT EXISTS idx_k6_decisions_ts ON decisions(ts);

-- Live orders: local intent is recorded BEFORE submission (restart-safe
-- duplicate prevention), then updated from V2 responses and order polling.
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  local_order_uuid TEXT NOT NULL UNIQUE,
  client_order_id TEXT NOT NULL UNIQUE,
  kalshi_order_id TEXT,
  trade_id INTEGER,                    -- FK -> trades.id (set after trade row exists)
  market_ticker TEXT NOT NULL,
  target_window_start INTEGER,
  strategy_direction TEXT NOT NULL,    -- DOWN
  kalshi_outcome TEXT NOT NULL,        -- no
  action TEXT NOT NULL,                -- buy (conceptual; submitted as V2 YES-side ask)
  order_type TEXT NOT NULL,            -- limit
  time_in_force TEXT,                  -- good_till_canceled (+45s local timeout-cancel)
  requested_price REAL NOT NULL,       -- NO-side limit price (dollars)
  requested_yes_price REAL,            -- 1 - requested_price, as submitted to V2
  requested_quantity INTEGER NOT NULL, -- integer contracts
  filled_quantity REAL,
  average_fill_price REAL,             -- NO-side VWAP (dollars)
  status TEXT NOT NULL,                -- pending_submit | resting | executed | partial | canceled | rejected | submit_failed
  purpose TEXT NOT NULL DEFAULT 'strategy',
  estimated_fee REAL,
  actual_fee REAL,
  fill_cost REAL,                      -- our-side dollars actually spent on fills
  submitted_at INTEGER,
  closed_at INTEGER,                   -- when the order reached a terminal state
  updated_at INTEGER,
  canceled_by_us INTEGER,              -- 1 when our timeout-cancel ended it
  raw_error_code TEXT,
  raw_error_message TEXT
);
CREATE INDEX IF NOT EXISTS idx_k6_orders_market ON orders(market_ticker);
CREATE INDEX IF NOT EXISTS idx_k6_orders_window ON orders(target_window_start);

-- Individual fills (from the V2 immediate-fill response and order polling;
-- reconciled against GET /portfolio/fills when available).
CREATE TABLE IF NOT EXISTS fills (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_row_id INTEGER NOT NULL,       -- FK -> orders.id
  kalshi_order_id TEXT,
  kalshi_trade_id TEXT,                -- exchange fill/trade id when known
  market_ticker TEXT NOT NULL,
  count REAL NOT NULL,                 -- contracts in this fill observation
  no_price REAL,                       -- NO-side price (dollars)
  yes_price REAL,                      -- YES-side price (dollars)
  fee REAL,                            -- fee attributed to this observation
  is_taker INTEGER,
  source TEXT NOT NULL,                -- v2_response | order_poll | fills_api
  observed_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_k6_fills_order ON fills(order_row_id);

-- One row per strategy trade (= per 15m window; UNIQUE index enforces the
-- one-trade-per-window rule). This is the live analog of Kronos 5 paper_bets:
-- same signal snapshot columns, but economics come from REAL fills and REAL
-- settlement. A trade row is created only after a nonzero fill exists.
CREATE TABLE IF NOT EXISTS trades (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,                 -- trade creation time
  strategy TEXT NOT NULL DEFAULT 'kronos6_down_exhaustion_15m_live_v1',
  symbol TEXT NOT NULL DEFAULT 'ETHUSD',
  interval TEXT NOT NULL DEFAULT '15m',
  strategy_direction TEXT NOT NULL DEFAULT 'DOWN',
  kalshi_outcome TEXT NOT NULL DEFAULT 'no',
  target_window_start INTEGER NOT NULL,
  target_window_end INTEGER NOT NULL,
  event_ticker TEXT,
  market_ticker TEXT NOT NULL,
  order_row_id INTEGER,                -- FK -> orders.id (entry order)
  -- signal snapshot
  p_down REAL NOT NULL,
  close_pos REAL,
  ema20_slope3 REAL,
  ema100_dist REAL,
  -- live-market snapshot at entry
  limit_price REAL NOT NULL,           -- NO limit price submitted
  price_source TEXT,                   -- orderbook | market_quote
  yes_bid REAL, yes_ask REAL, no_bid REAL, no_ask REAL,
  book_no_ask REAL,
  book_size REAL,
  spread REAL,
  liquidity_warning TEXT,
  market_data_ts INTEGER,
  -- REAL economics (from fills)
  intended_stake REAL NOT NULL,        -- configured fixed dollar stake
  contracts REAL NOT NULL,             -- contracts actually filled
  requested_contracts INTEGER NOT NULL,
  avg_fill_price REAL NOT NULL,        -- NO-side VWAP actually paid
  position_cost REAL NOT NULL,         -- contracts * avg_fill_price
  fee_amount REAL,                     -- actual fees paid on entry
  fee_adjusted_ev REAL,                -- EV at decision time
  partial_fill INTEGER NOT NULL DEFAULT 0,
  balance_before REAL,                 -- live Kalshi balance before submission
  balance_after REAL,                  -- live Kalshi balance after settlement
  -- settlement
  kalshi_result TEXT,                  -- yes | no
  coinbase_comparison_result TEXT,     -- UP | DOWN (research metadata only)
  correct INTEGER,                     -- 1 win / 0 loss
  settlement_revenue REAL,             -- dollars credited by Kalshi at settlement
  gross_pnl REAL,                      -- settlement_revenue - position_cost
  net_pnl REAL,                        -- gross_pnl - fee_amount
  settlement_source TEXT,              -- kalshi_live | kalshi_settlements
  created_at INTEGER NOT NULL,
  settled_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_k6_trades_strategy_target
  ON trades(strategy, target_window_start);
CREATE INDEX IF NOT EXISTS idx_k6_trades_created ON trades(created_at);

-- Raw account settlements pulled from GET /portfolio/settlements — the
-- exchange's own record, kept verbatim for reconciliation.
CREATE TABLE IF NOT EXISTS settlements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  market_ticker TEXT NOT NULL,
  market_result TEXT,
  revenue REAL,
  fee_cost REAL,
  no_count REAL,
  no_total_cost REAL,
  settled_time TEXT,
  fetched_at INTEGER NOT NULL,
  UNIQUE(market_ticker, settled_time)
);

-- Equity snapshots: the live Kalshi balance over time (heartbeats, entries,
-- settlements). The account balance is the authoritative equity — there is
-- no internal bankroll in Kronos 6.
CREATE TABLE IF NOT EXISTS equity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  balance REAL NOT NULL,               -- dollars, from GET /portfolio/balance
  source TEXT NOT NULL                 -- startup | heartbeat | pre_trade | post_settlement
);
CREATE INDEX IF NOT EXISTS idx_k6_equity_ts ON equity(ts);

-- Scanner heartbeat/status history.
CREATE TABLE IF NOT EXISTS heartbeat (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  status TEXT NOT NULL,                -- ok | validation_failed | halted
  armed INTEGER NOT NULL,              -- 1 live trading armed / 0 unarmed
  balance REAL,
  message TEXT
);
CREATE INDEX IF NOT EXISTS idx_k6_heartbeat_ts ON heartbeat(ts);

CREATE TABLE IF NOT EXISTS config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
