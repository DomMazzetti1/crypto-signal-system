// Sends a signal to the execution engine webhook
// Non-blocking: failures are logged but never prevent Telegram delivery or pipeline completion
// Only fires if EXEC_WEBHOOK_URL is set in env

export interface ExecSignalPayload {
  symbol: string;
  direction: 'LONG' | 'SHORT';
  entry_price: number;
  stop_price: number;
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

    if (res.ok) {
      console.log(`[exec-webhook] Sent signal: ${payload.symbol} ${payload.direction} to execution engine`);
      return true;
    }

    console.error(`[exec-webhook] Failed to send signal: HTTP ${res.status}`);
    return false;
  } catch (err) {
    console.error(`[exec-webhook] Failed to send signal: ${err}`);
    return false;
  }
}
