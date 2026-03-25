export interface TelegramMessageInput {
  symbol: string;
  decision: string;
  entry: number;
  stop: number;
  tp1: number;
  tp2: number;
  tp3: number;
  confidence: number;
  setup_type: string;
  btc_regime: string;
  alt_environment: string;
  funding_rate: number;
  risk_flags: string[];
  reasoning: string;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function formatPrice(price: number): string {
  if (price >= 1000) return price.toFixed(2);
  if (price >= 1) return price.toFixed(4);
  return price.toFixed(6);
}

export function buildMessage(input: TelegramMessageInput): string {
  const icon =
    input.decision === "LONG"
      ? "🟢"
      : input.decision === "SHORT"
        ? "🔴"
        : "⚪";

  const fundingPct = (input.funding_rate * 100).toFixed(4);
  const flags = input.risk_flags.length > 0
    ? input.risk_flags.map(escapeHtml).join(", ")
    : "none";

  return `${icon} ${escapeHtml(input.decision)} — $${escapeHtml(input.symbol)}

Entry:  ${formatPrice(input.entry)}
SL:     ${formatPrice(input.stop)}
TP1:    ${formatPrice(input.tp1)}
TP2:    ${formatPrice(input.tp2)}
TP3:    ${formatPrice(input.tp3)}

Confidence: ${input.confidence}/10
Setup: ${escapeHtml(input.setup_type)}
Regime: ${escapeHtml(input.btc_regime)} / ${escapeHtml(input.alt_environment)}
Funding: ${fundingPct}%

Risk: ${flags}

${escapeHtml(input.reasoning)}`;
}

export async function sendTelegram(text: string): Promise<boolean> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    console.warn("[telegram] Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID, skipping");
    return false;
  }

  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    console.error(`[telegram] Send failed (${res.status}): ${body}`);
    return false;
  }

  console.log("[telegram] Message sent successfully");
  return true;
}
