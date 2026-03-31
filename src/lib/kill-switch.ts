/**
 * Kill switch — drawdown-based system halt.
 *
 * Tracks weekly equity high-water mark and pauses signal generation
 * when drawdown exceeds safety thresholds.
 *
 * Env vars:
 *   INITIAL_ACCOUNT_VALUE_USD — default 1500
 *   ACCOUNT_VALUE_USD         — default 1500
 *   MAX_RISK_PER_TRADE_PCT    — default 0.02
 */

import { getSupabase } from "@/lib/supabase";
import { sendTelegram } from "@/lib/telegram";

interface AccountState {
  week_start_date: string;
  high_water_mark_usd: number;
  current_equity_usd: number;
  kill_switch_active: boolean;
  kill_switch_reason?: string;
  updated_at: string;
}

function envNum(key: string, fallback: number): number {
  const v = process.env[key];
  if (v == null) return fallback;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
}

/** Monday of the current week (UTC) */
function currentWeekStart(): string {
  const now = new Date();
  const day = now.getUTCDay();
  const diff = day === 0 ? 6 : day - 1; // Monday = 0 offset
  const monday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - diff));
  return monday.toISOString().slice(0, 10);
}

/**
 * Called by the grading cron after each batch.
 * Recalculates equity, updates HWM, checks drawdown thresholds.
 */
export async function updateAccountState(): Promise<AccountState> {
  const supabase = getSupabase();
  const weekStart = currentWeekStart();
  const initialValue = envNum("INITIAL_ACCOUNT_VALUE_USD", 1500);
  const riskPerTradePct = envNum("MAX_RISK_PER_TRADE_PCT", 0.02);
  const accountValue = envNum("ACCOUNT_VALUE_USD", 1500);
  const riskPerTradeUsd = accountValue * riskPerTradePct;

  // Sum all realized R from graded signals
  const { data: allGrades } = await supabase
    .from("production_signal_grades")
    .select("outcome_r")
    .eq("grade_status", "GRADED");

  const totalR = (allGrades ?? []).reduce((sum, g) => sum + (Number(g.outcome_r) || 0), 0);
  // NOTE: This uses linear equity approximation (initialValue + totalR * riskPerTradeUsd).
  // With compounding, actual equity diverges. This makes the kill switch slightly
  // conservative (triggers earlier than true equity), which is the safer direction.
  // TODO: Query actual Bybit account balance once execution engine is live.
  const currentEquity = initialValue + totalR * riskPerTradeUsd;

  // Get or create this week's state
  const { data: existing } = await supabase
    .from("account_state")
    .select("*")
    .eq("week_start_date", weekStart)
    .maybeSingle();

  const prevHwm = existing?.high_water_mark_usd ?? initialValue;
  const hwm = Math.max(prevHwm, currentEquity);
  const wasActive = existing?.kill_switch_active ?? false;

  const drawdownPct = hwm > 0 ? (hwm - currentEquity) / hwm : 0;

  let killActive = wasActive;
  let killReason = existing?.kill_switch_reason ?? null;

  // 30% drawdown warning
  if (drawdownPct >= 0.30 && !wasActive) {
    killActive = true;
    killReason = `30% drawdown from HWM ($${hwm.toFixed(0)} → $${currentEquity.toFixed(0)})`;
    console.warn(`[kill-switch] ${killReason}`);
    await sendTelegram(`⚠️ KILL SWITCH WARNING: 30% drawdown reached. System paused. Manual review required.\n\nHWM: $${hwm.toFixed(0)}\nCurrent: $${currentEquity.toFixed(0)}\nDrawdown: ${(drawdownPct * 100).toFixed(1)}%`);
  }

  // 50% drawdown emergency
  if (drawdownPct >= 0.50) {
    killReason = `50% drawdown from HWM ($${hwm.toFixed(0)} → $${currentEquity.toFixed(0)})`;
    console.error(`[kill-switch] EMERGENCY: ${killReason}`);
    await sendTelegram(`🛑 EMERGENCY: 50% drawdown. All signals halted.\n\nHWM: $${hwm.toFixed(0)}\nCurrent: $${currentEquity.toFixed(0)}\nDrawdown: ${(drawdownPct * 100).toFixed(1)}%`);
  }

  const state: AccountState = {
    week_start_date: weekStart,
    high_water_mark_usd: hwm,
    current_equity_usd: currentEquity,
    kill_switch_active: killActive,
    kill_switch_reason: killReason ?? undefined,
    updated_at: new Date().toISOString(),
  };

  await supabase.from("account_state").upsert({
    week_start_date: weekStart,
    high_water_mark_usd: hwm,
    current_equity_usd: currentEquity,
    kill_switch_active: killActive,
    kill_switch_reason: killReason,
    updated_at: new Date().toISOString(),
  }, { onConflict: "week_start_date" });

  console.log(`[kill-switch] Equity: $${currentEquity.toFixed(0)} | HWM: $${hwm.toFixed(0)} | Drawdown: ${(drawdownPct * 100).toFixed(1)}% | Active: ${killActive}`);

  return state;
}

/**
 * Called at the START of scanner before any processing.
 * Returns true if kill switch is active (scanner should abort).
 */
export async function isKillSwitchActive(): Promise<boolean> {
  const supabase = getSupabase();
  const weekStart = currentWeekStart();

  const { data } = await supabase
    .from("account_state")
    .select("kill_switch_active")
    .eq("week_start_date", weekStart)
    .maybeSingle();

  if (data?.kill_switch_active) {
    console.warn("[kill-switch] System paused — kill switch is active");
    return true;
  }
  return false;
}

/**
 * Manual reset after review. Called via API.
 */
export async function resetKillSwitch(): Promise<void> {
  const supabase = getSupabase();
  const weekStart = currentWeekStart();

  await supabase
    .from("account_state")
    .update({
      kill_switch_active: false,
      kill_switch_reason: `Manually reset at ${new Date().toISOString()}`,
      updated_at: new Date().toISOString(),
    })
    .eq("week_start_date", weekStart);

  console.log("[kill-switch] Kill switch manually reset");
  await sendTelegram("✅ Kill switch manually reset. Signal generation resumed.");
}
