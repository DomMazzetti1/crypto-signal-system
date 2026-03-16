create table decisions (
  id uuid primary key default gen_random_uuid(),
  snapshot_id uuid references market_snapshots(id),
  alert_id uuid references alerts_raw(id),
  symbol text not null,
  alert_type text not null,
  alert_tf text not null,

  -- decision outcome
  decision text not null, -- 'LONG' | 'SHORT' | 'NO_TRADE'

  -- gate results
  gate_a_passed boolean not null,
  gate_a_quality text,
  gate_b_passed boolean not null,
  gate_b_reason text,

  -- htf trend
  trend_4h text not null,
  trend_1d text not null,
  ema20_4h numeric,
  ema50_4h numeric,
  ema20_1d numeric,
  ema50_1d numeric,
  atr14_1h numeric,
  atr14_4h numeric,

  -- regime
  btc_regime text not null,
  alt_environment text not null,
  btc_atr_ratio numeric,

  -- price levels
  entry_price numeric,
  stop_price numeric,
  tp1_price numeric,
  tp2_price numeric,
  tp3_price numeric,
  risk_amount numeric,
  rr_tp1 numeric,
  rr_tp2 numeric,
  rr_tp3 numeric,

  -- cooldown
  cooldown_active boolean not null default false,

  created_at timestamptz default now()
);

create index idx_decisions_symbol on decisions(symbol);
create index idx_decisions_decision on decisions(decision);
create index idx_decisions_created on decisions(created_at);
