import { NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";

export const dynamic = "force-dynamic";

/**
 * GET /api/dashboard/selection-stats
 *
 * Minimal research surface for comparing selected vs suppressed outcomes.
 * Only counts rows with non-null graded_outcome (resolved signals).
 *
 * Win rate definition:
 *   (WIN_FULL + WIN_PARTIAL) / (total resolved, excluding INVALID and CANCELLED)
 *
 * Returns:
 *   - by_selection: selected vs suppressed outcome counts and win rates
 *   - by_rank: rank 1 vs rank 2+ outcome counts and win rates
 *   - total_resolved: total signals with a graded outcome
 *   - total_unresolved: signals without a graded outcome yet
 *
 * Requires migration 014 columns. Returns schema_available: false if not applied.
 */
export async function GET() {
  const supabase = getSupabase();

  // Try querying extended columns — if they don't exist, return gracefully
  const { data: rows, error } = await supabase
    .from("decisions")
    .select("selected_for_execution, suppressed_reason, cluster_rank, graded_outcome")
    .in("decision", ["LONG", "SHORT"])
    .not("graded_outcome", "is", null);

  if (error) {
    if (error.message.includes("does not exist")) {
      return NextResponse.json({
        schema_available: false,
        message: "Migration 014 not applied — selection stats unavailable",
      });
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Also count unresolved
  const { count: unresolvedCount } = await supabase
    .from("decisions")
    .select("id", { count: "exact", head: true })
    .in("decision", ["LONG", "SHORT"])
    .is("graded_outcome", null);

  const resolved = rows ?? [];

  // Exclude INVALID and CANCELLED from win rate calculation
  const excludedOutcomes = new Set(["INVALID", "CANCELLED", "STALE_ENTRY"]);

  function computeStats(subset: typeof resolved) {
    const total = subset.length;
    const winFull = subset.filter((r) => r.graded_outcome === "WIN_FULL").length;
    const winPartial = subset.filter((r) => r.graded_outcome === "WIN_PARTIAL").length;
    const loss = subset.filter((r) => r.graded_outcome === "LOSS").length;
    const expired = subset.filter((r) => r.graded_outcome === "EXPIRED").length;
    const eligible = subset.filter((r) => !excludedOutcomes.has(r.graded_outcome)).length;
    const winRate = eligible > 0 ? (winFull + winPartial) / eligible : null;

    return { total, win_full: winFull, win_partial: winPartial, loss, expired, eligible_for_rate: eligible, win_rate: winRate != null ? Math.round(winRate * 1000) / 10 : null };
  }

  const selected = resolved.filter((r) => r.selected_for_execution === true);
  const suppressed = resolved.filter((r) => r.suppressed_reason != null);
  const neither = resolved.filter((r) => !r.selected_for_execution && !r.suppressed_reason);

  const rank1 = resolved.filter((r) => r.cluster_rank === 1);
  const rank2plus = resolved.filter((r) => r.cluster_rank != null && r.cluster_rank > 1);

  return NextResponse.json({
    schema_available: true,
    total_resolved: resolved.length,
    total_unresolved: unresolvedCount ?? 0,
    by_selection: {
      selected: computeStats(selected),
      suppressed: computeStats(suppressed),
      untagged: computeStats(neither),
    },
    by_rank: {
      rank_1: computeStats(rank1),
      rank_2_plus: computeStats(rank2plus),
    },
  });
}
