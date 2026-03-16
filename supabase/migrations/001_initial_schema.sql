create table universe (
  symbol text primary key,
  status text not null,
  launch_time timestamptz,
  turnover_24h numeric,
  open_interest numeric,
  spread_bps numeric,
  is_eligible boolean not null default false,
  last_checked_at timestamptz,
  updated_at timestamptz default now()
);

create table alerts_raw (
  id uuid primary key default gen_random_uuid(),
  payload jsonb not null,
  received_at timestamptz default now(),
  processed boolean default false
);
