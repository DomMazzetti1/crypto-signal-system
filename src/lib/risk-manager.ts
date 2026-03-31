/**
 * Portfolio-level risk controls.
 *
 * All checks run AFTER cluster assignment but BEFORE decision storage.
 * Failed checks convert the decision to NO_TRADE (preserving data collection)
 * and block Telegram delivery.
 *
 * Env vars (all optional with sensible defaults):
 *   ACCOUNT_VALUE_USD          — default 1500
 *   DAILY_LOSS_LIMIT_R         — default -5
 *   MAX_CONCURRENT_POSITIONS   — default 10
 *   PORTFOLIO_HEAT_LIMIT_PCT   — default 0.10
 *   BURST_THRESHOLD            — default 5
 *   MAX_RISK_PER_TRADE_PCT     — default 0.02
 *   BURST_RISK_PCT             — default 0.01
 */

import { getSupabase } from "@/lib/supabase";
import { getRedis } from "@/lib/redis";

export interface RiskCheckResult {
  approved: boolean;
  reason?: string;
  adjustedRiskPct?: number;
}

function envNum(key: string, fallback: number): number {
  const v = process.env[key];
  if (v == null) return fallback;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Check 1: Daily loss circuit breaker.
 * If cumulative realized R today < DAILY_LOSS_LIMIT_R, reject for 24h.
 */
export async function checkDailyLossLimit(): Promise<RiskCheckResult> {
  const redis = getRedis();
  const cooldownKey = "risk:daily_loss_cooldown";

  const cooldown = await redis.get(cooldownKey);
  if (cooldown) {
    return { approved: false, reason: "DAILY_LOSS_COOLDOWN_ACTIVE" };
  }

  const limit = envNum("DAILY_LOSS_LIMIT_R", -5);
  const supabase = getSupabase();
  const todayStart = new Date().toISOString().slice(0, 10);

  // Only count signals that were actually sent to Telegram (not DATA_ONLY research signals)
  const { data: tradedDecisions } = await supabase
    .from("decisions")
    .select("id")
    .eq("telegram_sent", true)
    .gte("created_at", todayStart)
    .in("decision", ["LONG", "SHORT", "MR_LONG", "MR_SHORT"]);

  if (!tradedDecisions || tradedDecisions.length === 0) return { approved: true };

  const tradedIds = tradedDecisions.map(d => d.id);

  const { data: grades } = await supabase
    .from("production_signal_grades")
    .select("outcome_r")
    .gte("graded_at", todayStart)
    .eq("grade_status", "GRADED")
    .in("decision_id", tradedIds);

  if (!grades || grades.length === 0) return { approved: true };

  const totalR = grades.reduce((sum, g) => sum + (Number(g.outcome_r) || 0), 0);

  if (totalR < limit) {
    await redis.set(cooldownKey, Date.now(), { ex: 24 * 60 * 60 });
    console.warn(`[risk] Daily loss limit hit: ${totalR.toFixed(2)}R < ${limit}R — 24h cooldown set`);
    return { approved: false, reason: `DAILY_LOSS_LIMIT: ${totalR.toFixed(2)}R` };
  }

  return { approved: true };
}

/**
 * Check 2: Max concurrent positions.
 * Counts Telegram-sent signals in last 48h that haven't been graded.
 * TODO: Replace ungraded-signal proxy with actual position state from execution engine
 * once Bybit testnet validation is complete. Query /api/positions on exec engine.
 */
export async function checkMaxConcurrentPositions(): Promise<RiskCheckResult> {
  const maxPos = envNum("MAX_CONCURRENT_POSITIONS", 10);
  const supabase = getSupabase();
  const cutoff48h = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();

  const { count } = await supabase
    .from("decisions")
    .select("id", { count: "exact", head: true })
    .eq("telegram_sent", true)
    .gte("created_at", cutoff48h)
    .is("graded_outcome", null)
    .in("decision", ["LONG", "SHORT", "MR_LONG", "MR_SHORT"]);

  const open = count ?? 0;
  if (open >= maxPos) {
    return { approved: false, reason: `MAX_CONCURRENT_POSITIONS: ${open}/${maxPos}` };
  }
  return { approved: true };
}

/**
 * Check 3: Portfolio heat limit.
 * Sum risk_amount of all open ungraded positions. Reject if adding
 * this signal would exceed PORTFOLIO_HEAT_LIMIT_PCT of account.
 */
export async function checkPortfolioHeat(newSignalRiskAmount: number): Promise<RiskCheckResult> {
  const accountValue = envNum("ACCOUNT_VALUE_USD", 1500);
  const heatPct = envNum("PORTFOLIO_HEAT_LIMIT_PCT", 0.10);
  const maxHeatUsd = accountValue * heatPct;

  const supabase = getSupabase();
  const cutoff48h = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();

  const { data: openPositions } = await supabase
    .from("decisions")
    .select("risk_amount")
    .eq("telegram_sent", true)
    .gte("created_at", cutoff48h)
    .is("graded_outcome", null)
    .in("decision", ["LONG", "SHORT", "MR_LONG", "MR_SHORT"]);

  let currentHeatUsd = 0;
  if (openPositions) {
    for (const p of openPositions) {
      currentHeatUsd += Number(p.risk_amount) || 0;
    }
  }

  if (currentHeatUsd + newSignalRiskAmount > maxHeatUsd) {
    return {
      approved: false,
      reason: `PORTFOLIO_HEAT: $${(currentHeatUsd + newSignalRiskAmount).toFixed(0)} > $${maxHeatUsd.toFixed(0)} limit`,
    };
  }
  return { approved: true };
}

/**
 * Check 4: Burst dampener.
 * If > BURST_THRESHOLD signals sent this hour, reduce max risk per trade.
 */
export async function getBurstAdjustedRiskPct(): Promise<{ riskPct: number; signalsThisHour: number }> {
  const burstThreshold = envNum("BURST_THRESHOLD", 5);
  const normalPct = envNum("MAX_RISK_PER_TRADE_PCT", 0.02);
  const burstPct = envNum("BURST_RISK_PCT", 0.01);

  const supabase = getSupabase();
  const now = new Date();
  const hourStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), now.getUTCHours()));

  const { count } = await supabase
    .from("decisions")
    .select("id", { count: "exact", head: true })
    .eq("telegram_sent", true)
    .gte("created_at", hourStart.toISOString())
    .in("decision", ["LONG", "SHORT", "MR_LONG", "MR_SHORT"]);

  const signalsThisHour = count ?? 0;
  if (signalsThisHour > burstThreshold) {
    console.log(`[risk] Burst dampener: ${signalsThisHour} signals this hour > ${burstThreshold} — risk capped at ${(burstPct * 100).toFixed(1)}%`);
    return { riskPct: burstPct, signalsThisHour };
  }
  return { riskPct: normalPct, signalsThisHour };
}

/**
 * Master risk check. Runs all checks in parallel.
 */
export async function runPreTradeRiskChecks(signalRiskAmount: number): Promise<RiskCheckResult> {
  const [dailyLoss, concurrent, heat, burst] = await Promise.all([
    checkDailyLossLimit(),
    checkMaxConcurrentPositions(),
    checkPortfolioHeat(signalRiskAmount),
    getBurstAdjustedRiskPct(),
  ]);

  if (!dailyLoss.approved) return dailyLoss;
  if (!concurrent.approved) return concurrent;
  if (!heat.approved) return heat;

  return { approved: true, adjustedRiskPct: burst.riskPct };
}
