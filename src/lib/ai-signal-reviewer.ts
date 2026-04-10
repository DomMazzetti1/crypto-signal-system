/**
 * AI Signal Reviewer — Sonnet-based analysis
 *
 * Replaces the Haiku reviewer. Every signal that passes gate-b gets sent
 * to Claude Sonnet for structural analysis. The AI picks dynamic TPs
 * based on actual chart structure, and the result is attached to the
 * Telegram alert for Yuri to validate.
 *
 * This is observation mode: AI informs, it does NOT gate signals.
 */

import Anthropic from "@anthropic-ai/sdk";
import {
  type MarketContextPayload,
  formatMarketContextForPrompt,
} from "@/lib/market-data-gatherer";

// ── Types ──────────────────────────────────────────────────

export interface AIReviewResult {
  confidence: number; // 0-100
  pattern: string;
  reasoning: string;
  tp1_price: number;
  tp1_rationale: string;
  tp2_price: number;
  tp2_rationale: string;
  tp3_price: number | null;
  tp3_rationale: string | null;
  suggested_stop: number;
  concerns: string[];
  overall_verdict: "strong_setup" | "marginal" | "avoid";
}

// ── Singleton client ───────────────────────────────────────

let _client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!_client) {
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) throw new Error("Missing ANTHROPIC_API_KEY");
    _client = new Anthropic({ apiKey: key });
  }
  return _client;
}

// ── System prompt ──────────────────────────────────────────

const SYSTEM_PROMPT = `You are an expert crypto derivatives trader reviewing a Bollinger Band squeeze short signal.

Your job: determine whether this is a REAL breakdown or whether the signal is fading support (i.e., shorting straight into a floor).

CRITICAL FRAMEWORK:
- Bottom-of-range + support retest = BAD SHORT. The price is bouncing off support, not breaking down. Shorting here catches the reversal.
- Top-of-range + clean breakdown through support = GOOD SHORT. Price has room to fall and is breaking a level convincingly.
- Middle-of-range + no clear level nearby = MARGINAL. The squeeze may resolve either way.

GOOD SHORT EXAMPLES:
- Price at 75th percentile of 7D range, breaking below a swing low that was tested 2-3x, volume expanding
- Clean lower-high pattern on 4H, with BTC also trending down
- Price rejected from a resistance level, BB squeeze resolving to the downside with volume

BAD SHORT EXAMPLES:
- Price at 10th percentile of 7D range, sitting right on a swing low that held 4+ times
- Price bouncing off a well-tested support with a long lower wick, squeeze just fired
- BTC in uptrend while alt is at range lows — macro tailwind fights the short
- Funding deeply negative (shorts crowded) at a support level

ANALYSIS STEPS:
1. Check where price sits in its own range (24h and 7d). Below 25% = danger zone for shorts.
2. Identify the nearest support below. How far? How many times tested? More tests = stronger support.
3. Check BTC context. Is BTC trending down (supports the short) or up (headwind)?
4. Check volume. Is the signal candle high volume (potential rejection) or low volume (drift)?
5. Check funding/OI. Negative funding + rising OI at lows = shorts crowded, squeeze risk.

For TPs: use ACTUAL chart structure. Find prior swing lows, prior consolidation zones, and prior 4H/1D support breaks. Do NOT use fixed R multiples. Each TP should reference a real level you can see in the data.

For suggested stop: use the nearest structural resistance above (swing high, prior breakdown level). If the system stop is reasonable, keep it. If you see a better structural level, suggest it and explain why.

You MUST respond with a JSON object using the submit_review tool.`;

const OUTPUT_SCHEMA = {
  type: "object" as const,
  properties: {
    confidence: {
      type: "integer" as const,
      minimum: 0,
      maximum: 100,
      description: "0-100 confidence in the short setup quality",
    },
    pattern: {
      type: "string" as const,
      description: "Short label: fading_support, clean_breakdown, retest_failure, choppy_range, momentum_short, support_break, range_low_bounce, etc.",
    },
    reasoning: {
      type: "string" as const,
      description: "2-3 sentence explanation of what you see in the chart structure",
    },
    tp1_price: {
      type: "number" as const,
      description: "First take-profit price based on chart structure",
    },
    tp1_rationale: {
      type: "string" as const,
      description: "Why this level (e.g., prior 4H swing low, consolidation zone)",
    },
    tp2_price: {
      type: "number" as const,
      description: "Second take-profit price",
    },
    tp2_rationale: {
      type: "string" as const,
      description: "Why this level",
    },
    tp3_price: {
      type: ["number", "null"] as const,
      description: "Third TP or null if no clean level within 2.5R",
    },
    tp3_rationale: {
      type: ["string", "null"] as const,
      description: "Why this level, or null",
    },
    suggested_stop: {
      type: "number" as const,
      description: "Suggested stop price — may differ from system stop if you see a better structural level",
    },
    concerns: {
      type: "array" as const,
      items: { type: "string" as const },
      description: "List of warning flags (support_nearby, btc_headwind, crowded_shorts, low_volume, etc.)",
    },
    overall_verdict: {
      type: "string" as const,
      enum: ["strong_setup", "marginal", "avoid"],
      description: "Overall assessment of the setup quality",
    },
  },
  required: [
    "confidence", "pattern", "reasoning",
    "tp1_price", "tp1_rationale",
    "tp2_price", "tp2_rationale",
    "tp3_price", "tp3_rationale",
    "suggested_stop", "concerns", "overall_verdict",
  ],
};

// ── Main review function ───────────────────────────────────

export async function reviewSignalWithSonnet(
  marketContext: MarketContextPayload
): Promise<AIReviewResult | null> {
  const client = getClient();
  const userMessage = formatMarketContextForPrompt(marketContext);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000); // 20s timeout

  try {
    const result = await client.messages.create(
      {
        model: "claude-sonnet-4-20250514",
        max_tokens: 2000,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: userMessage }],
        tools: [
          {
            name: "submit_review",
            description: "Submit the structured signal review with dynamic TPs",
            input_schema: OUTPUT_SCHEMA,
          },
        ],
        tool_choice: { type: "tool", name: "submit_review" },
      },
      { signal: controller.signal }
    );

    const toolBlock = result.content.find((b) => b.type === "tool_use");
    if (!toolBlock || toolBlock.type !== "tool_use") {
      console.error("[ai-reviewer] Sonnet did not return a tool_use block");
      return null;
    }

    const response = toolBlock.input as unknown as AIReviewResult;

    // Validate required fields
    if (
      typeof response.confidence !== "number" ||
      typeof response.pattern !== "string" ||
      typeof response.reasoning !== "string" ||
      typeof response.tp1_price !== "number" ||
      typeof response.tp2_price !== "number" ||
      typeof response.suggested_stop !== "number" ||
      typeof response.overall_verdict !== "string"
    ) {
      console.error("[ai-reviewer] Invalid response structure from Sonnet:", response);
      return null;
    }

    // Clamp confidence to valid range
    response.confidence = Math.max(0, Math.min(100, Math.round(response.confidence)));

    console.log(
      `[ai-reviewer] Sonnet: confidence=${response.confidence} pattern=${response.pattern} verdict=${response.overall_verdict}`
    );

    return response;
  } catch (err: unknown) {
    if (err instanceof Error && err.name === "AbortError") {
      console.error("[ai-reviewer] Sonnet request timed out (20s)");
    } else {
      console.error("[ai-reviewer] Sonnet API error:", err);
    }
    return null;
  } finally {
    clearTimeout(timeout);
  }
}
