/**
 * Shared shadow experiment summary and analysis logic.
 * Used by individual status endpoints and the aggregate morning report.
 */

import { getSupabase } from "@/lib/supabase";
import { DECISION_THRESHOLDS } from "@/lib/experiment-registry";

const SHADOW_COLUMNS = "id, symbol, candle_time, adx_1h, rsi, close_price, atr_1h, volume, sma20_volume, baseline_pass, relaxed_pass, shadow_only, grade_status, outcome_r, hit_tp1, hit_tp2, hit_tp3, hit_sl, max_favorable, max_adverse, bars_to_resolution, graded_at, regime";

function round(n: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

// ── Types ────────────────────────────────────────────────

export interface VariantStats {
  count: number;
  win_rate_tp1: number;
  avg_r: number;
  avg_adx: number;
}

export interface SegmentedStats {
  by_setup: Record<string, VariantStats>;
  by_regime: Record<string, VariantStats>;
}

export interface ClusteringMetrics {
  total_candidate_only: number;
  signals_per_hour: number;
  peak_1h_window: number;
  peak_4h_window: number;
}

export interface DistanceBucket {
  label: string;
  count: number;
  win_rate_tp1: number;
  avg_r: number;
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
  segments: SegmentedStats;
  clustering: ClusteringMetrics;
  distance_buckets?: DistanceBucket[];
  recent_graded: Record<string, unknown>[];
  recent_ungraded: Record<string, unknown>[];
}

export interface ProductionGradeSummary {
  total: number;
  graded: number;
  pending: number;
  failed: number;
  win_rate_tp1: number;
  avg_r: number;
  by_setup: Record<string, VariantStats>;
  by_regime: Record<string, VariantStats>;
}

export interface ClaudeReviewerStats {
  total_reviewed: number;
  approved: number;
  rejected: number;
  pass_rate: number;
  by_setup: Record<string, { reviewed: number; approved: number; pass_rate: number }>;
  by_regime: Record<string, { reviewed: number; approved: number; pass_rate: number }>;
}

// ── Helpers ──────────────────────────────────────────────

type Row = Record<string, unknown>;

function computeVariantStats(subset: Row[]): VariantStats {
  const n = subset.length;
  if (n === 0) return { count: 0, win_rate_tp1: 0, avg_r: 0, avg_adx: 0 };
  const wins = subset.filter(r => r.hit_tp1).length;
  const rs = subset.map(r => Number(r.outcome_r) || 0);
  const adxs = subset.map(r => Number(r.adx_1h) || 0);
  return {
    count: n,
    win_rate_tp1: round(wins / n, 4),
    avg_r: round(rs.reduce((a, b) => a + b, 0) / n, 2),
    avg_adx: round(adxs.reduce((a, b) => a + b, 0) / n, 1),
  };
}

function computeSegments(graded: Row[], setupField: string, regimeField: string): SegmentedStats {
  const bySetup: Record<string, VariantStats> = {};
  const byRegime: Record<string, VariantStats> = {};

  const setups = Array.from(new Set(graded.map(r => String(r[setupField] ?? "unknown"))));
  for (const st of setups) {
    const sub = graded.filter(r => r[setupField] === st);
    if (sub.length > 0) bySetup[st] = computeVariantStats(sub);
  }

  const regimes = Array.from(new Set(graded.map(r => String(r[regimeField] ?? "unknown"))));
  for (const reg of regimes) {
    const sub = graded.filter(r => r[regimeField] === reg);
    if (sub.length > 0) byRegime[reg] = computeVariantStats(sub);
  }

  return { by_setup: bySetup, by_regime: byRegime };
}

function computeClustering(rows: Row[]): ClusteringMetrics {
  const candidateOnly = rows.filter(r => r.shadow_only);
  const n = candidateOnly.length;
  if (n === 0) return { total_candidate_only: 0, signals_per_hour: 0, peak_1h_window: 0, peak_4h_window: 0 };

  const times = candidateOnly
    .map(r => new Date(String(r.candle_time)).getTime())
    .filter(t => !isNaN(t))
    .sort((a, b) => a - b);

  if (times.length === 0) return { total_candidate_only: n, signals_per_hour: 0, peak_1h_window: 0, peak_4h_window: 0 };

  const spanHours = (times[times.length - 1] - times[0]) / (1000 * 60 * 60);
  const sph = spanHours > 0 ? round(n / spanHours, 2) : n;

  // Rolling window peaks
  let peak1h = 0, peak4h = 0;
  for (let i = 0; i < times.length; i++) {
    let count1h = 0, count4h = 0;
    for (let j = i; j < times.length; j++) {
      const diff = times[j] - times[i];
      if (diff <= 3600000) count1h++;
      if (diff <= 14400000) count4h++;
    }
    if (count1h > peak1h) peak1h = count1h;
    if (count4h > peak4h) peak4h = count4h;
  }

  return { total_candidate_only: n, signals_per_hour: sph, peak_1h_window: peak1h, peak_4h_window: peak4h };
}

function computeDecision(graded: Row[], relaxedStats: VariantStats, baselineOnlyStats: VariantStats): string {
  const { min_graded_total, min_candidate_graded, min_baseline_graded } = DECISION_THRESHOLDS;

  if (graded.length < min_graded_total) return "insufficient data";
  if (relaxedStats.count < min_candidate_graded) return "insufficient data";
  if (baselineOnlyStats.count < min_baseline_graded) return "insufficient data";

  const rDiff = relaxedStats.avg_r - baselineOnlyStats.avg_r;
  const wrDiff = relaxedStats.win_rate_tp1 - baselineOnlyStats.win_rate_tp1;
  if (rDiff > 0.1 && wrDiff >= -0.05) return "candidate better so far";
  if (rDiff < -0.1 && wrDiff <= 0.05) return "baseline better so far";
  return "roughly equal";
}

function compact(r: Row) {
  return {
    symbol: r.symbol, candle_time: r.candle_time, adx_1h: r.adx_1h, rsi: r.rsi,
    baseline_pass: r.baseline_pass, relaxed_pass: r.relaxed_pass, shadow_only: r.shadow_only,
    grade_status: r.grade_status, outcome_r: r.outcome_r, hit_tp1: r.hit_tp1, hit_sl: r.hit_sl,
    regime: r.regime,
  };
}

// ── Distance bucket analysis (hybrid shadow) ─────────────

function computeDistanceBuckets(graded: Row[]): DistanceBucket[] {
  // Parse dist4h from regime field (stored as "dist4h=X%")
  const withDist: { row: Row; dist4h: number }[] = [];
  for (const r of graded) {
    const regimeStr = String(r.regime ?? "");
    const match = regimeStr.match(/dist4h=([-\d.]+)%/);
    if (match) withDist.push({ row: r, dist4h: parseFloat(match[1]) });
  }

  if (withDist.length === 0) return [];

  const bucketDefs: { label: string; filter: (d: number) => boolean }[] = [
    { label: "< 2%", filter: d => d < 2 },
    { label: "2–5%", filter: d => d >= 2 && d < 5 },
    { label: "5–10%", filter: d => d >= 5 && d < 10 },
    { label: "≥ 10%", filter: d => d >= 10 },
  ];

  return bucketDefs.map(b => {
    const sub = withDist.filter(wd => b.filter(wd.dist4h));
    const n = sub.length;
    if (n === 0) return { label: b.label, count: 0, win_rate_tp1: 0, avg_r: 0 };
    const wins = sub.filter(wd => wd.row.hit_tp1).length;
    const rs = sub.map(wd => Number(wd.row.outcome_r) || 0);
    return {
      label: b.label,
      count: n,
      win_rate_tp1: round(wins / n, 4),
      avg_r: round(rs.reduce((s, v) => s + v, 0) / n, 2),
    };
  }).filter(b => b.count > 0);
}

// ── Main summary function ────────────────────────────────

export async function computeShadowSummary(setupType: string): Promise<ShadowSummary> {
  const supabase = getSupabase();

  const { data: rows, error } = await supabase
    .from("shadow_signals")
    .select(SHADOW_COLUMNS)
    .eq("setup_type", setupType)
    .order("candle_time", { ascending: false });

  if (error) throw new Error(`DB query failed for ${setupType}: ${error.message}`);

  const all = rows ?? [];
  const graded = all.filter(r => r.grade_status === "GRADED");
  const ungraded = all.filter(r => r.grade_status !== "GRADED");

  const relaxedPass = graded.filter(r => r.relaxed_pass);
  const baselineOnly = graded.filter(r => r.baseline_pass && !r.relaxed_pass);

  const relaxedStats = computeVariantStats(relaxedPass);
  const baselineOnlyStats = computeVariantStats(baselineOnly);
  const decision = computeDecision(graded, relaxedStats, baselineOnlyStats);

  const isHybrid = setupType === "SQ_SHORT_HYBRID_SHADOW";

  return {
    setup_type: setupType,
    total_rows: all.length,
    graded_rows: graded.length,
    ungraded_rows: ungraded.length,
    candidate_only_total: all.filter(r => r.shadow_only).length,
    relaxed_pass: relaxedStats,
    baseline_only: baselineOnlyStats,
    decision,
    segments: computeSegments(graded, "setup_type", "regime"),
    clustering: computeClustering(all),
    distance_buckets: isHybrid ? computeDistanceBuckets(relaxedPass) : undefined,
    recent_graded: graded.slice(0, 5).map(compact),
    recent_ungraded: ungraded.slice(0, 5).map(compact),
  };
}

// ── Production grade summary ─────────────────────────────

export async function computeProductionGradeSummary(): Promise<ProductionGradeSummary> {
  const supabase = getSupabase();

  const { data: rows, error } = await supabase
    .from("production_signal_grades")
    .select("*")
    .order("created_at", { ascending: false });

  if (error) throw new Error(`production_signal_grades query failed: ${error.message}`);

  const all = rows ?? [];
  const graded = all.filter(r => r.grade_status === "GRADED");
  const pending = all.filter(r => r.grade_status === "PENDING");
  const failedCount = all.filter(r => r.grade_status === "FAILED").length;

  const gradedStats = computeVariantStats(graded.map(r => ({ ...r, adx_1h: 0 })));
  const segments = computeSegments(
    graded.map(r => ({ ...r, adx_1h: 0 })),
    "alert_type",
    "btc_regime"
  );

  return {
    total: all.length,
    graded: graded.length,
    pending: pending.length,
    failed: failedCount,
    win_rate_tp1: gradedStats.win_rate_tp1,
    avg_r: gradedStats.avg_r,
    by_setup: segments.by_setup,
    by_regime: segments.by_regime,
  };
}

// ── Claude reviewer stats ────────────────────────────────

export async function computeClaudeStats(): Promise<ClaudeReviewerStats> {
  const supabase = getSupabase();

  // Try querying claude_decision — column may not exist if migration 004 wasn't applied
  const { data: rows, error } = await supabase
    .from("decisions")
    .select("alert_type, btc_regime, decision, gate_b_passed")
    .in("decision", ["LONG", "SHORT", "MR_LONG", "MR_SHORT", "SQ_SHORT", "NO_TRADE"])
    .eq("gate_b_passed", true);

  if (error) throw new Error(`Claude stats query failed: ${error.message}`);

  // Without claude_decision column, approximate from gate_b_passed=true decisions:
  // If gate_b passed and final decision is a trade → Claude approved (or wasn't invoked)
  // If gate_b passed and final decision is NO_TRADE → Claude blocked it
  const all = rows ?? [];
  const trades = ["LONG", "SHORT", "MR_LONG", "MR_SHORT", "SQ_SHORT"];
  const approved = all.filter(r => trades.includes(r.decision));
  const rejected = all.filter(r => r.decision === "NO_TRADE");

  const bySetup: Record<string, { reviewed: number; approved: number; pass_rate: number }> = {};
  const byRegime: Record<string, { reviewed: number; approved: number; pass_rate: number }> = {};

  for (const field of ["alert_type", "btc_regime"] as const) {
    const target = field === "alert_type" ? bySetup : byRegime;
    const keys = Array.from(new Set(all.map(r => String(r[field] ?? "unknown"))));
    for (const key of keys) {
      const sub = all.filter(r => r[field] === key);
      const subApproved = sub.filter(r => trades.includes(r.decision));
      target[key] = {
        reviewed: sub.length,
        approved: subApproved.length,
        pass_rate: sub.length > 0 ? round(subApproved.length / sub.length, 4) : 0,
      };
    }
  }

  return {
    total_reviewed: all.length,
    approved: approved.length,
    rejected: rejected.length,
    pass_rate: all.length > 0 ? round(approved.length / all.length, 4) : 0,
    by_setup: bySetup,
    by_regime: byRegime,
  };
}
