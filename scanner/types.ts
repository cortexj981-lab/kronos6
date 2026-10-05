export interface Candle {
  ts: number; // Unix epoch ms UTC, candle open time
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface Features {
  closePos: number;
  ema20Slope3: number;
  ema100Dist: number;
}

export interface KalshiMarket {
  ticker: string;
  event_ticker: string;
  status: string;
  open_time: string;
  close_time: string;
  expected_expiration_time?: string | null;
  result: 'yes' | 'no' | 'scalar' | '';
  yes_bid_dollars: string;
  yes_ask_dollars: string;
  no_bid_dollars: string;
  no_ask_dollars: string;
  yes_bid_size_fp?: string;
  yes_ask_size_fp?: string;
  floor_strike?: number | null;
  strike_type?: string;
  settlement_value_dollars?: string | null;
  settlement_ts?: string | null;
  rules_primary?: string;
  /** Exchange shard this market trades on (Kalshi exchange sharding, Aug 2026). */
  exchange_index?: number;
}

export interface KalshiOrder {
  order_id: string;
  client_order_id: string;
  ticker: string;
  side?: 'yes' | 'no';
  action?: 'buy' | 'sell';
  outcome_side?: 'yes' | 'no';
  type: 'limit' | 'market';
  status: 'resting' | 'canceled' | 'executed';
  yes_price_dollars: string;
  no_price_dollars: string;
  fill_count_fp: string;
  remaining_count_fp: string;
  initial_count_fp: string;
  taker_fees_dollars: string;
  maker_fees_dollars: string;
  taker_fill_cost_dollars: string;
  maker_fill_cost_dollars: string;
  created_time?: string | null;
  last_update_time?: string | null;
}

export interface KalshiFill {
  trade_id?: string;
  fill_id?: string;
  order_id: string;
  ticker: string;
  side?: string;
  action?: string;
  count?: number;
  count_fp?: string;
  yes_price?: number;
  no_price?: number;
  yes_price_dollars?: string;
  no_price_dollars?: string;
  is_taker?: boolean;
  created_time?: string;
}

export interface NoQuote {
  /** Executable NO price chosen for the live limit order. */
  execPrice: number;
  /** Where execPrice came from: live order book, or the market-object quote. */
  priceSource: 'orderbook' | 'market_quote';
  /** NO ask derived from best YES bid (1 - yesBid), when a book exists. */
  bookNoAsk: number | null;
  /** Contracts available at that book level (null when book empty). */
  size: number | null;
  /** Market-object top-of-book fields (for the record). */
  yesBid: number | null;
  yesAsk: number | null;
  noBid: number | null;
  noAsk: number | null;
  /** Liquidity problem description — recorded as metadata. */
  warning: string | null;
  /** Timestamp (ms) when this quote was read. */
  ts: number;
}
