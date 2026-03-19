import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { STRATEGY_PROFILE } from "@/lib/reviewer";

export const dynamic = "force-dynamic";

const DISABLED_SETUPS: readonly string[] = STRATEGY_PROFILE.disabled_setups;

// ── Types ───────────────────────────────────────────────

interface BacktestSignal {
  symbol: string;
  setup_type: string;
  candle_time: string;
  entry_price: number;
  stop_loss: number;
  tp1: number;
  tp2: number;
  tp3: number;
  hit_tp1: boolean;
  hit_tp2: boolean;
  hit_tp3: boolean;
  hit_sl: boolean;
  bars_to_resolution: number;
  max_favorable: number;
  max_adverse: number;
  regime: string;
  atr: number;
}

interface SetupStats {
  count: number;
  win_rate: number;
  avg_r: number;
}

// ── Judgment rubric ─────────────────────────────────────
// Deterministic, auditable rules for variant evaluation.
//
// REJECTION thresholds (hard gates — variant is unusable):
//   profit_factor < 1.75  →  edge too thin after fees
//   avg_r < 0.5           →  average trade barely positive
//
// EDGE quality tiers:
//   profit_factor >= 2.5 AND avg_r >= 1.0  →  HIGH
//   profit_factor >= 1.75 AND avg_r >= 0.5 →  MEDIUM
//   else                                   →  LOW (rejected)
//
// FREQUENCY quality tiers:
//   signals_per_30d >= 1.0  →  HIGH
//   signals_per_30d >= 0.5  →  MEDIUM
//   signals_per_30d < 0.5   →  LOW
//
// RECOMMENDATION:
//   Among non-rejected variants, prefer highest estimated_R_per_30d.
//   Flag if PF drops more than 30% vs baseline.

const REJECT_PF = 1.75;
const REJECT_AVG_R = 0.5;
const HIGH_EDGE_PF = 2.5;
const HIGH_EDGE_AVG_R = 1.0;
const HIGH_FREQ_PER_30D = 1.0;
const MED_FREQ_PER_30D = 0.5;
const PF_DECAY_WARN = 0.30; // 30% PF drop vs baseline triggers warning

// ── Helpers ─────────────────────────────────────────────

function computeR(sig: BacktestSignal): number {
  const risk = Math.abs(sig.entry_price - sig.stop_loss);
  if (risk === 0) return 0;
  if (sig.hit_tp3) return Math.abs(sig.tp3 - sig.entry_price) / risk;
  if (sig.hit_tp2) return Math.abs(sig.tp2 - sig.entry_price) / risk;
  if (sig.hit_tp1) return Math.abs(sig.tp1 - sig.entry_price) / risk;
  if (sig.hit_sl) return -1;
  return 0;
}

function round(n: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

// ── Fetch signals for a run group ───────────────────────

async function fetchRunGroupData(runGroupId: string) {
  const supabase = getSupabase();

  const { data: runs, error } = await supabase
    .from("backtest_runs")
    .select("id, run_at, symbols_tested, total_signals, summary, run_group_id, variant")
    .eq("run_group_id", runGroupId)
    .order("run_at", { ascending: true });

  if (error || !runs || runs.length === 0) {
    return null;
  }

  // Fetch signals
  const allSignals: BacktestSignal[] = [];
  for (const run of runs) {
    let offset = 0;
    const PAGE = 1000;
    while (true) {
      const { data: signals } = await supabase
        .from("backtest_signals")
        .select("symbol, setup_type, candle_time, entry_price, stop_loss, tp1, tp2, tp3, hit_tp1, hit_tp2, hit_tp3, hit_sl, bars_to_resolution, max_favorable, max_adverse, regime, atr")
        .eq("backtest_run_id", run.id)
        .range(offset, offset + PAGE - 1);

      if (!signals || signals.length === 0) break;
      for (const s of signals) {
        allSignals.push({
          symbol: s.symbol,
          setup_type: s.setup_type,
          candle_time: s.candle_time,
          entry_price: Number(s.entry_price),
          stop_loss: Number(s.stop_loss),
          tp1: Number(s.tp1),
          tp2: Number(s.tp2),
          tp3: Number(s.tp3),
          hit_tp1: s.hit_tp1,
          hit_tp2: s.hit_tp2,
          hit_tp3: s.hit_tp3,
          hit_sl: s.hit_sl,
          bars_to_resolution: s.bars_to_resolution,
          max_favorable: Number(s.max_favorable),
          max_adverse: Number(s.max_adverse),
          regime: s.regime,
          atr: Number(s.atr),
        });
      }
      if (signals.length < PAGE) break;
      offset += PAGE;
    }
  }

  const variant = runs[0]?.variant ?? "baseline";
  const variantConfig = runs[0]?.summary?.variant_config ?? null;

  return { runs, allSignals, variant, variantConfig };
}

// ── Compute metrics for a signal set ────────────────────

function computeMetrics(allSignals: BacktestSignal[]) {
  const liveSignals = allSignals.filter((s) => !DISABLED_SETUPS.includes(s.setup_type));

  const total = liveSignals.length;
  const wins = liveSignals.filter((s) => s.hit_tp1).length;
  const losses = liveSignals.filter((s) => s.hit_sl && !s.hit_tp1).length;
  const rValues = liveSignals.map(computeR);
  const avgR = total > 0 ? rValues.reduce((a, b) => a + b, 0) / total : 0;
  const grossProfit = rValues.filter((r) => r > 0).reduce((a, b) => a + b, 0);
  const grossLoss = Math.abs(rValues.filter((r) => r < 0).reduce((a, b) => a + b, 0));
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;
  const expectancy = total > 0
    ? (wins / total) * (grossProfit / (wins || 1)) - (losses / total) * (grossLoss / (losses || 1))
    : 0;

  // Period
  const candleTimes = liveSignals.map((s) => new Date(s.candle_time).getTime());
  const earliestMs = candleTimes.length > 0 ? Math.min(...candleTimes) : 0;
  const latestMs = candleTimes.length > 0 ? Math.max(...candleTimes) : 0;
  const tradingDays = candleTimes.length > 0
    ? Math.max(1, Math.round((latestMs - earliestMs) / (1000 * 60 * 60 * 24)))
    : 0;

  // Frequency
  const signalsPer30d = tradingDays > 0 ? (total / tradingDays) * 30 : 0;
  const estimatedRPer30d = tradingDays > 0 ? (avgR * total / tradingDays) * 30 : 0;

  // By setup
  const setupTypes = ["MR_SHORT", "SQ_SHORT"] as const;
  const by_setup: Record<string, SetupStats> = {};
  for (const st of setupTypes) {
    const subset = liveSignals.filter((s) => s.setup_type === st);
    const subRs = subset.map(computeR);
    by_setup[st] = {
      count: subset.length,
      win_rate: subset.length > 0 ? subset.filter((s) => s.hit_tp1).length / subset.length : 0,
      avg_r: subset.length > 0 ? subRs.reduce((a, b) => a + b, 0) / subset.length : 0,
    };
  }

  // By setup × regime
  const regimeTypes = ["bull", "bear", "sideways"] as const;
  const by_setup_regime: Record<string, SetupStats> = {};
  for (const st of setupTypes) {
    for (const rt of regimeTypes) {
      const key = `${st}_${rt}`;
      const subset = liveSignals.filter((s) => s.setup_type === st && s.regime === rt);
      if (subset.length === 0) continue;
      const subRs = subset.map(computeR);
      by_setup_regime[key] = {
        count: subset.length,
        win_rate: subset.filter((s) => s.hit_tp1).length / subset.length,
        avg_r: subRs.reduce((a, b) => a + b, 0) / subset.length,
      };
    }
  }

  return {
    total_signals: total,
    win_rate_tp1: round(wins / Math.max(total, 1), 4),
    profit_factor: round(profitFactor, 2),
    expectancy: round(expectancy, 4),
    avg_r: round(avgR, 2),
    trading_days: tradingDays,
    signals_per_30d: round(signalsPer30d, 2),
    estimated_R_per_30d: round(estimatedRPer30d, 2),
    by_setup: Object.fromEntries(
      Object.entries(by_setup).map(([k, v]) => [
        k, { count: v.count, win_rate: round(v.win_rate, 4), avg_r: round(v.avg_r, 2) },
      ])
    ),
    by_setup_regime: Object.fromEntries(
      Object.entries(by_setup_regime).map(([k, v]) => [
        k, { count: v.count, win_rate: round(v.win_rate, 4), avg_r: round(v.avg_r, 2) },
      ])
    ),
  };
}

// ── Apply judgment rubric ───────────────────────────────

function judgeVariant(
  metrics: ReturnType<typeof computeMetrics>,
  baselinePF: number | null
): {
  edge_quality: "HIGH" | "MEDIUM" | "LOW";
  frequency_quality: "HIGH" | "MEDIUM" | "LOW";
  rejected: boolean;
  reject_reasons: string[];
  pf_decay_warning: string | null;
  recommended_action: string;
} {
  const rejectReasons: string[] = [];

  if (metrics.profit_factor < REJECT_PF) {
    rejectReasons.push(`profit_factor ${metrics.profit_factor} < ${REJECT_PF}`);
  }
  if (metrics.avg_r < REJECT_AVG_R) {
    rejectReasons.push(`avg_r ${metrics.avg_r} < ${REJECT_AVG_R}`);
  }

  const rejected = rejectReasons.length > 0;

  // Edge quality
  let edge_quality: "HIGH" | "MEDIUM" | "LOW";
  if (metrics.profit_factor >= HIGH_EDGE_PF && metrics.avg_r >= HIGH_EDGE_AVG_R) {
    edge_quality = "HIGH";
  } else if (metrics.profit_factor >= REJECT_PF && metrics.avg_r >= REJECT_AVG_R) {
    edge_quality = "MEDIUM";
  } else {
    edge_quality = "LOW";
  }

  // Frequency quality
  let frequency_quality: "HIGH" | "MEDIUM" | "LOW";
  if (metrics.signals_per_30d >= HIGH_FREQ_PER_30D) {
    frequency_quality = "HIGH";
  } else if (metrics.signals_per_30d >= MED_FREQ_PER_30D) {
    frequency_quality = "MEDIUM";
  } else {
    frequency_quality = "LOW";
  }

  // PF decay warning
  let pf_decay_warning: string | null = null;
  if (baselinePF !== null && baselinePF > 0) {
    const decay = (baselinePF - metrics.profit_factor) / baselinePF;
    if (decay > PF_DECAY_WARN) {
      pf_decay_warning = `PF dropped ${round(decay * 100, 1)}% vs baseline (${baselinePF} → ${metrics.profit_factor})`;
    }
  }

  return {
    edge_quality,
    frequency_quality,
    rejected,
    reject_reasons: rejectReasons.length > 0 ? rejectReasons : [],
    pf_decay_warning,
    recommended_action: "", // filled in by the comparison logic
  };
}

// ── Main handler ────────────────────────────────────────

export async function GET(request: NextRequest) {
  const runGroupIdsParam = request.nextUrl.searchParams.get("run_group_ids");
  if (!runGroupIdsParam) {
    return NextResponse.json(
      { error: "Missing required ?run_group_ids= parameter. Provide comma-separated run_group_ids to compare." },
      { status: 400 }
    );
  }

  const runGroupIds = runGroupIdsParam.split(",").map((s) => s.trim()).filter(Boolean);
  if (runGroupIds.length < 2) {
    return NextResponse.json(
      { error: "Provide at least 2 run_group_ids to compare." },
      { status: 400 }
    );
  }

  // Fetch data for all groups
  const results: {
    run_group_id: string;
    variant: string;
    variant_config: unknown;
    metrics: ReturnType<typeof computeMetrics>;
    judgment: ReturnType<typeof judgeVariant>;
  }[] = [];

  const groupData: { run_group_id: string; data: Awaited<ReturnType<typeof fetchRunGroupData>> }[] = [];
  for (const gid of runGroupIds) {
    const data = await fetchRunGroupData(gid);
    groupData.push({ run_group_id: gid, data });
  }

  // Find baseline PF for decay comparison
  let baselinePF: number | null = null;
  for (const { data } of groupData) {
    if (data && data.variant === "baseline") {
      const m = computeMetrics(data.allSignals);
      baselinePF = m.profit_factor;
      break;
    }
  }

  // Compute metrics and judgment for each group
  for (const { run_group_id, data } of groupData) {
    if (!data) {
      results.push({
        run_group_id,
        variant: "unknown",
        variant_config: null,
        metrics: computeMetrics([]),
        judgment: {
          edge_quality: "LOW",
          frequency_quality: "LOW",
          rejected: true,
          reject_reasons: ["No data found for this run_group_id"],
          pf_decay_warning: null,
          recommended_action: "NO_DATA",
        },
      });
      continue;
    }

    const metrics = computeMetrics(data.allSignals);
    const judgment = judgeVariant(metrics, baselinePF);

    results.push({
      run_group_id,
      variant: data.variant,
      variant_config: data.variantConfig,
      metrics,
      judgment,
    });
  }

  // Determine recommended_action for each variant
  const nonRejected = results.filter((r) => !r.judgment.rejected);
  let bestVariant: string | null = null;
  let bestRPer30d = -Infinity;

  for (const r of nonRejected) {
    if (r.metrics.estimated_R_per_30d > bestRPer30d) {
      bestRPer30d = r.metrics.estimated_R_per_30d;
      bestVariant = r.variant;
    }
  }

  for (const r of results) {
    if (r.judgment.rejected) {
      r.judgment.recommended_action = `REJECT_${r.variant.toUpperCase()}`;
    } else if (r.variant === bestVariant) {
      if (r.variant === "baseline") {
        r.judgment.recommended_action = "KEEP_BASELINE";
      } else {
        r.judgment.recommended_action = `TEST_${r.variant.toUpperCase()}`;
      }
    } else {
      r.judgment.recommended_action = `INFERIOR_TO_${bestVariant?.toUpperCase()}`;
    }
  }

  // Build comparison summary
  const summary = {
    best_variant: bestVariant,
    best_estimated_R_per_30d: bestRPer30d !== -Infinity ? round(bestRPer30d, 2) : null,
    rubric: {
      reject_if: `profit_factor < ${REJECT_PF} OR avg_r < ${REJECT_AVG_R}`,
      prefer: "highest estimated_R_per_30d among non-rejected variants",
      warn_if: `profit_factor drops > ${PF_DECAY_WARN * 100}% vs baseline`,
      edge_high: `PF >= ${HIGH_EDGE_PF} AND avg_r >= ${HIGH_EDGE_AVG_R}`,
      frequency_high: `signals_per_30d >= ${HIGH_FREQ_PER_30D}`,
    },
  };

  return NextResponse.json({
    comparison: results.map((r) => ({
      run_group_id: r.run_group_id,
      variant: r.variant,
      variant_config: r.variant_config,
      ...r.metrics,
      judgment: r.judgment,
    })),
    summary,
  });
}
