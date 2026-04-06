import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";

export const dynamic = "force-dynamic";

/**
 * POST /api/signals/external/exec-callback
 *
 * Receives position lifecycle events from the execution engine.
 * - POSITION_OPENED: stamps exec_opened_at on the decision
 * - TP0_HIT / TP1_HIT / TP2_HIT: stamps partial lifecycle markers without resolving the trade
 * - Close events: updates graded_outcome and resolution_path
 *
 * Expected payload:
 * {
 *   decision_id: string,
 *   status: "POSITION_OPENED" | "TP0_HIT" | "TP1_HIT" | "SL_HIT" | "TP2_HIT" | "TP3_HIT" | "EXPIRED" | "EXEC_REJECTED",
 *   realized_pnl?: number,
 *   close_price?: number,
 *   closed_at?: string,
 *   funding_cost_usd?: number,           // total funding paid (negative = cost)
 *   funding_settlements?: object[],       // individual settlement records
 *   funding_settlement_count?: number,    // count of settlements
 * }
 */

type DecisionState = {
  id: string;
  graded_outcome: string | null;
  tp0_price?: number | string | null;
  tp1_price?: number | string | null;
  tp1_hit_at?: string | null;
  tp2_hit_at?: string | null;
  tp3_hit_at?: string | null;
  stopped_at?: string | null;
};

const OVERWRITABLE_EXEC_OUTCOMES = new Set(["WIN_TP1", "WIN_TP2", "WIN_TP3"]);
const KNOWN_STATUSES = new Set([
  "POSITION_OPENED",
  "TP0_HIT",
  "TP1_HIT",
  "SL_HIT",
  "TP2_HIT",
  "TP3_HIT",
  "EXPIRED",
  "EXEC_REJECTED",
]);

function buildPath(parts: string[]): string {
  return parts.join("->");
}

function parseMaybeNumber(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function hasLegacyTp0(existing: DecisionState): boolean {
  const tp0Price = parseMaybeNumber(existing.tp0_price);
  const tp1Price = parseMaybeNumber(existing.tp1_price);
  return (
    tp0Price != null &&
    tp1Price != null &&
    tp0Price > 0 &&
    Math.abs(tp0Price - tp1Price) > 1e-9
  );
}

function deriveTerminalOutcome(
  status: string,
  existing: DecisionState,
  eventAt: string
): {
  graded_outcome: string;
  resolution_path: string;
  resolved_at: string;
  tp2_hit_at?: string;
  tp3_hit_at?: string;
  stopped_at?: string;
} {
  const pathParts = ["ENTRY"];
  if (existing.tp1_hit_at) pathParts.push("TP1");
  if (existing.tp2_hit_at) pathParts.push("TP2");
  if (existing.tp3_hit_at) pathParts.push("TP3");

  if (status === "TP3_HIT") {
    if (!pathParts.includes("TP2")) pathParts.push("TP2");
    if (!pathParts.includes("TP3")) pathParts.push("TP3");
    return {
      graded_outcome: "WIN_FULL",
      resolution_path: buildPath(pathParts),
      resolved_at: eventAt,
      tp2_hit_at: existing.tp2_hit_at ?? eventAt,
      tp3_hit_at: eventAt,
    };
  }

  if (status === "SL_HIT") {
    pathParts.push("SL");
    return {
      graded_outcome: existing.tp1_hit_at ? "WIN_PARTIAL_THEN_SL" : "LOSS",
      resolution_path: buildPath(pathParts),
      resolved_at: eventAt,
      stopped_at: eventAt,
    };
  }

  if (status === "EXPIRED") {
    pathParts.push("EXPIRED");
    return {
      graded_outcome: existing.tp1_hit_at ? "WIN_PARTIAL_EXPIRED" : "EXPIRED",
      resolution_path: buildPath(pathParts),
      resolved_at: eventAt,
    };
  }

  return {
    graded_outcome: "EXEC_REJECTED",
    resolution_path: "EXEC_REJECTED",
    resolved_at: eventAt,
  };
}

export async function POST(request: NextRequest) {
  // Auth: accept either EXEC_WEBHOOK_SECRET or CRON_SECRET
  const execSecret = process.env.EXEC_WEBHOOK_SECRET;
  const cronSecret = process.env.CRON_SECRET;
  const provided = request.headers.get("x-webhook-secret") ?? request.headers.get("authorization")?.replace("Bearer ", "");

  if (!execSecret && !cronSecret) {
    console.error('[exec-callback] CRITICAL: No auth secrets configured — rejecting all requests');
    return NextResponse.json({ error: "Server misconfiguration" }, { status: 500 });
  }

  if (provided !== execSecret && provided !== cronSecret) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const decisionId = body.decision_id as string | undefined;
  const status = body.status as string | undefined;

  if (!decisionId || !status) {
    return NextResponse.json({ error: "Missing required fields: decision_id, status" }, { status: 400 });
  }

  if (!KNOWN_STATUSES.has(status)) {
    return NextResponse.json({ error: `Unknown status: ${status}` }, { status: 400 });
  }

  const supabase = getSupabase();
  const eventAt = (body.closed_at as string) ?? new Date().toISOString();

  // Handle POSITION_OPENED: just stamp exec_opened_at
  if (status === "POSITION_OPENED") {
    const { error } = await supabase
      .from("decisions")
      .update({ exec_opened_at: new Date().toISOString() })
      .eq("id", decisionId);

    if (error) {
      console.error(`[exec-callback] Failed to set exec_opened_at for ${decisionId}:`, error.message);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    console.log(`[exec-callback] Decision ${decisionId}: POSITION_OPENED — exec_opened_at set`);
    return NextResponse.json({ updated: true, decision_id: decisionId, status: "POSITION_OPENED" });
  }

  if (status === "TP0_HIT") {
    console.log(`[exec-callback] Decision ${decisionId}: TP0_HIT acknowledged`);
    return NextResponse.json({ updated: false, decision_id: decisionId, status: "TP0_HIT" });
  }

  const primaryRead = await supabase
    .from("decisions")
    .select("id, graded_outcome, tp0_price, tp1_price, tp1_hit_at, tp2_hit_at, tp3_hit_at, stopped_at")
    .eq("id", decisionId)
    .maybeSingle();

  let existing: DecisionState | null = primaryRead.data as DecisionState | null;
  let readError = primaryRead.error;

  if (readError?.message.includes("does not exist")) {
    const fallback = await supabase
      .from("decisions")
      .select("id, graded_outcome, tp1_hit_at, tp2_hit_at, tp3_hit_at, stopped_at")
      .eq("id", decisionId)
      .maybeSingle();
    existing = fallback.data as DecisionState | null;
    readError = fallback.error;
  }

  if (readError) {
    console.error(`[exec-callback] Failed to read decision ${decisionId}:`, readError.message);
    return NextResponse.json({ error: readError.message }, { status: 500 });
  }

  if (!existing) {
    return NextResponse.json({ error: `Decision ${decisionId} not found` }, { status: 404 });
  }

  const legacyTp0Position = hasLegacyTp0(existing);

  if (
    existing.graded_outcome &&
    !OVERWRITABLE_EXEC_OUTCOMES.has(existing.graded_outcome)
  ) {
    console.log(`[exec-callback] Decision ${decisionId} already graded as ${existing.graded_outcome} — skipping ${status}`);
    return NextResponse.json({
      updated: false,
      reason: `already graded as ${existing.graded_outcome}`,
    });
  }

  if (status === "TP1_HIT") {
    const { error } = await supabase
      .from("decisions")
      .update({ tp1_hit_at: eventAt })
      .eq("id", decisionId);

    if (error) {
      console.error(`[exec-callback] Failed to set tp1_hit_at for ${decisionId}:`, error.message);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    console.log(`[exec-callback] Decision ${decisionId}: TP1_HIT — tp1_hit_at set`);
    return NextResponse.json({ updated: true, decision_id: decisionId, status: "TP1_HIT" });
  }

  if (status === "TP2_HIT" && !legacyTp0Position) {
    const { error } = await supabase
      .from("decisions")
      .update({ tp2_hit_at: eventAt })
      .eq("id", decisionId);

    if (error) {
      console.error(`[exec-callback] Failed to set tp2_hit_at for ${decisionId}:`, error.message);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    console.log(`[exec-callback] Decision ${decisionId}: TP2_HIT — tp2_hit_at set`);
    return NextResponse.json({ updated: true, decision_id: decisionId, status: "TP2_HIT" });
  }

  const mapping =
    status === "TP2_HIT" && legacyTp0Position
      ? {
          graded_outcome: "WIN_FULL",
          resolution_path: existing.tp1_hit_at ? "ENTRY->TP1->TP2" : "ENTRY->TP2",
          resolved_at: eventAt,
          tp2_hit_at: eventAt,
          tp3_hit_at: undefined,
          stopped_at: undefined,
        }
      : deriveTerminalOutcome(status, existing, eventAt);
  const { error } = await supabase
    .from("decisions")
    .update({
      graded_outcome: mapping.graded_outcome,
      resolution_path: mapping.resolution_path,
      resolved_at: mapping.resolved_at,
      tp2_hit_at: mapping.tp2_hit_at,
      tp3_hit_at: mapping.tp3_hit_at,
      stopped_at: mapping.stopped_at,
    })
    .eq("id", decisionId);

  if (error) {
    console.error(`[exec-callback] Failed to update decision ${decisionId}:`, error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  console.log(`[exec-callback] Decision ${decisionId}: ${status} → ${mapping.graded_outcome} (${mapping.resolution_path})`);

  // For full-close events, persist funding data to production_signal_grades
  const isFullCloseStatus =
    status === "SL_HIT" ||
    status === "TP3_HIT" ||
    status === "EXPIRED" ||
    (status === "TP2_HIT" && legacyTp0Position);
  if (isFullCloseStatus) {
    const fundingCostUsd = typeof body.funding_cost_usd === "number" ? body.funding_cost_usd : null;
    const fundingSettlements = Array.isArray(body.funding_settlements) ? body.funding_settlements : null;
    const fundingSettlementCount = typeof body.funding_settlement_count === "number" ? body.funding_settlement_count : null;

    if (fundingCostUsd !== null || fundingSettlements !== null) {
      const fundingUpdate: Record<string, unknown> = {};
      if (fundingCostUsd !== null) fundingUpdate.funding_cost_usd = fundingCostUsd;
      if (fundingSettlements !== null) fundingUpdate.funding_settlements = fundingSettlements;
      if (fundingSettlementCount !== null) fundingUpdate.funding_settlement_count = fundingSettlementCount;

      const { error: gradeError } = await supabase
        .from("production_signal_grades")
        .update(fundingUpdate)
        .eq("decision_id", decisionId);

      if (gradeError) {
        // Non-fatal: log but don't fail the callback
        console.warn(`[exec-callback] Failed to update funding on production_signal_grades for ${decisionId}:`, gradeError.message);
      } else {
        console.log(`[exec-callback] Decision ${decisionId}: funding_cost_usd=$${fundingCostUsd?.toFixed(4)} (${fundingSettlementCount ?? 0} settlements) written to grades`);
      }
    }
  }

  return NextResponse.json({
    updated: true,
    decision_id: decisionId,
    graded_outcome: mapping.graded_outcome,
    resolution_path: mapping.resolution_path,
  });
}
