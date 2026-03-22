-- Aggregated near-miss diagnostics per scanner run.
-- One row per run. All per-condition detail stored as compact JSONB.
-- Designed for lightweight analysis without bloating row count.

create table near_miss_scans (
  id uuid primary key default gen_random_uuid(),
  scanned_at timestamptz default now(),
  candle_bucket timestamptz not null,
  symbols_evaluated int not null,

  -- Per-setup: how many symbols reached each pass count (histogram).
  -- e.g. {"MR_LONG": {"5": 12, "6": 3, "7": 1}, ...}
  pass_count_histograms jsonb not null default '{}',

  -- Per-setup, per-condition: how many symbols failed this condition.
  -- e.g. {"MR_LONG": {"adx_1h_lt_18": 38, "rsi_lt_29": 42}, ...}
  condition_fail_counts jsonb not null default '{}',

  -- Per-setup, per-condition: how many symbols passed this condition.
  condition_pass_counts jsonb not null default '{}',

  -- Per-setup: first_fail frequency (which condition blocks most often).
  -- e.g. {"MR_LONG": {"rsi_lt_29": 20, "adx_1h_lt_18": 15}, ...}
  first_fail_counts jsonb not null default '{}',

  -- Key metric distributions for blocking conditions (compact percentiles).
  -- e.g. {"adx_1h": {"p10": 14, "p25": 19, "p50": 25, "p75": 32, "p90": 40, "min": 8, "max": 55}, ...}
  metric_distributions jsonb not null default '{}',

  -- Best near-miss per setup this run (highest pass_count that didn't fully pass).
  -- e.g. [{"setup_type": "MR_LONG", "symbol": "ETHUSDT", "passed": 6, "total": 8, "first_fail": "adx_1h_lt_18", "metrics": {...}}]
  best_near_misses jsonb not null default '[]'
);

create index idx_near_miss_scans_scanned_at on near_miss_scans (scanned_at);
