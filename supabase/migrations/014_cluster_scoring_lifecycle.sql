-- Migration 014: Cluster metadata, composite scoring, execution selection, lifecycle tracking
-- All columns are nullable with safe defaults to preserve compatibility with existing rows.

-- ── Persisted scoring inputs ──────────────────────────────
-- These values are transient in the pipeline today; persist them for composite scoring and research.
alter table decisions add column if not exists vol_ratio numeric;
alter table decisions add column if not exists entry_deviation_pct numeric;

-- ── Composite score (0–100, bounded) ─────────────────────
alter table decisions add column if not exists composite_score numeric;

-- ── Cluster metadata ─────────────────────────────────────
-- cluster_id = "{hour_bucket}:{direction}:{regime}" deterministic key
alter table decisions add column if not exists cluster_id text;
alter table decisions add column if not exists cluster_hour timestamptz;
alter table decisions add column if not exists cluster_size integer default 1;
alter table decisions add column if not exists cluster_rank integer;

-- ── Execution selection ──────────────────────────────────
alter table decisions add column if not exists selected_for_execution boolean default false;
alter table decisions add column if not exists suppressed_reason text;

-- ── Graded outcome (research, NOT live status) ───────────
-- Distinct from dashboard live status which is derived from current price.
-- Values: WIN_FULL, WIN_PARTIAL, LOSS, EXPIRED, INVALID, STALE_ENTRY, CANCELLED
alter table decisions add column if not exists graded_outcome text;

-- ── Deterministic lifecycle timestamps ───────────────────
alter table decisions add column if not exists tp1_hit_at timestamptz;
alter table decisions add column if not exists tp2_hit_at timestamptz;
alter table decisions add column if not exists tp3_hit_at timestamptz;
alter table decisions add column if not exists stopped_at timestamptz;
alter table decisions add column if not exists resolved_at timestamptz;
alter table decisions add column if not exists resolution_path text;

-- ── Indexes for cluster queries ──────────────────────────
create index if not exists idx_decisions_cluster_id on decisions(cluster_id);
create index if not exists idx_decisions_cluster_hour on decisions(cluster_hour);
create index if not exists idx_decisions_selected on decisions(selected_for_execution);
create index if not exists idx_decisions_composite_score on decisions(composite_score);
