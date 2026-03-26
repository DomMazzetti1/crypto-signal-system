import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { DEFAULT_SIGNAL_PARAMS } from "@/lib/signals";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

/**
 * GET /api/debug/production-health
 *
 * Quick snapshot of live production signal config, recent signals,
 * and delivery health. Uses a fresh Supabase client per request
 * to avoid stale data from warm serverless instances.
 */
export async function GET() {
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );

  // Current live config
  const liveConfig = {
    sq_trigger_mode: DEFAULT_SIGNAL_PARAMS.sq_trigger_mode,
    sq_volume_mult: DEFAULT_SIGNAL_PARAMS.sq_volume_mult,
    sq_adx_1h_max: DEFAULT_SIGNAL_PARAMS.sq_adx_1h_max,
    sq_4h_distance_pct: DEFAULT_SIGNAL_PARAMS.sq_4h_distance_pct,
    sq_bb_width_max: 0.12,
    mr_adx_1h_max: DEFAULT_SIGNAL_PARAMS.mr_adx_1h_max,
    mr_adx_4h_max: DEFAULT_SIGNAL_PARAMS.mr_adx_4h_max,
  };

  // Recent decisions (last 7 days)
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  // Query only columns that exist in the live schema.
  // Migration 013 (telegram_attempted, telegram_sent, telegram_error, blocked_reason)
  // may not be applied yet — try with delivery columns first, fall back without.
  let decisions: Record<string, unknown>[] = [];
  let hasDeliveryColumns = false;

  const { data: withDelivery, error: delErr } = await supabase
    .from("decisions")
    .select("id, symbol, alert_type, decision, gate_a_passed, gate_b_passed, gate_b_reason, btc_regime, telegram_attempted, telegram_sent, telegram_error, blocked_reason, created_at")
    .gte("created_at", sevenDaysAgo)
    .order("created_at", { ascending: false })
    .limit(20);

  if (!delErr && withDelivery) {
    decisions = withDelivery;
    hasDeliveryColumns = true;
  } else {
    // Fall back to base columns only
    const { data: base } = await supabase
      .from("decisions")
      .select("id, symbol, alert_type, decision, gate_a_passed, gate_b_passed, gate_b_reason, btc_regime, created_at")
      .gte("created_at", sevenDaysAgo)
      .order("created_at", { ascending: false })
      .limit(20);
    decisions = base ?? [];
  }

  // Delivery stats
  const trades = decisions.filter(d => d.decision === "LONG" || d.decision === "SHORT");
  const noTrades = decisions.filter(d => d.decision === "NO_TRADE");
  const attempted = hasDeliveryColumns ? decisions.filter(d => d.telegram_attempted) : [];
  const sent = hasDeliveryColumns ? decisions.filter(d => d.telegram_sent) : [];
  const sendFails = hasDeliveryColumns ? decisions.filter(d => d.telegram_attempted && !d.telegram_sent) : [];

  // Recent scanner runs
  const { data: recentRuns } = await supabase
    .from("scanner_runs")
    .select("completed_at, symbols_scanned, candidates_found, candidates_queued, runtime_ms")
    .order("completed_at", { ascending: false })
    .limit(5);

  // Near miss latest
  const { data: latestNearMiss } = await supabase
    .from("near_miss_scans")
    .select("scanned_at, symbols_evaluated")
    .order("scanned_at", { ascending: false })
    .limit(1);

  return NextResponse.json({
    generated_at: new Date().toISOString(),

    live_config: liveConfig,

    signal_flow_7d: {
      total_decisions: decisions.length,
      trades: trades.length,
      no_trades: noTrades.length,
      telegram_attempted: attempted.length,
      telegram_sent: sent.length,
      telegram_failed: sendFails.length,
    },

    recent_send_failures: sendFails.slice(0, 5).map(d => ({
      symbol: d.symbol, decision: d.decision, error: d.telegram_error, created_at: d.created_at,
    })),

    recent_decisions: decisions.slice(0, 10).map(d => ({
      symbol: d.symbol,
      alert_type: d.alert_type,
      decision: d.decision,
      gate_a: d.gate_a_passed,
      gate_b: d.gate_b_passed,
      gate_b_reason: d.gate_b_reason,
      telegram_sent: d.telegram_sent,
      blocked: d.blocked_reason,
      created_at: d.created_at,
    })),

    scanner_recent: recentRuns ?? [],
    near_miss_latest: latestNearMiss?.[0] ?? null,
  });
}
