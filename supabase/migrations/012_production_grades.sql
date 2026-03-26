-- Grading outcomes for accepted production trades.
-- Separate table to avoid mutating the immutable decisions table.
-- Graded by the same 48-forward-bar approach used for shadow signals.

create table production_signal_grades (
  id uuid primary key default gen_random_uuid(),
  decision_id uuid not null unique,
  symbol text not null,
  alert_type text not null,
  decision text not null,
  btc_regime text,
  created_at timestamptz not null default now(),

  -- Grading inputs (copied from decision for self-contained grading)
  entry_price numeric not null,
  stop_price numeric not null,
  tp1_price numeric,
  atr14_1h numeric,

  -- Grading outputs
  grade_status text not null default 'PENDING',
  graded_at timestamptz,
  outcome_r numeric,
  hit_tp1 boolean default false,
  hit_tp2 boolean default false,
  hit_tp3 boolean default false,
  hit_sl boolean default false,
  bars_to_resolution int,
  max_favorable numeric,
  max_adverse numeric,

  constraint chk_grade_status check (grade_status in ('PENDING', 'GRADED', 'FAILED'))
);

create index idx_prod_grades_status on production_signal_grades (grade_status);
create index idx_prod_grades_symbol on production_signal_grades (symbol);
create index idx_prod_grades_decision_id on production_signal_grades (decision_id);
