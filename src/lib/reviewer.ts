import Anthropic from "@anthropic-ai/sdk";
import { getSupabase } from "@/lib/supabase";

let _client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!_client) {
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) throw new Error("Missing ANTHROPIC_API_KEY");
    _client = new Anthropic({ apiKey: key });
  }
  return _client;
}

export interface ClaudeReviewInput {
  symbol: string;
  direction: string;
  alert_tf: string;
  alert_price: number;
  alert_rsi: number;
  alert_adx1h: number;
  alert_adx4h: number;
  alert_bb_width: number;
  mark_price: number;
  funding_rate: number;
  turnover_24h: number;
  spread_bps: number;
  open_interest_value: number;
  book_depth_bid_usd: number;
  book_depth_ask_usd: number;
  oi_delta_5m: number | null;
  oi_delta_15m: number | null;
  oi_delta_1h: number | null;
  trend_4h: string;
  trend_1d: string;
  ema20_4h: number;
  ema50_4h: number;
  atr14_1h: number;
  atr14_4h: number;
  btc_regime: string;
  alt_environment: string;
  entry: number;
  stop: number;
  tp1: number;
  tp2: number;
  tp3: number;
  rr_tp1: number;
  snapshot_quality: string;
  gate_a_quality: string;
  gate_b_passed: boolean;
  // Enrichment context from data collector
  enrichment_funding_rate: number | null;
  enrichment_funding_interval: number | null;
  enrichment_oi_delta_1h_pct: number | null;
  enrichment_oi_delta_4h_pct: number | null;
  enrichment_spread_pct: number | null;
  enrichment_btc_correlation: number | null;
  enrichment_btc_beta: number | null;
}

export interface ClaudeReviewOutput {
  decision: "INVALID" | "NO_TRADE" | "LONG" | "SHORT";
  confidence: number;
  setup_type: string;
  level_review: {
    entry_valid: boolean;
    stop_valid: boolean;
    targets_valid: boolean;
  };
  invalid_if: string;
  reasoning: string;
  risk_flags: string[];
  data_quality: string;
  suggested_adjustments: {
    entry_note: string;
    stop_note: string;
    target_note: string;
  };
}

// ── Strategy profile ─────────────────────────────────────
// Single source of truth for reviewer context.
// Update this object when backtest results change.
// Do NOT embed raw numbers in the prompt string.

export const STRATEGY_PROFILE = {
  // Setup tier rankings (informed by backtest, not hardcoded stats)
  primary_setup: "SQ_SHORT",
  secondary_setup: "MR_SHORT",
  disabled_setups: ["MR_LONG", "SQ_LONG"],

  // Regime rules for ENABLED setups only (must match gate-b.ts enforcement)
  // Disabled setups (MR_LONG, SQ_LONG) are excluded by strategy policy
  // before reaching the reviewer — do not describe their Gate B rules here.
  regime_rules: {
    bear: {
      favored: "SQ_SHORT",
      blocked: "MR_SHORT is blocked by Gate B (0% historical win rate)",
      enabled_note: "Only SQ_SHORT signals reach the reviewer in bear regime",
    },
    bull: {
      favored: "MR_SHORT (mean reversion into overbought conditions)",
      restricted: "SQ_SHORT requires RSI > 75 and ADX < 15 to pass Gate B",
    },
    sideways: {
      favored: "MR_SHORT and SQ_SHORT",
      restricted: "SQ_SHORT requires volume > 2x SMA20 to pass Gate B",
    },
  },
} as const;

const SYSTEM_PROMPT = `You are a crypto signal reviewer.
You do not create trades.
You do not invent price levels.
You review candidates that already passed deterministic checks.
Return INVALID if data quality is insufficient.
Return NO_TRADE if setup is not worth forwarding.
Return LONG or SHORT only if setup is coherent, regime-aligned, and materially worth acting on.
Use only supplied fields.
Keep reasoning to 2 sentences maximum.
Do not invent facts.

Setup types you will see (only enabled setups reach you):
- ${STRATEGY_PROFILE.primary_setup}: Primary setup. Strongest across all regimes.
- ${STRATEGY_PROFILE.secondary_setup}: Secondary setup. Performance varies by regime.
- ${STRATEGY_PROFILE.disabled_setups.join(", ")}: Disabled by strategy policy. You should not receive these. If you do, return NO_TRADE.

Regime-aware gating is active. BTC regime (bull/bear/sideways)
is determined by BTC daily close vs EMA(200), EMA slope, and 4H ADX.
Gate B enforces these restrictions on enabled setups before signals reach you:
- BEAR regime: ${STRATEGY_PROFILE.regime_rules.bear.favored} is favored. ${STRATEGY_PROFILE.regime_rules.bear.blocked}. ${STRATEGY_PROFILE.regime_rules.bear.enabled_note}.
- BULL regime: ${STRATEGY_PROFILE.regime_rules.bull.favored} is favored. ${STRATEGY_PROFILE.regime_rules.bull.restricted}.
- SIDEWAYS regime: ${STRATEGY_PROFILE.regime_rules.sideways.favored} are favored. ${STRATEGY_PROFILE.regime_rules.sideways.restricted}.

Your role is to assess signals that already passed detection, Gate B, and cooldown:
1. Whether the setup is coherent (indicators align with the signal direction).
2. Whether market microstructure supports the trade (spread, depth, funding, OI flow).
3. Whether risk levels are sensible relative to current volatility.
If the supplied BTC regime conflicts with the signal direction, increase skepticism.

Enrichment Context (from real-time data collector, may be null if unavailable):
- Funding Rate: negative = shorts pay longs (hostile for shorts). Hourly funding coins (interval=1) are expensive — flag as risk.
- OI Delta 1h/4h: positive = new longs entering. For shorts, rising OI + falling price = good (longs getting trapped). Rising OI + rising price = bad (momentum against you).
- Spread %: >0.05% = thin book, slippage risk. >0.1% = dangerous.
- BTC Correlation: >0.7 = highly correlated to BTC, macro-driven. <0.3 = idiosyncratic move. For shorts in bear regime, high correlation is good (BTC dragging it down). Low correlation means the signal is about this specific token.
- BTC Beta: >1 = amplifies BTC moves. For shorts, high beta in bear = good leverage. High beta in bull = dangerous.

Use enrichment context to adjust confidence. Key patterns:
- Short + negative funding + rising OI = STRONG (funding hostile to longs, new longs getting trapped)
- Short + positive funding + falling OI = WEAK (longs exiting, not building)
- Short + hourly funding (interval=1) with rate > 0.01% = funding cost RISK FLAG
- Any signal + spread > 0.05% = slippage risk flag

HARD RULE: If stop distance exceeds 8% of entry price, always reject — the TP ladder is mathematically unreliable on micro-cap tokens with oversized ATR. Return NO_TRADE with reasoning citing stop_too_wide.`;

const OUTPUT_SCHEMA = {
  type: "object" as const,
  properties: {
    decision: { type: "string" as const, enum: ["INVALID", "NO_TRADE", "LONG", "SHORT"] },
    confidence: { type: "integer" as const, minimum: 1, maximum: 10 },
    setup_type: { type: "string" as const, enum: ["mean_reversion", "breakout", "continuation", "reversal", "none"] },
    level_review: {
      type: "object" as const,
      properties: {
        entry_valid: { type: "boolean" as const },
        stop_valid: { type: "boolean" as const },
        targets_valid: { type: "boolean" as const },
      },
      required: ["entry_valid", "stop_valid", "targets_valid"],
    },
    invalid_if: { type: "string" as const },
    reasoning: { type: "string" as const },
    risk_flags: { type: "array" as const, items: { type: "string" as const } },
    data_quality: { type: "string" as const, enum: ["high", "medium", "low"] },
    suggested_adjustments: {
      type: "object" as const,
      properties: {
        entry_note: { type: "string" as const },
        stop_note: { type: "string" as const },
        target_note: { type: "string" as const },
      },
      required: ["entry_note", "stop_note", "target_note"],
    },
  },
  required: [
    "decision", "confidence", "setup_type", "level_review",
    "invalid_if", "reasoning", "risk_flags", "data_quality",
    "suggested_adjustments",
  ],
};

export async function reviewWithClaude(
  input: ClaudeReviewInput
): Promise<{ request: object; response: ClaudeReviewOutput }> {
  // ── 1-hour cache: reuse recent review for same symbol + regime ──
  try {
    const supabase = getSupabase();
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const { data: cached } = await supabase
      .from("decisions")
      .select("claude_confidence, blocked_reason, created_at")
      .eq("symbol", input.symbol)
      .eq("btc_regime", input.btc_regime)
      .not("claude_confidence", "is", null)
      .gte("created_at", oneHourAgo)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (cached && cached.claude_confidence != null) {
      const ageMin = Math.round((Date.now() - new Date(cached.created_at).getTime()) / 60000);
      console.log(`[reviewer] ${input.symbol} cache hit (confidence: ${cached.claude_confidence}, age: ${ageMin}min)`);

      // Reconstruct a minimal review output from cached data
      const cachedConfidence = Number(cached.claude_confidence);
      const isBlocked = cachedConfidence <= 4;
      return {
        request: { cached: true, symbol: input.symbol, btc_regime: input.btc_regime },
        response: {
          decision: isBlocked ? "NO_TRADE" : (input.direction as ClaudeReviewOutput["decision"]),
          confidence: cachedConfidence,
          setup_type: "none",
          level_review: { entry_valid: true, stop_valid: true, targets_valid: true },
          invalid_if: "",
          reasoning: `Cached review from ${ageMin}min ago (same symbol + regime)`,
          risk_flags: [],
          data_quality: "medium",
          suggested_adjustments: { entry_note: "", stop_note: "", target_note: "" },
        },
      };
    }
  } catch (err) {
    console.warn("[reviewer] Cache lookup failed, proceeding with Haiku:", err);
  }

  const client = getClient();

  const userMessage = `Review this signal candidate:

Symbol: ${input.symbol}
Direction: ${input.direction}
Timeframe: ${input.alert_tf}

Alert Data:
  price: ${input.alert_price}
  RSI: ${input.alert_rsi}
  ADX 1H: ${input.alert_adx1h}
  ADX 4H: ${input.alert_adx4h}
  BB Width: ${input.alert_bb_width}

Market Data:
  Mark Price: ${input.mark_price}
  Funding Rate: ${input.funding_rate}
  Turnover 24H: ${input.turnover_24h}
  Spread BPS: ${input.spread_bps}
  OI Value: ${input.open_interest_value}
  Book Depth Bid: ${input.book_depth_bid_usd}
  Book Depth Ask: ${input.book_depth_ask_usd}
  OI Delta 5m: ${input.oi_delta_5m ?? "N/A"}
  OI Delta 15m: ${input.oi_delta_15m ?? "N/A"}
  OI Delta 1h: ${input.oi_delta_1h ?? "N/A"}

HTF Trend:
  4H Trend: ${input.trend_4h}
  1D Trend: ${input.trend_1d}
  EMA20 4H: ${input.ema20_4h}
  EMA50 4H: ${input.ema50_4h}
  ATR14 1H: ${input.atr14_1h}
  ATR14 4H: ${input.atr14_4h}

Regime:
  BTC Regime: ${input.btc_regime}
  Alt Environment: ${input.alt_environment}

Price Levels:
  Entry: ${input.entry}
  Stop: ${input.stop}
  Stop Distance: ${input.entry > 0 ? (Math.abs(input.stop - input.entry) / input.entry * 100).toFixed(2) : "N/A"}%
  TP1: ${input.tp1}
  TP2: ${input.tp2}
  TP3: ${input.tp3}
  R:R to TP1: ${input.rr_tp1}

Quality:
  Snapshot: ${input.snapshot_quality}
  Gate A: ${input.gate_a_quality}
  Gate B Passed: ${input.gate_b_passed}

Enrichment Context (real-time from data collector):
  Funding Rate: ${input.enrichment_funding_rate !== null ? input.enrichment_funding_rate.toFixed(6) : "N/A"}
  Funding Interval: ${input.enrichment_funding_interval !== null ? input.enrichment_funding_interval + "h" : "N/A"}
  OI Delta 1h: ${input.enrichment_oi_delta_1h_pct !== null ? input.enrichment_oi_delta_1h_pct.toFixed(2) + "%" : "N/A"}
  OI Delta 4h: ${input.enrichment_oi_delta_4h_pct !== null ? input.enrichment_oi_delta_4h_pct.toFixed(2) + "%" : "N/A"}
  Spread: ${input.enrichment_spread_pct !== null ? input.enrichment_spread_pct.toFixed(4) + "%" : "N/A"}
  BTC Correlation (24h): ${input.enrichment_btc_correlation !== null ? input.enrichment_btc_correlation.toFixed(3) : "N/A"}
  BTC Beta (24h): ${input.enrichment_btc_beta !== null ? input.enrichment_btc_beta.toFixed(3) : "N/A"}`;

  const request = {
    model: "claude-haiku-4-5-20251001",
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user" as const, content: userMessage }],
  };

  const result = await client.messages.create({
    ...request,
    tools: [
      {
        name: "submit_review",
        description: "Submit the structured signal review",
        input_schema: OUTPUT_SCHEMA,
      },
    ],
    tool_choice: { type: "tool", name: "submit_review" },
  });

  const toolBlock = result.content.find((b) => b.type === "tool_use");
  if (!toolBlock || toolBlock.type !== "tool_use") {
    throw new Error("Claude did not return a tool_use block");
  }

  const response = toolBlock.input as unknown as ClaudeReviewOutput;

  return { request, response };
}
