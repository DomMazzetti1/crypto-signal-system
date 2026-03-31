import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";

export const dynamic = "force-dynamic";

/**
 * Returns signals blocked by MAX_CONCURRENT_POSITIONS, sorted by composite score.
 * Shows what we WOULD have traded if position slots were unlimited.
 * Protected by CRON_SECRET.
 *
 * Usage: GET /api/debug/missed-signals
 *   ?days=7  (optional, default 7, max 30)
 */
export async function GET(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const auth = request.headers.get("authorization");
    if (auth !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  const days = Math.min(
    parseInt(request.nextUrl.searchParams.get("days") ?? "7", 10) || 7,
    30
  );
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  const supabase = getSupabase();

  const { data, error } = await supabase
    .from("decisions")
    .select("symbol, alert_type, decision, created_at, composite_score, risk_check_result, graded_outcome")
    .not("risk_check_result", "is", null)
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(200);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Filter to position-cap blocks
  const blocked = (data || []).filter((d) => {
    const rc = d.risk_check_result as Record<string, unknown> | null;
    return (
      rc &&
      typeof rc === "object" &&
      typeof rc.reason === "string" &&
      rc.reason.includes("MAX_CONCURRENT")
    );
  });

  // Compute what we missed
  const graded = blocked.filter((b) => b.graded_outcome);
  const wins = graded.filter(
    (b) => typeof b.graded_outcome === "string" && b.graded_outcome.startsWith("WIN")
  );
  const losses = graded.filter((b) => b.graded_outcome === "LOSS");

  return NextResponse.json({
    days,
    total_blocked: blocked.length,
    graded: graded.length,
    wins: wins.length,
    losses: losses.length,
    missed_win_rate:
      graded.length > 0
        ? `${((wins.length / graded.length) * 100).toFixed(1)}%`
        : "n/a",
    signals: blocked.slice(0, 50).map((b) => ({
      symbol: b.symbol,
      alert_type: b.alert_type,
      composite_score: b.composite_score,
      graded_outcome: b.graded_outcome,
      created_at: b.created_at,
    })),
  });
}
