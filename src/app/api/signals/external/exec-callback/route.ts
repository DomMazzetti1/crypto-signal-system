import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";

export const dynamic = "force-dynamic";

/**
 * POST /api/signals/external/exec-callback
 *
 * Receives position lifecycle events from the execution engine.
 * - POSITION_OPENED: stamps exec_opened_at on the decision
 * - Close events: updates graded_outcome and resolution_path
 *
 * Expected payload:
 * {
 *   decision_id: string,
 *   status: "POSITION_OPENED" | "SL_HIT" | "TP1_HIT" | "TP2_HIT" | "TP3_HIT" | "EXPIRED" | "EXEC_REJECTED",
 *   realized_pnl?: number,
 *   close_price?: number,
 *   closed_at?: string,
 * }
 */

const STATUS_TO_OUTCOME: Record<string, { graded_outcome: string; resolution_path: string }> = {
  SL_HIT: { graded_outcome: "LOSS", resolution_path: "EXEC_SL" },
  TP1_HIT: { graded_outcome: "WIN_TP1", resolution_path: "EXEC_TP1" },
  TP2_HIT: { graded_outcome: "WIN_TP2", resolution_path: "EXEC_TP2" },
  TP3_HIT: { graded_outcome: "WIN_TP3", resolution_path: "EXEC_TP3" },
  EXPIRED: { graded_outcome: "EXPIRED", resolution_path: "EXEC_EXPIRED" },
  EXEC_REJECTED: { graded_outcome: "EXEC_REJECTED", resolution_path: "EXEC_REJECTED" },
};

export async function POST(request: NextRequest) {
  // Auth: accept either EXEC_WEBHOOK_SECRET or CRON_SECRET
  const execSecret = process.env.EXEC_WEBHOOK_SECRET;
  const cronSecret = process.env.CRON_SECRET;
  const provided = request.headers.get("x-webhook-secret") ?? request.headers.get("authorization")?.replace("Bearer ", "");

  if (execSecret || cronSecret) {
    if (provided !== execSecret && provided !== cronSecret) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
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

  const supabase = getSupabase();

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

  const mapping = STATUS_TO_OUTCOME[status];
  if (!mapping) {
    return NextResponse.json({ error: `Unknown status: ${status}` }, { status: 400 });
  }

  // Don't overwrite existing graded_outcome (first-hit semantics)
  const { data: existing } = await supabase
    .from("decisions")
    .select("id, graded_outcome")
    .eq("id", decisionId)
    .maybeSingle();

  if (!existing) {
    return NextResponse.json({ error: `Decision ${decisionId} not found` }, { status: 404 });
  }

  if (existing.graded_outcome) {
    console.log(`[exec-callback] Decision ${decisionId} already graded as ${existing.graded_outcome} — skipping ${status}`);
    return NextResponse.json({
      updated: false,
      reason: `already graded as ${existing.graded_outcome}`,
    });
  }

  const { error } = await supabase
    .from("decisions")
    .update({
      graded_outcome: mapping.graded_outcome,
      resolution_path: mapping.resolution_path,
      resolved_at: (body.closed_at as string) ?? new Date().toISOString(),
    })
    .eq("id", decisionId);

  if (error) {
    console.error(`[exec-callback] Failed to update decision ${decisionId}:`, error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  console.log(`[exec-callback] Decision ${decisionId}: ${status} → ${mapping.graded_outcome} (${mapping.resolution_path})`);
  return NextResponse.json({
    updated: true,
    decision_id: decisionId,
    graded_outcome: mapping.graded_outcome,
    resolution_path: mapping.resolution_path,
  });
}
