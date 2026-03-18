import { NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";

export const dynamic = "force-dynamic";

export async function GET() {
  const supabase = getSupabase();

  const [universeRes, lastBuildRes, decisionsRes] = await Promise.all([
    supabase
      .from("universe")
      .select("symbol", { count: "exact", head: true })
      .eq("is_eligible", true),
    supabase
      .from("universe")
      .select("updated_at")
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase
      .from("decisions")
      .select("id", { count: "exact", head: true })
      .in("decision", ["LONG", "SHORT"])
      .gte("created_at", new Date().toISOString().slice(0, 10)),
  ]);

  return NextResponse.json({
    eligible_symbols: universeRes.count ?? 0,
    last_universe_build: lastBuildRes.data?.updated_at ?? null,
    signals_today: decisionsRes.count ?? 0,
  });
}
