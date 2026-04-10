import { type AIReviewResult } from "@/lib/ai-signal-reviewer";

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
  ai_review?: AIReviewResult;
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

  // ── Header with AI verdict ────────────────────────────
  let header = `${icon} ${escapeHtml(input.decision)} — ${escapeHtml(input.symbol)}`;
  if (input.ai_review) {
    const vi =
      input.ai_review.overall_verdict === "strong_setup"
        ? "✅"
        : input.ai_review.overall_verdict === "marginal"
          ? "⚠️"
          : "❌";
    header += `   ${vi} AI: ${escapeHtml(input.ai_review.overall_verdict)} (${input.ai_review.confidence}/100)`;
  }

  // ── Price levels (single block: AI if present, else system) ──
  const ai = input.ai_review;
  const stopLine = ai && Math.abs(ai.suggested_stop - input.stop) / input.stop > 0.001
    ? `<b>SL</b>    ${formatPrice(input.stop)} (AI: ${formatPrice(ai.suggested_stop)})`
    : `<b>SL</b>    ${formatPrice(input.stop)}`;

  let tpBlock: string;
  if (ai) {
    tpBlock = `<b>TP1</b>   ${formatPrice(ai.tp1_price)}  — ${escapeHtml(ai.tp1_rationale)}
<b>TP2</b>   ${formatPrice(ai.tp2_price)}  — ${escapeHtml(ai.tp2_rationale)}`;
    if (ai.tp3_price != null && ai.tp3_rationale) {
      tpBlock += `\n<b>TP3</b>   ${formatPrice(ai.tp3_price)}  — ${escapeHtml(ai.tp3_rationale)}`;
    }
  } else {
    tpBlock = `<b>TP1</b>   ${formatPrice(input.tp1)}
<b>TP2</b>   ${formatPrice(input.tp2)}
<b>TP3</b>   ${formatPrice(input.tp3)}`;
  }

  // ── Metadata line ─────────────────────────────────────
  const fundingPct = (input.funding_rate * 100).toFixed(4);
  const flags = input.risk_flags.length > 0
    ? input.risk_flags.map(escapeHtml).join(", ")
    : "none";

  // ── Reasoning ─────────────────────────────────────────
  const reasoningText = ai
    ? `<i>${escapeHtml(ai.reasoning)}</i>`
    : escapeHtml(input.reasoning);

  // ── Confidence (only show system confidence when no AI review) ──
  const confidenceLine = ai ? "" : `\nConfidence: ${input.confidence}/10`;

  // ── Concerns ──────────────────────────────────────────
  const concernsLine = ai && ai.concerns.length > 0
    ? `\n⚠️ ${ai.concerns.map(escapeHtml).join(", ")}`
    : "";

  return `${header}

<b>Entry</b> ${formatPrice(input.entry)}
${stopLine}
${tpBlock}

Regime: ${escapeHtml(input.btc_regime)} / ${escapeHtml(input.alt_environment)} · Funding: ${fundingPct}%
Risk: ${flags}${confidenceLine}

${reasoningText}${concernsLine}`;
}

export async function sendTelegram(text: string): Promise<boolean> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    console.warn("[telegram] Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID, skipping");
    return false;
  }

  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const body = JSON.stringify({
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
  });

  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) {
      await new Promise(r => setTimeout(r, attempt * 1000)); // 1s, 2s backoff
    }
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });
      if (res.ok) {
        console.log("[telegram] Message sent successfully");
        return true;
      }
      const responseBody = await res.text();
      console.error(`[telegram] Send failed attempt ${attempt + 1} (${res.status}): ${responseBody}`);
      // Don't retry on 4xx client errors (except 429)
      if (res.status >= 400 && res.status < 500 && res.status !== 429) break;
    } catch (err) {
      console.error(`[telegram] Network error attempt ${attempt + 1}:`, err);
    }
  }
  return false;
}
