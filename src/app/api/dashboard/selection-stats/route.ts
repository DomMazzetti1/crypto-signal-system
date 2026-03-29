import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";

export const dynamic = "force-dynamic";

/**
 * GET /api/dashboard/selection-stats
 *
 * Minimal research surface for comparing selected vs suppressed outcomes.
 *
 * ELIGIBILITY RULES:
 *   Only rows meeting ALL of these criteria are included in comparison stats:
 *   1. decision is LONG or SHORT (no NO_TRADE)
 *   2. graded_outcome is non-null (signal is resolved)
 *   3. graded_outcome is not INVALID, CANCELLED, or STALE_ENTRY
 *   4. selected_for_execution or suppressed_reason is non-null
 *      (row was actually tagged by cluster selection logic — pre-migration
 *       rows without selection metadata are excluded to avoid contamination)
 *
 * WIN RATE DEFINITION:
 *   (WIN_FULL + WIN_PARTIAL) / eligible_for_rate
 *   where eligible_for_rate = total minus INVALID/CANCELLED/STALE_ENTRY outcomes
 *   Returned as a percentage, e.g. 66.7
 *
 * Requires migration 014 columns. Returns schema_available: false if not applied.
 */
export async function GET(req: NextRequest) {
  const supabase = getSupabase();

  const days = Number(req.nextUrl.searchParams.get("days") || "90");
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  // Try querying extended columns — if they don't exist, return gracefully
  const { data: rows, error } = await supabase
    .from("decisions")
    .select("selected_for_execution, suppressed_reason, cluster_rank, graded_outcome")
    .in("decision", ["LONG", "SHORT", "MR_LONG", "MR_SHORT"])
    .gte("created_at", cutoff);

  if (error) {
    if (error.message.includes("does not exist")) {
      return NextResponse.json({
        schema_available: false,
        message: "Migration 014 not applied — selection stats unavailable",
      });
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const allRows = rows ?? [];

  // Split into resolved vs unresolved.
  const resolved = allRows.filter((r) => r.graded_outcome != null);
  const unresolved = allRows.filter((r) => r.graded_outcome == null);

  // Outcomes excluded from win-rate denominator
  const nonComparisonOutcomes = new Set(["INVALID", "CANCELLED", "STALE_ENTRY"]);

  // Rows eligible for selected-vs-suppressed comparison:
  // must have graded_outcome AND must have been tagged by cluster selection logic
  const tagged = resolved.filter(
    (r) => r.selected_for_execution === true || r.suppressed_reason != null
  );
  const untagged = resolved.filter(
    (r) => r.selected_for_execution !== true && r.suppressed_reason == null
  );

  function computeStats(subset: typeof resolved) {
    const total = subset.length;
    const winFull = subset.filter((r) => r.graded_outcome === "WIN_FULL").length;
    // Win rate treats WIN_PARTIAL, WIN_PARTIAL_THEN_SL, and WIN_PARTIAL_EXPIRED as wins
    const winPartial = subset.filter((r) =>
      r.graded_outcome === "WIN_PARTIAL" ||
      r.graded_outcome === "WIN_PARTIAL_THEN_SL" ||
      r.graded_outcome === "WIN_PARTIAL_EXPIRED"
    ).length;
    const loss = subset.filter((r) => r.graded_outcome === "LOSS").length;
    const expired = subset.filter((r) => r.graded_outcome === "EXPIRED").length;
    const excluded = subset.filter((r) => nonComparisonOutcomes.has(r.graded_outcome)).length;
    const eligibleForRate = total - excluded;
    const winRate =
      eligibleForRate > 0
        ? Math.round(((winFull + winPartial) / eligibleForRate) * 1000) / 10
        : null;

    return {
      total,
      win_full: winFull,
      win_partial: winPartial,
      loss,
      expired,
      excluded,
      eligible_for_rate: eligibleForRate,
      win_rate: winRate,
    };
  }

  const selected = tagged.filter((r) => r.selected_for_execution === true);
  const suppressed = tagged.filter((r) => r.suppressed_reason != null && r.selected_for_execution !== true);

  const rank1 = tagged.filter((r) => r.cluster_rank === 1);
  const rank2plus = tagged.filter((r) => r.cluster_rank != null && r.cluster_rank > 1);

  return NextResponse.json({
    schema_available: true,
    // Win rate = (WIN_FULL + WIN_PARTIAL) / (total - INVALID - CANCELLED - STALE_ENTRY)
    win_rate_definition: "(WIN_FULL + WIN_PARTIAL) / eligible, excl INVALID/CANCELLED/STALE_ENTRY",
    total_resolved: resolved.length,
    total_unresolved: unresolved.length,
    comparison_eligible: tagged.length,
    comparison_excluded_untagged: untagged.length,
    by_selection: {
      selected: computeStats(selected),
      suppressed: computeStats(suppressed),
    },
    by_rank: {
      rank_1: computeStats(rank1),
      rank_2_plus: computeStats(rank2plus),
    },
  });
}
