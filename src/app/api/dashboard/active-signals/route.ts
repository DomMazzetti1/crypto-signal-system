import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { parseBybitResponse } from "@/lib/bybit";

export const dynamic = "force-dynamic";

const BYBIT_BASE = "https://api.bybit.com/v5/market";

// Fetch all linear perpetual tickers in one call, return map symbol → markPrice
async function fetchAllPrices(): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  try {
    const res = await fetch(`${BYBIT_BASE}/tickers?category=linear`, {
      cache: "no-store",
    });
    const data = await parseBybitResponse(res, "Batch tickers");
    if (data.retCode !== 0) return map;
    const list = data.result.list as { symbol: string; markPrice: string }[];
    for (const t of list) {
      const p = parseFloat(t.markPrice);
      if (Number.isFinite(p)) map.set(t.symbol, p);
    }
  } catch {
    // price enrichment is best-effort
  }
  return map;
}

function computeStatus(
  decision: string,
  current: number | null,
  entry: number | null,
  stop: number | null,
  tp1: number | null,
  tp2: number | null,
  tp3: number | null
): string {
  if (current == null || entry == null) return "UNKNOWN";

  if (decision === "LONG") {
    if (stop != null && current <= stop) return "STOPPED";
    if (tp3 != null && current >= tp3) return "TP3_HIT";
    if (tp2 != null && current >= tp2) return "TP2_HIT";
    if (tp1 != null && current >= tp1) return "TP1_HIT";
    return "OPEN";
  } else {
    // SHORT
    if (stop != null && current >= stop) return "STOPPED";
    if (tp3 != null && current <= tp3) return "TP3_HIT";
    if (tp2 != null && current <= tp2) return "TP2_HIT";
    if (tp1 != null && current <= tp1) return "TP1_HIT";
    return "OPEN";
  }
}

function computePctToTp1(
  decision: string,
  current: number | null,
  entry: number | null,
  tp1: number | null
): number | null {
  if (current == null || entry == null || tp1 == null) return null;
  if (decision === "LONG") {
    const range = tp1 - entry;
    if (range === 0) return null;
    return ((current - entry) / range) * 100;
  } else {
    const range = entry - tp1;
    if (range === 0) return null;
    return ((entry - current) / range) * 100;
  }
}

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
       rr_tp1, rr_tp2,
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

  // Run DB query and price fetch in parallel
  const [dbResult, prices] = await Promise.all([query, fetchAllPrices()]);

  const { data: decisions, error } = dbResult;

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const signals = (decisions ?? []).map((d) => {
    const isRelaxed = /_RELAXED$/i.test(d.alert_type);
    const derivedTier = isRelaxed ? "RELAXED" : "STRICT";
    const setupFamily = d.alert_type.replace(/_RELAXED$|_DATA$/i, "");

    const currentPrice = prices.get(d.symbol) ?? null;
    const status = computeStatus(
      d.decision,
      currentPrice,
      d.entry_price,
      d.stop_price,
      d.tp1_price,
      d.tp2_price,
      d.tp3_price
    );
    const pctToTp1 = computePctToTp1(
      d.decision,
      currentPrice,
      d.entry_price,
      d.tp1_price
    );

    // Simple score: rr_tp1 is the primary signal quality metric available
    const score = d.rr_tp1 != null ? Number(d.rr_tp1) : 0;

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
      rr_tp1: d.rr_tp1,
      current_price: currentPrice,
      status,
      pct_to_tp1: pctToTp1,
      score,
      telegram_sent: d.telegram_sent,
      telegram_attempted: d.telegram_attempted,
      blocked_reason: d.blocked_reason,
      gate_a_quality: d.gate_a_quality,
      gate_b_passed: d.gate_b_passed,
    };
  });

  return NextResponse.json({
    signals,
    count: signals.length,
    prices_loaded: prices.size > 0,
  });
}
