/**
 * Shared shadow experiment summary logic.
 * Used by individual status endpoints and the aggregate morning report.
 */

import { getSupabase } from "@/lib/supabase";

const MIN_GRADED_FOR_DECISION = 10;

const SHADOW_COLUMNS = "id, symbol, candle_time, adx_1h, rsi, close_price, atr_1h, volume, sma20_volume, baseline_pass, relaxed_pass, shadow_only, grade_status, outcome_r, hit_tp1, hit_tp2, hit_tp3, hit_sl, max_favorable, max_adverse, bars_to_resolution, graded_at, regime";

function round(n: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

interface VariantStats {
  count: number;
  win_rate_tp1: number;
  avg_r: number;
  avg_adx: number;
}

export interface ShadowSummary {
  setup_type: string;
  total_rows: number;
  graded_rows: number;
  ungraded_rows: number;
  candidate_only_total: number;
  relaxed_pass: VariantStats;
  baseline_only: VariantStats;
  decision: string;
  recent_graded: Record<string, unknown>[];
  recent_ungraded: Record<string, unknown>[];
}

type ShadowRow = Record<string, unknown>;

function computeVariantStats(subset: ShadowRow[]): VariantStats {
  const n = subset.length;
  if (n === 0) return { count: 0, win_rate_tp1: 0, avg_r: 0, avg_adx: 0 };
  const wins = subset.filter((r) => r.hit_tp1).length;
  const rs = subset.map((r) => Number(r.outcome_r) || 0);
  const adxs = subset.map((r) => Number(r.adx_1h) || 0);
  return {
    count: n,
    win_rate_tp1: round(wins / n, 4),
    avg_r: round(rs.reduce((a, b) => a + b, 0) / n, 2),
    avg_adx: round(adxs.reduce((a, b) => a + b, 0) / n, 1),
  };
}

function computeDecision(graded: ShadowRow[], relaxedStats: VariantStats, baselineOnlyStats: VariantStats): string {
  if (graded.length < MIN_GRADED_FOR_DECISION || relaxedStats.count === 0) {
    return "insufficient data";
  }
  if (baselineOnlyStats.count === 0) {
    return "candidate better so far";
  }
  const rDiff = relaxedStats.avg_r - baselineOnlyStats.avg_r;
  const wrDiff = relaxedStats.win_rate_tp1 - baselineOnlyStats.win_rate_tp1;
  if (rDiff > 0.1 && wrDiff >= -0.05) return "candidate better so far";
  if (rDiff < -0.1 && wrDiff <= 0.05) return "baseline better so far";
  return "roughly equal";
}

function compact(r: ShadowRow) {
  return {
    symbol: r.symbol,
    candle_time: r.candle_time,
    adx_1h: r.adx_1h,
    rsi: r.rsi,
    baseline_pass: r.baseline_pass,
    relaxed_pass: r.relaxed_pass,
    shadow_only: r.shadow_only,
    grade_status: r.grade_status,
    outcome_r: r.outcome_r,
    hit_tp1: r.hit_tp1,
    hit_sl: r.hit_sl,
    regime: r.regime,
  };
}

/**
 * Compute a full shadow summary for a given setup_type.
 * Returns the summary or throws on DB error.
 */
export async function computeShadowSummary(setupType: string): Promise<ShadowSummary> {
  const supabase = getSupabase();

  const { data: rows, error } = await supabase
    .from("shadow_signals")
    .select(SHADOW_COLUMNS)
    .eq("setup_type", setupType)
    .order("candle_time", { ascending: false });

  if (error) throw new Error(`DB query failed for ${setupType}: ${error.message}`);

  const all = rows ?? [];
  const graded = all.filter((r) => r.grade_status === "GRADED");
  const ungraded = all.filter((r) => r.grade_status !== "GRADED");

  const relaxedPass = graded.filter((r) => r.relaxed_pass);
  const baselineOnly = graded.filter((r) => r.baseline_pass && !r.relaxed_pass);

  const relaxedStats = computeVariantStats(relaxedPass);
  const baselineOnlyStats = computeVariantStats(baselineOnly);
  const decision = computeDecision(graded, relaxedStats, baselineOnlyStats);

  return {
    setup_type: setupType,
    total_rows: all.length,
    graded_rows: graded.length,
    ungraded_rows: ungraded.length,
    candidate_only_total: all.filter((r) => r.shadow_only).length,
    relaxed_pass: relaxedStats,
    baseline_only: baselineOnlyStats,
    decision,
    recent_graded: graded.slice(0, 5).map(compact),
    recent_ungraded: ungraded.slice(0, 5).map(compact),
  };
}
