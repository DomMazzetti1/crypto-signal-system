# Hardening Sprint Changelog (2026-03-30)

## Item 1: Max Stop Distance Filter — ALREADY EXISTED
No changes needed. Pipeline step 5c already rejects signals where `|stop - entry| / entry > 8%` via `MAX_STOP_DIST_PCT` env var.

## Item 2: Portfolio Risk Controls
**New file:** `src/lib/risk-manager.ts`
**Modified:** `src/lib/pipeline.ts`

- Created risk manager module with 4 pre-trade checks:
  1. **Daily loss circuit breaker** — rejects all signals for 24h if cumulative realized R < -5R (queries `production_signal_grades`)
  2. **Max concurrent positions** — hard cap of 10 open Telegram-sent ungraded signals
  3. **Portfolio heat limit** — caps total open risk at 10% of account value ($1500 default)
  4. **Burst dampener** — reduces per-trade risk from 2% to 1% if >5 signals approved this hour
- Wired into pipeline as step 9d (after cluster assignment, before decision storage)
- Failed risk checks convert decision to NO_TRADE and store `risk_check_result` JSONB on the decisions row
- All env vars have sensible defaults — system doesn't break if unset

## Item 3: Kill Switch
**New file:** `src/lib/kill-switch.ts`
**New file:** `src/app/api/kill-switch/reset/route.ts`
**Modified:** `src/app/api/scanner/run/route.ts`
**Modified:** `src/app/api/cron/grade/route.ts`

- Tracks weekly equity high-water mark in `account_state` table
- At 30% drawdown: sets `kill_switch_active = true`, sends Telegram warning
- At 50% drawdown: sends Telegram emergency alert
- Scanner checks kill switch before acquiring lock — aborts if active
- Grading cron calls `updateAccountState()` after each batch
- Manual reset via `POST /api/kill-switch/reset` (protected by WEBHOOK_SECRET)

## Item 4: Position Sizing
Integrated into risk-manager.ts burst dampener. No separate module needed:
- `MAX_RISK_PER_TRADE_PCT` = 0.02 (2%) default
- `BURST_RISK_PCT` = 0.01 (1%) when burst threshold exceeded
- `BURST_THRESHOLD` = 5 signals/hour
- `ACCOUNT_VALUE_USD` = $1500 default
- All configurable via env vars

## Item 5: BTC Regime Backfill
**Modified:** `src/app/api/debug/backfill-regime/route.ts`

- Added `CRON_SECRET` authentication (was previously unprotected)
- Route already works correctly — processes 50 rows per call, idempotent

## Item 6: Backtest Re-run
**New file:** `src/app/api/backtest/full-run/route.ts`
**New file:** `supabase/migrations/017_backtest_results_and_account_state.sql`

- Persistent `backtest_results` table with all signal fields + indicators
- Processes symbols in configurable batches with `?offset=N&batch=5&run_id=X`
- Applies all production filters: max stop distance, Gate B, regime
- Uses `gradeSignal` from grade-signal.ts (same slippage=0.0005, fees=0.00055)
- Computes summary stats segmented by regime and tier
- Protected by CRON_SECRET

---

## New Files Created
| Path | Purpose |
|------|---------|
| `src/lib/risk-manager.ts` | Portfolio-level pre-trade risk checks |
| `src/lib/kill-switch.ts` | Drawdown-based system halt |
| `src/app/api/kill-switch/reset/route.ts` | Manual kill switch reset endpoint |
| `src/app/api/backtest/full-run/route.ts` | Full backtest with persistent storage |
| `supabase/migrations/017_backtest_results_and_account_state.sql` | Schema for backtest results + account state |
| `CHANGELOG-hardening-sprint.md` | This file |

## Existing Files Modified
| Path | Change |
|------|--------|
| `src/lib/pipeline.ts` | Added risk check import + step 9d + risk_check_result in baseData |
| `src/app/api/scanner/run/route.ts` | Added kill switch check before lock |
| `src/app/api/cron/grade/route.ts` | Added updateAccountState after grading |
| `src/app/api/debug/backfill-regime/route.ts` | Added CRON_SECRET auth |
| `.env.local.example` | Added 8 new risk management env vars |

## New Environment Variables
| Variable | Default | Description |
|----------|---------|-------------|
| `ACCOUNT_VALUE_USD` | 1500 | Account value for risk calculations |
| `INITIAL_ACCOUNT_VALUE_USD` | 1500 | Starting equity for kill switch HWM |
| `DAILY_LOSS_LIMIT_R` | -5 | Daily cumulative R loss limit |
| `MAX_CONCURRENT_POSITIONS` | 10 | Max open ungraded positions |
| `PORTFOLIO_HEAT_LIMIT_PCT` | 0.10 | Max open risk as % of account |
| `MAX_RISK_PER_TRADE_PCT` | 0.02 | Normal per-trade risk % |
| `BURST_THRESHOLD` | 5 | Signals/hour before burst dampener |
| `BURST_RISK_PCT` | 0.01 | Reduced risk % during burst |

## New Supabase Tables/Columns
| Table/Column | Type | Description |
|--------------|------|-------------|
| `backtest_results` | TABLE | Persistent backtest results with full signal data |
| `account_state` | TABLE | Weekly equity tracking for kill switch |
| `decisions.risk_check_result` | JSONB | Risk check outcome per decision |

## Manual Steps Required
1. Run migration 017 against Supabase
2. Set env vars in Vercel (all have defaults — not urgent)
3. Backfill regime: `curl -H "Authorization: Bearer $CRON_SECRET" .../api/debug/backfill-regime` (repeat until "batch complete")
4. Full backtest: `curl -H "Authorization: Bearer $CRON_SECRET" ".../api/backtest/full-run?batch=5"` (repeat with `?offset=N` increments)
