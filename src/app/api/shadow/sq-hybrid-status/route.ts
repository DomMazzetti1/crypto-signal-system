import { NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";

export const dynamic = "force-dynamic";

const SETUP_TYPE = "SQ_SHORT_HYBRID_SHADOW";
const MIN_GRADED_FOR_DECISION = 10;

function round(n: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

export async function GET() {
  const supabase = getSupabase();

  const { data: rows, error } = await supabase
    .from("shadow_signals")
    .select("id, symbol, candle_time, adx_1h, rsi, close_price, atr_1h, volume, sma20_volume, baseline_pass, relaxed_pass, shadow_only, grade_status, outcome_r, hit_tp1, hit_tp2, hit_tp3, hit_sl, max_favorable, max_adverse, bars_to_resolution, graded_at")
    .eq("setup_type", SETUP_TYPE)
    .order("candle_time", { ascending: false });

  if (error) {
    return NextResponse.json({ error: "Failed to fetch data", detail: error.message }, { status: 500 });
  }

  if (!rows || rows.length === 0) {
    return NextResponse.json({ status: "no_data", total_rows: 0, decision: "insufficient data" });
  }

  const graded = rows.filter((r) => r.grade_status === "GRADED");
  const ungraded = rows.filter((r) => r.grade_status !== "GRADED");

  // relaxed_pass = true means hybrid candidate fired
  // baseline_pass = true AND relaxed_pass = false means only production event mode fired
  const candidatePass = graded.filter((r) => r.relaxed_pass);
  const baselineOnly = graded.filter((r) => r.baseline_pass && !r.relaxed_pass);
  const bothPass = graded.filter((r) => r.baseline_pass && r.relaxed_pass);

  const stats = (label: string, subset: typeof graded) => {
    const n = subset.length;
    if (n === 0) return { label, count: 0, win_rate_tp1: 0, avg_r: 0, avg_adx: 0 };
    const wins = subset.filter((r) => r.hit_tp1).length;
    const rs = subset.map((r) => Number(r.outcome_r) || 0);
    const adxs = subset.map((r) => Number(r.adx_1h) || 0);
    return {
      label,
      count: n,
      win_rate_tp1: round(wins / n, 4),
      avg_r: round(rs.reduce((a, b) => a + b, 0) / n, 2),
      avg_adx: round(adxs.reduce((a, b) => a + b, 0) / n, 1),
    };
  };

  const candidateStats = stats("candidate_pass (hybrid)", candidatePass);
  const baselineOnlyStats = stats("baseline_only (event)", baselineOnly);
  const bothStats = stats("both_pass", bothPass);

  let decision: string;
  if (graded.length < MIN_GRADED_FOR_DECISION || candidateStats.count === 0) {
    decision = "insufficient data";
  } else if (baselineOnlyStats.count === 0) {
    decision = "candidate better so far";
  } else {
    const rDiff = candidateStats.avg_r - baselineOnlyStats.avg_r;
    const wrDiff = candidateStats.win_rate_tp1 - baselineOnlyStats.win_rate_tp1;
    if (rDiff > 0.1 && wrDiff >= -0.05) decision = "candidate better so far";
    else if (rDiff < -0.1 && wrDiff <= 0.05) decision = "baseline better so far";
    else decision = "roughly equal";
  }

  const candidateOnlyTotal = rows.filter((r) => r.shadow_only).length;
  const candidateOnlyGraded = graded.filter((r) => r.shadow_only).length;

  return NextResponse.json({
    setup_type: SETUP_TYPE,
    description: "Production event trigger vs hybrid (state + 1.5x vol + 5% below 4H EMA50)",
    total_rows: rows.length,
    graded_rows: graded.length,
    ungraded_rows: ungraded.length,
    candidate_only_total: candidateOnlyTotal,
    candidate_only_graded: candidateOnlyGraded,
    candidate_pass: candidateStats,
    baseline_only: baselineOnlyStats,
    both_pass: bothStats,
    decision,
    recent_graded: graded.slice(0, 10).map(compact),
    recent_ungraded: ungraded.slice(0, 10).map(compact),
  });
}

function compact(r: Record<string, unknown>) {
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
  };
}
