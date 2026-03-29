# Fix Run Summary (2026-03-29)

12 groups of targeted fixes across security, grading, reliability, observability, and code quality. No business logic, thresholds, or indicator parameters were changed.

---

## Group 1 — Security: auth for webhook and cron routes
**Files:** `alert/route.ts`, `scanner/run/route.ts`, `cron/grade/route.ts`, `shadow/grade/route.ts`, `.env.local.example`

- Added `WEBHOOK_SECRET` check to the alert webhook POST handler (no-op when unset)
- Added `CRON_SECRET` Bearer token check to scanner, grading cron, and shadow grade routes
- Added both env vars to `.env.local.example`

## Group 2 — Grading correctness: query filter, TP levels, cost model, retry
**Files:** `src/lib/grading.ts`

- Added `.is("graded_outcome", null)` to the decisions query — eliminates drift from `production_signal_grades` table
- Uses stored `tp1_price`, `tp2_price`, `tp3_price` with fallback to computed values
- Added `SLIPPAGE` (0.05%) and `TAKER_FEE` (0.055%) to match backtest/shadow methodology
- Fill entry adjusted for slippage; TP levels adjusted for taker fees
- Added retry with 600ms delay for Bybit kline fetch failures

## Group 3 — Scanner reliability: lock TTL, cooldown double-write
**Files:** `scanner/run/route.ts`

- Reduced `LOCK_TTL` from 600s to 290s (must be < `maxDuration` 300s)
- Removed scanner cooldown re-write for STRICT/RELAXED — pipeline already sets it

## Group 4 — Cluster finalization from grading cron
**Files:** `cron/grade/route.ts`

- Added `finalizeExpiredClusters()` call before grading loop so off-hours clusters get selection decisions without requiring a dashboard read

## Group 5 — Dashboard observability: scanner heartbeat
**Files:** `status/route.ts`, `page.tsx`

- Added `last_scan_at` field to `/api/status` from `scanner_runs` table
- Added "Last scanner run" row to the home page dashboard

## Group 6 — Research layer: selection-stats date filter
**Files:** `selection-stats/route.ts`

- Added `?days=` query param (default 90) with `gte("created_at", cutoff)` filter
- Prevents unbounded table scans as data grows

## Group 7 — Code deduplication: gradeSignal, gate-b variant
**Files:** `backtest/batch/route.ts`, `gate-b.ts`, `shadow-relaxed.ts`

- Removed inline `gradeSignal` and `computeR` from backtest route — now imports from `grade-signal.ts`
- Removed inline `runGateBWithVariant` — `runGateB` now accepts optional `GateBVariant` config
- `runGateBRelaxed` now delegates to `runGateB(input, { sideways_sq_volume_mult: 1.5 })`

## Group 8 — Pipeline cleanup: deriveTier, regime ADX null-guard
**Files:** `pipeline.ts`, `regime.ts`

- Replaced fragile `rawType.includes("relaxed")` with `deriveTier()` from cluster module
- Added `Number.isFinite()` guard on `btc4hAdx` before comparison

## Group 9 — Universe builder: concurrent ticker fetches
**Files:** `universe/build/route.ts`

- Replaced sequential `for` loop with `runWithConcurrency(candidates, 10, ...)` to prevent timeout on 500+ instruments

## Group 10 — Outcome classification: split WIN_PARTIAL
**Files:** `grading.ts`, `selection-stats/route.ts`

- `WIN_PARTIAL` split into `WIN_PARTIAL_THEN_SL` (TP1 hit then stopped) and `WIN_PARTIAL_EXPIRED` (TP1 hit, expired before TP2)
- Selection-stats win rate includes both new values as wins

## Group 11 — Telegram reliability: retry with backoff
**Files:** `telegram.ts`

- `sendTelegram` now retries up to 3 attempts with 1s/2s backoff
- Stops retrying on 4xx client errors (except 429)

## Group 12 — Redis queue cleanup: remove dead lpush
**Files:** `alert/route.ts`, `scanner/run/route.ts`

- Removed `lpush` to Redis queue in alert route (no active consumer)
- Added audit-only comment to scanner's queue push
