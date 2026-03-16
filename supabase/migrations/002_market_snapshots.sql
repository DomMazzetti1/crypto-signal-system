create table market_snapshots (
  id uuid primary key default gen_random_uuid(),
  alert_id uuid references alerts_raw(id),
  symbol text not null,
  alert_type text not null,
  alert_tf text not null,

  -- alert original values
  alert_price numeric,
  alert_rsi numeric,
  alert_adx1h numeric,
  alert_adx4h numeric,
  alert_bb_width numeric,

  -- ticker data
  mark_price numeric,
  index_price numeric,
  funding_rate numeric,
  next_funding_time timestamptz,
  open_interest numeric,
  open_interest_value numeric,
  turnover_24h numeric,
  bid1_price numeric,
  ask1_price numeric,

  -- orderbook derived
  spread_bps numeric,
  book_depth_bid_usd numeric,
  book_depth_ask_usd numeric,
  orderbook_ts bigint,

  -- open interest deltas (percent change)
  oi_delta_5m numeric,
  oi_delta_15m numeric,
  oi_delta_1h numeric,

  -- taker flow placeholders
  taker_buy_usd_1h numeric,
  taker_sell_usd_1h numeric,
  taker_imbalance_1h numeric,
  flow_quality text not null default 'missing',

  -- gate a quality
  snapshot_quality text not null default 'low',
  gate_a_passed boolean not null default false,
  gate_a_reject_reason text,

  created_at timestamptz default now()
);

create index idx_snapshots_symbol on market_snapshots(symbol);
create index idx_snapshots_created on market_snapshots(created_at);
