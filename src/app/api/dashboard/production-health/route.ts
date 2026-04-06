import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

interface DecisionRow {
  symbol: string;
  alert_type: string;
  decision: string;
  gate_b_passed: boolean | null;
  gate_b_reason: string | null;
  telegram_sent?: boolean | null;
  telegram_attempted?: boolean | null;
  blocked_reason?: string | null;
  selected_for_execution?: boolean | null;
  created_at: string;
}

/**
 * Public dashboard-safe production snapshot.
 *
 * Returns only the fields consumed by the homepage so the UI does not depend
 * on the broader debug endpoint.
 */
export async function GET() {
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );

  const sevenDaysAgo = new Date(
    Date.now() - 7 * 24 * 60 * 60 * 1000
  ).toISOString();

  let decisions: DecisionRow[] = [];
  let hasTelegramColumn = false;

  const { data: withDelivery, error: deliveryError } = await supabase
    .from("decisions")
    .select(
      "symbol, alert_type, decision, gate_b_passed, gate_b_reason, telegram_sent, telegram_attempted, blocked_reason, selected_for_execution, created_at"
    )
    .gte("created_at", sevenDaysAgo)
    .order("created_at", { ascending: false })
    .limit(20);

  if (!deliveryError && withDelivery) {
    decisions = withDelivery;
    hasTelegramColumn = true;
  } else {
    const { data: base } = await supabase
      .from("decisions")
      .select("symbol, alert_type, decision, gate_b_passed, gate_b_reason, created_at")
      .gte("created_at", sevenDaysAgo)
      .order("created_at", { ascending: false })
      .limit(20);
    decisions = base ?? [];
  }

  const { data: recentRuns } = await supabase
    .from("scanner_runs")
    .select("completed_at, symbols_scanned, candidates_found, candidates_queued, runtime_ms")
    .order("completed_at", { ascending: false })
    .limit(5);

  return NextResponse.json({
    generated_at: new Date().toISOString(),
    recent_decisions: decisions.slice(0, 10).map((decision) => ({
      symbol: decision.symbol,
      alert_type: decision.alert_type,
      decision: decision.decision,
      gate_b: decision.gate_b_passed,
      gate_b_reason: decision.gate_b_reason,
      telegram_sent: hasTelegramColumn ? Boolean(decision.telegram_sent) : false,
      telegram_attempted: hasTelegramColumn ? Boolean(decision.telegram_attempted) : false,
      blocked_reason: hasTelegramColumn ? decision.blocked_reason ?? null : null,
      selected_for_execution: hasTelegramColumn ? Boolean(decision.selected_for_execution) : false,
      created_at: decision.created_at,
    })),
    scanner_recent: recentRuns ?? [],
  });
}
