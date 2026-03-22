-- External signal forward-testing subsystem.
-- Tracks signals from external Telegram channels, grades them against
-- actual price action, and supports a pending confirm/cancel flow
-- before committing signals to the main table.

-- ═══════════════════════════════════════════════════════════════════
-- 1. external_signals — immutable record of each external signal
-- ═══════════════════════════════════════════════════════════════════

create table external_signals (
  id uuid primary key default gen_random_uuid(),

  -- ── Source / raw data (immutable after insert) ──────────────
  source text not null,
  source_message_id text,
  raw_text text,

  -- ── Parsed signal details ──────────────────────────────────
  symbol text not null,
  direction text not null,
  entry_price numeric,
  entry_low numeric,
  entry_high numeric,
  sl numeric not null,
  tp1 numeric,
  tp2 numeric,
  tp3 numeric,

  -- ── Timestamps ─────────────────────────────────────────────
  posted_at timestamptz not null,
  created_at timestamptz not null default now(),

  -- ── Market context at time of post ─────────────────────────
  actual_market_price_at_post numeric,
  last_closed_1h_close_at_post numeric,
  entry_distance_pct numeric,
  entry_rsi numeric,
  entry_adx numeric,
  entry_btc_regime text,
  entry_4h_trend text,
  session_bucket text,

  -- ── Entry fill tracking ────────────────────────────────────
  entry_fill_status text not null default 'PENDING',
  entry_filled_at timestamptz,

  -- ── Resolution / outcome ───────────────────────────────────
  resolution_status text not null default 'OPEN',
  first_hit text,
  first_hit_at timestamptz,
  hours_to_first_hit numeric,
  hit_tp1 boolean not null default false,
  hit_tp2 boolean not null default false,
  hit_tp3 boolean not null default false,
  hit_sl boolean not null default false,
  ambiguous_hit boolean not null default false,
  max_favorable_pct numeric,
  max_adverse_pct numeric,
  open_days int not null default 0,
  resolved boolean not null default false,
  resolved_at timestamptz,
  expired_at timestamptz,

  -- ── Reverse-engineering metadata ───────────────────────────
  setup_family text,
  notes text,
  visible_chart_timestamp_text text,
  visible_chart_timeframe_text text,
  visible_chart_symbol_text text,
  visible_post_time_text text,
  chart_to_post_minutes_diff numeric,
  telegram_received_at timestamptz,

  -- ── Check constraints ──────────────────────────────────────
  constraint chk_direction check (direction in ('LONG', 'SHORT')),
  constraint chk_entry_fill_status check (entry_fill_status in ('PENDING', 'FILLED', 'NOT_FILLED', 'CANCELLED')),
  constraint chk_resolution_status check (resolution_status in ('PENDING_FILL', 'OPEN', 'FILLED_OPEN', 'TP1_FIRST', 'TP2_FIRST', 'TP3_FIRST', 'SL_FIRST', 'EXPIRED', 'CANCELLED', 'AMBIGUOUS_BOTH_TOUCHED', 'NOT_FILLED')),
  constraint chk_first_hit check (first_hit is null or first_hit in ('TP1', 'TP2', 'TP3', 'SL')),
  constraint chk_at_least_one_tp check (tp1 is not null or tp2 is not null or tp3 is not null),
  constraint chk_entry_validity check (
    (entry_price is not null and entry_low is null and entry_high is null)
    or (entry_price is null and entry_low is not null and entry_high is not null and entry_low <= entry_high)
  )
);

-- ── Indexes ──────────────────────────────────────────────────
create index idx_external_signals_source on external_signals (source);
create index idx_external_signals_symbol on external_signals (symbol);
create index idx_external_signals_posted_at on external_signals (posted_at);
create index idx_external_signals_resolved on external_signals (resolved);
create index idx_external_signals_entry_fill on external_signals (entry_fill_status);
create index idx_external_signals_direction on external_signals (direction);
create index idx_external_signals_resolution on external_signals (resolution_status);
-- Composite: unresolved signals for the grading cron
create index idx_external_signals_open on external_signals (resolved, entry_fill_status)
  where resolved = false and entry_fill_status = 'FILLED';


-- ═══════════════════════════════════════════════════════════════════
-- 2. external_signal_pending — confirm/cancel staging table
-- ═══════════════════════════════════════════════════════════════════

create table external_signal_pending (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  status text not null default 'PENDING',

  -- ── Telegram context ───────────────────────────────────────
  telegram_chat_id text not null,
  telegram_user_id text,
  telegram_message_id text,
  telegram_received_at timestamptz,

  -- ── Parsed data ────────────────────────────────────────────
  source text,
  raw_extracted_text text,
  parsed_payload jsonb not null,

  -- ── Resolution ─────────────────────────────────────────────
  confirmed_at timestamptz,
  cancelled_at timestamptz,
  inserted_signal_id uuid references external_signals(id),

  -- ── Check constraints ──────────────────────────────────────
  constraint chk_pending_status check (status in ('PENDING', 'CONFIRMED', 'CANCELLED', 'EXPIRED'))
);

-- ── Indexes ──────────────────────────────────────────────────
create index idx_pending_chat_status on external_signal_pending (telegram_chat_id, status);
create index idx_pending_expires on external_signal_pending (expires_at)
  where status = 'PENDING';
create index idx_pending_status on external_signal_pending (status);
