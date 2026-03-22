import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";

export const dynamic = "force-dynamic";

/**
 * GET /api/scanner/near-misses?days=7
 *
 * Aggregates near_miss_scans over the requested window and returns:
 * - per-setup pass-count histograms (how close setups get to firing)
 * - per-setup condition fail frequency (which condition blocks most)
 * - first-fail ranking (the single blocking condition for each evaluation)
 * - metric distributions across the universe
 * - best near-miss examples (closest to firing)
 */
export async function GET(request: NextRequest) {
  const days = Math.min(Number(request.nextUrl.searchParams.get("days") ?? 7), 30);
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  const supabase = getSupabase();
  const { data: rows, error } = await supabase
    .from("near_miss_scans")
    .select("*")
    .gte("scanned_at", since)
    .order("scanned_at", { ascending: false });

  if (error) {
    return NextResponse.json({ error: "Failed to fetch near-miss data", detail: error.message }, { status: 500 });
  }

  if (!rows || rows.length === 0) {
    return NextResponse.json({
      status: "no_data",
      message: `No near-miss scans found in last ${days} days. Scanner must run with the instrumentation deployed.`,
      runs: 0,
    });
  }

  // Merge all rows into aggregated views
  const totalRuns = rows.length;
  const totalSymbolEvals = rows.reduce((s, r) => s + (r.symbols_evaluated || 0), 0);

  // 1. Aggregate pass-count histograms
  const mergedHistograms: Record<string, Record<string, number>> = {};
  for (const row of rows) {
    const hist = row.pass_count_histograms as Record<string, Record<string, number>>;
    for (const [setup, counts] of Object.entries(hist)) {
      if (!mergedHistograms[setup]) mergedHistograms[setup] = {};
      for (const [passCount, freq] of Object.entries(counts)) {
        mergedHistograms[setup][passCount] = (mergedHistograms[setup][passCount] || 0) + freq;
      }
    }
  }

  // 2. Aggregate condition fail counts
  const mergedFailCounts: Record<string, Record<string, number>> = {};
  for (const row of rows) {
    const fc = row.condition_fail_counts as Record<string, Record<string, number>>;
    for (const [setup, counts] of Object.entries(fc)) {
      if (!mergedFailCounts[setup]) mergedFailCounts[setup] = {};
      for (const [cond, freq] of Object.entries(counts)) {
        mergedFailCounts[setup][cond] = (mergedFailCounts[setup][cond] || 0) + freq;
      }
    }
  }

  // 3. Aggregate condition pass counts
  const mergedPassCounts: Record<string, Record<string, number>> = {};
  for (const row of rows) {
    const pc = row.condition_pass_counts as Record<string, Record<string, number>>;
    for (const [setup, counts] of Object.entries(pc)) {
      if (!mergedPassCounts[setup]) mergedPassCounts[setup] = {};
      for (const [cond, freq] of Object.entries(counts)) {
        mergedPassCounts[setup][cond] = (mergedPassCounts[setup][cond] || 0) + freq;
      }
    }
  }

  // 4. Aggregate first-fail counts
  const mergedFirstFail: Record<string, Record<string, number>> = {};
  for (const row of rows) {
    const ff = row.first_fail_counts as Record<string, Record<string, number>>;
    for (const [setup, counts] of Object.entries(ff)) {
      if (!mergedFirstFail[setup]) mergedFirstFail[setup] = {};
      for (const [cond, freq] of Object.entries(counts)) {
        mergedFirstFail[setup][cond] = (mergedFirstFail[setup][cond] || 0) + freq;
      }
    }
  }

  // 5. Average metric distributions across runs
  const metricKeys = ["adx_1h", "adx_4h", "rsi", "z_score", "volume_sma_ratio", "bb_width_ratio"];
  const pctKeys = ["min", "p10", "p25", "p50", "p75", "p90", "max"];
  const avgDistributions: Record<string, Record<string, number>> = {};

  for (const metric of metricKeys) {
    const accum: Record<string, number[]> = {};
    for (const pk of pctKeys) accum[pk] = [];

    for (const row of rows) {
      const dist = (row.metric_distributions as Record<string, Record<string, number>>)?.[metric];
      if (dist) {
        for (const pk of pctKeys) {
          if (dist[pk] !== undefined) accum[pk].push(dist[pk]);
        }
      }
    }

    avgDistributions[metric] = {};
    for (const pk of pctKeys) {
      if (accum[pk].length > 0) {
        avgDistributions[metric][pk] = Math.round(accum[pk].reduce((a, b) => a + b, 0) / accum[pk].length * 100) / 100;
      }
    }
  }

  // 6. Collect best near-misses across all runs (top 5 per setup)
  const allBestBySetup: Record<string, { symbol: string; passed: number; total: number; first_fail: string | null; metrics: Record<string, number>; scanned_at: string }[]> = {};
  for (const row of rows) {
    const bests = row.best_near_misses as { setup_type: string; symbol: string; passed: number; total: number; first_fail: string | null; metrics: Record<string, number> }[];
    for (const b of bests) {
      if (!allBestBySetup[b.setup_type]) allBestBySetup[b.setup_type] = [];
      allBestBySetup[b.setup_type].push({ ...b, scanned_at: row.scanned_at });
    }
  }
  // Sort by passed desc, keep top 5
  const topNearMisses: Record<string, typeof allBestBySetup[string]> = {};
  for (const [setup, entries] of Object.entries(allBestBySetup)) {
    topNearMisses[setup] = entries
      .sort((a, b) => b.passed - a.passed)
      .slice(0, 5);
  }

  // 7. Compute per-setup summary
  const setupSummaries: Record<string, {
    total_evaluations: number;
    near_miss_5plus: number;
    near_miss_6plus: number;
    most_common_blocker: string | null;
    condition_fail_rate: Record<string, string>;
  }> = {};

  for (const setup of Object.keys(mergedHistograms)) {
    const hist = mergedHistograms[setup];
    const total = Object.values(hist).reduce((s, n) => s + n, 0);
    const nearMiss5 = Object.entries(hist)
      .filter(([k]) => Number(k) >= 5)
      .reduce((s, [, n]) => s + n, 0);
    const nearMiss6 = Object.entries(hist)
      .filter(([k]) => Number(k) >= 6)
      .reduce((s, [, n]) => s + n, 0);

    // Most common first-fail
    const ff = mergedFirstFail[setup] || {};
    const sorted = Object.entries(ff).sort((a, b) => b[1] - a[1]);
    const mostCommon = sorted.length > 0 ? sorted[0][0] : null;

    // Condition fail rates
    const failRates: Record<string, string> = {};
    const fc = mergedFailCounts[setup] || {};
    const pc = mergedPassCounts[setup] || {};
    for (const cond of Object.keys({ ...fc, ...pc })) {
      const fails = fc[cond] || 0;
      const passes = pc[cond] || 0;
      const evalTotal = fails + passes;
      if (evalTotal > 0) {
        failRates[cond] = `${Math.round(fails / evalTotal * 100)}% (${fails}/${evalTotal})`;
      }
    }

    setupSummaries[setup] = {
      total_evaluations: total,
      near_miss_5plus: nearMiss5,
      near_miss_6plus: nearMiss6,
      most_common_blocker: mostCommon,
      condition_fail_rate: failRates,
    };
  }

  return NextResponse.json({
    window_days: days,
    runs_analyzed: totalRuns,
    total_symbol_evaluations: totalSymbolEvals,
    oldest_scan: rows[rows.length - 1].scanned_at,
    newest_scan: rows[0].scanned_at,

    setup_summaries: setupSummaries,
    pass_count_histograms: mergedHistograms,
    first_fail_ranking: mergedFirstFail,
    metric_distributions: avgDistributions,
    top_near_misses: topNearMisses,
  });
}
