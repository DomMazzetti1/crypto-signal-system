-- Daily rollup of SQ_SHORT ADX shadow experiment results.
-- One row per day, upserted by the daily rollup endpoint.

create table shadow_daily_summary (
  date date primary key,
  total_rows int not null default 0,
  graded_rows int not null default 0,
  strict_count int not null default 0,
  strict_win_rate numeric,
  strict_avg_r numeric,
  baseline_count int not null default 0,
  baseline_win_rate numeric,
  baseline_avg_r numeric,
  decision text not null default 'insufficient data',
  created_at timestamptz not null default now()
);
