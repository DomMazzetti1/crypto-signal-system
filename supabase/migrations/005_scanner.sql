create table scanner_runs (
  id uuid primary key default gen_random_uuid(),
  started_at timestamptz default now(),
  completed_at timestamptz,
  symbols_scanned int,
  candidates_found int,
  candidates_queued int,
  symbol_errors jsonb,
  runtime_ms int,
  status text
);

create table candle_signals (
  id uuid primary key default gen_random_uuid(),
  symbol text not null,
  setup_type text not null,
  candle_start_time timestamptz not null,
  created_at timestamptz default now(),
  unique(symbol, setup_type, candle_start_time)
);
