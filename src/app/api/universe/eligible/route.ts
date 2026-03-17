import { NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";

export const dynamic = "force-dynamic";

export async function GET() {
  const { data, error } = await getSupabase()
    .from("universe")
    .select("symbol")
    .eq("is_eligible", true)
    .order("symbol");

  if (error) {
    console.error("Failed to query eligible universe:", error);
    return NextResponse.json({ error: "Query failed" }, { status: 500 });
  }

  const symbols = data.map((r) => r.symbol);

  return NextResponse.json({
    count: symbols.length,
    symbols,
  });
}
