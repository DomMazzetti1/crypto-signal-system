import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { computeStrategyAudit } from "@/lib/strategy-audit";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const supabase = getSupabase();
  const days = Number(req.nextUrl.searchParams.get("days") || "90");
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  const { data, error } = await supabase
    .from("decisions")
    .select(
      "alert_type, decision, btc_regime, graded_outcome, resolution_path, telegram_sent, selected_for_execution, suppressed_reason, blocked_reason"
    )
    .in("decision", ["LONG", "SHORT", "MR_LONG", "MR_SHORT"])
    .gte("created_at", cutoff);

  if (error) {
    if (error.message.includes("does not exist")) {
      return NextResponse.json(
        {
          schema_available: false,
          message: "Strategy audit requires the extended decisions schema",
        },
        { status: 200 }
      );
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const audit = computeStrategyAudit(data ?? []);

  return NextResponse.json({
    schema_available: true,
    generated_at: new Date().toISOString(),
    days,
    ...audit,
  });
}
