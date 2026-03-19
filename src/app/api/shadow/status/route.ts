import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const supabase = getSupabase();

  const hoursParam = request.nextUrl.searchParams.get("hours");
  const hours = hoursParam ? parseInt(hoursParam, 10) : 168; // default 7 days
  const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

  const { data: rows, error } = await supabase
    .from("shadow_signals")
    .select("*")
    .gte("created_at", since)
    .order("created_at", { ascending: true });

  if (error) {
    return NextResponse.json({ error: "Failed to fetch shadow signals", detail: error.message }, { status: 500 });
  }

  if (!rows || rows.length === 0) {
    return NextResponse.json({
      message: `No shadow signals in last ${hours} hours`,
      total: 0,
    });
  }

  // Categorize
  const baselineOnly = rows.filter((r) => r.baseline_pass && !r.relaxed_pass);
  const relaxedOnly = rows.filter((r) => !r.baseline_pass && r.relaxed_pass);
  const both = rows.filter((r) => r.baseline_pass && r.relaxed_pass);
  const neither = rows.filter((r) => !r.baseline_pass && !r.relaxed_pass);

  // By setup type
  const setupTypes = ["MR_LONG", "MR_SHORT", "SQ_SHORT"];
  const bySetup: Record<string, { baseline: number; relaxed: number; both: number; relaxed_only: number }> = {};
  for (const st of setupTypes) {
    const subset = rows.filter((r) => r.setup_type === st);
    if (subset.length === 0) continue;
    bySetup[st] = {
      baseline: subset.filter((r) => r.baseline_pass).length,
      relaxed: subset.filter((r) => r.relaxed_pass).length,
      both: subset.filter((r) => r.baseline_pass && r.relaxed_pass).length,
      relaxed_only: subset.filter((r) => !r.baseline_pass && r.relaxed_pass).length,
    };
  }

  // By regime
  const regimeTypes = ["bull", "bear", "sideways"];
  const byRegime: Record<string, { baseline: number; relaxed: number; relaxed_only: number }> = {};
  for (const rt of regimeTypes) {
    const subset = rows.filter((r) => r.regime === rt);
    if (subset.length === 0) continue;
    byRegime[rt] = {
      baseline: subset.filter((r) => r.baseline_pass).length,
      relaxed: subset.filter((r) => r.relaxed_pass).length,
      relaxed_only: subset.filter((r) => !r.baseline_pass && r.relaxed_pass).length,
    };
  }

  // Relaxed-only candidates detail
  const relaxedOnlyDetail = relaxedOnly.map((r) => ({
    symbol: r.symbol,
    setup_type: r.setup_type,
    candle_time: r.candle_time,
    regime: r.regime,
    baseline_block_reason: r.baseline_block_reason,
    relaxed_block_reason: r.relaxed_block_reason,
    rsi: r.rsi,
    close_price: r.close_price,
  }));

  return NextResponse.json({
    period_hours: hours,
    total_evaluated: rows.length,

    summary: {
      baseline_pass: baselineOnly.length + both.length,
      relaxed_pass: relaxedOnly.length + both.length,
      both_pass: both.length,
      baseline_only: baselineOnly.length,
      relaxed_only: relaxedOnly.length,
      neither: neither.length,
    },

    frequency_comparison: {
      baseline_signals_per_day: rows.length > 0
        ? Math.round(((baselineOnly.length + both.length) / hours) * 24 * 100) / 100
        : 0,
      relaxed_signals_per_day: rows.length > 0
        ? Math.round(((relaxedOnly.length + both.length) / hours) * 24 * 100) / 100
        : 0,
      relaxed_uplift_pct: (baselineOnly.length + both.length) > 0
        ? Math.round((relaxedOnly.length / (baselineOnly.length + both.length)) * 100)
        : 0,
    },

    by_setup: bySetup,
    by_regime: byRegime,

    relaxed_only_candidates: relaxedOnlyDetail.length > 0 ? relaxedOnlyDetail : undefined,
  });
}
