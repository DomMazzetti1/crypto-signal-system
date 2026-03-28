import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const supabase = getSupabase();
  const { searchParams } = req.nextUrl;

  // Time window filter (default 24h)
  const hours = Number(searchParams.get("hours") || "24");
  const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

  // Tier filter: "strict" | "relaxed" | undefined (all)
  const tier = searchParams.get("tier");

  let query = supabase
    .from("decisions")
    .select(
      `id, symbol, decision, alert_type, alert_tf, created_at,
       entry_price, stop_price, tp1_price, tp2_price, tp3_price,
       telegram_sent, telegram_attempted, blocked_reason,
       gate_a_quality, gate_b_passed, gate_b_reason,
       alert_id`
    )
    .in("decision", ["LONG", "SHORT"])
    .gte("created_at", cutoff)
    .order("created_at", { ascending: false })
    .limit(100);

  if (tier === "strict") {
    query = query.not("alert_type", "ilike", "%_RELAXED");
  } else if (tier === "relaxed") {
    query = query.ilike("alert_type", "%_RELAXED");
  }

  const { data: decisions, error } = await query;

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Enrich with tier derived from alert_type
  const signals = (decisions ?? []).map((d) => {
    const isRelaxed = /_RELAXED$/i.test(d.alert_type);
    const derivedTier = isRelaxed ? "RELAXED" : "STRICT";
    const setupFamily = d.alert_type.replace(/_RELAXED$|_DATA$/i, "");

    return {
      id: d.id,
      symbol: d.symbol,
      decision: d.decision,
      alert_type: d.alert_type,
      setup_family: setupFamily,
      tier: derivedTier,
      alert_tf: d.alert_tf,
      created_at: d.created_at,
      entry_price: d.entry_price,
      stop_price: d.stop_price,
      tp1_price: d.tp1_price,
      tp2_price: d.tp2_price,
      tp3_price: d.tp3_price,
      telegram_sent: d.telegram_sent,
      telegram_attempted: d.telegram_attempted,
      blocked_reason: d.blocked_reason,
      gate_a_quality: d.gate_a_quality,
      gate_b_passed: d.gate_b_passed,
    };
  });

  return NextResponse.json({ signals, count: signals.length });
}
