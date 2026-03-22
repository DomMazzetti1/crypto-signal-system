-- External signal forward-testing subsystem.
--
-- Tables external_signals and external_signal_pending were created
-- via the Supabase SQL Editor. This migration fixes check constraints
-- applied from earlier drafts with incomplete allowed values:
--   resolution_status: was missing PENDING_FILL and CANCELLED
--   entry_fill_status: was missing CANCELLED
--
-- Safe to re-run: uses DROP IF EXISTS before re-adding.

-- ── Fix resolution_status constraint ─────────────────────────
-- The live constraint was auto-named by Postgres.
-- Drop both possible names (auto-generated and explicitly named).
alter table external_signals
  drop constraint if exists external_signals_resolution_status_check;
alter table external_signals
  drop constraint if exists chk_resolution_status;

alter table external_signals
  add constraint chk_resolution_status check (
    resolution_status in (
      'PENDING_FILL',
      'OPEN',
      'FILLED_OPEN',
      'TP1_FIRST',
      'TP2_FIRST',
      'TP3_FIRST',
      'SL_FIRST',
      'EXPIRED',
      'CANCELLED',
      'AMBIGUOUS_BOTH_TOUCHED',
      'NOT_FILLED'
    )
  );

-- ── Fix entry_fill_status constraint ───────────────────────
-- Was missing CANCELLED.
alter table external_signals
  drop constraint if exists external_signals_entry_fill_status_check;
alter table external_signals
  drop constraint if exists chk_entry_fill_status;

alter table external_signals
  add constraint chk_entry_fill_status check (
    entry_fill_status in (
      'PENDING',
      'FILLED',
      'NOT_FILLED',
      'CANCELLED'
    )
  );
