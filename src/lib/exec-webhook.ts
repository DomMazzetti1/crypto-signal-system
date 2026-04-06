import { getSupabase } from "@/lib/supabase";
import { warnExecPayloadConsistency } from "@/lib/runtime-checks";

export interface ExecSignalPayload {
  symbol: string;
  direction: 'LONG' | 'SHORT';
  entry_price: number;
  stop_price: number;
  tp0_price?: number | null;
  tp1_price: number;
  tp2_price: number;
  tp3_price: number;
  risk_amount: number;
  btc_regime: string;
  composite_score: number;
  alert_type: string;
  confidence: number;
  decision_id: string;
  timestamp: string;
}

export async function sendToExecutionEngine(payload: ExecSignalPayload): Promise<boolean> {
  const url = process.env.EXEC_WEBHOOK_URL;
  if (!url) return false;

  try {
    warnExecPayloadConsistency(payload);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-webhook-secret": process.env.EXEC_WEBHOOK_SECRET ?? "",
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    const body = await res.json().catch(() => null);

    if (res.ok && body?.executed === true) {
      console.log(`[exec-webhook] Sent signal: ${payload.symbol} ${payload.direction} to execution engine`);
      return true;
    }

    // Exec engine rejected the signal — mark it in Supabase immediately
    const reason = body?.error ?? `HTTP ${res.status}`;
    console.warn(`[exec-webhook] Signal rejected by exec engine: ${payload.symbol} — ${reason}`);

    if (payload.decision_id) {
      const supabase = getSupabase();
      const { error } = await supabase
        .from("decisions")
        .update({
          graded_outcome: "EXEC_REJECTED",
          resolved_at: new Date().toISOString(),
          resolution_path: "EXEC_REJECTED",
        })
        .eq("id", payload.decision_id);

      if (error) {
        console.error(`[exec-webhook] Failed to mark decision ${payload.decision_id} as rejected:`, error.message);
      } else {
        console.log(`[exec-webhook] Marked decision ${payload.decision_id} as EXEC_REJECTED`);
      }
    }

    return false;
  } catch (err) {
    console.error(`[exec-webhook] Failed to send signal: ${err}`);
    return false;
  }
}
