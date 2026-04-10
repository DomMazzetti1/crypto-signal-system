import assert from "node:assert/strict";
import test from "node:test";
import { buildMessage, type TelegramMessageInput } from "./telegram";
import type { AIReviewResult } from "./ai-signal-reviewer";

// ── Mock AI review result ──────────────────────────────────

function mockAIReview(overrides?: Partial<AIReviewResult>): AIReviewResult {
  return {
    confidence: 72,
    pattern: "clean_breakdown",
    reasoning: "Price breaking below 7D swing low with expanding volume. BTC trending down supports the short.",
    tp1_price: 0.4250,
    tp1_rationale: "prior 4H swing low from April 5",
    tp2_price: 0.4100,
    tp2_rationale: "1D support zone tested 3x in March",
    tp3_price: 0.3900,
    tp3_rationale: "weekly demand zone",
    suggested_stop: 0.4520,
    concerns: ["funding_negative", "btc_correlation_high"],
    overall_verdict: "strong_setup",
    ...overrides,
  };
}

function baseTelegramInput(overrides?: Partial<TelegramMessageInput>): TelegramMessageInput {
  return {
    symbol: "DOGEUSDT",
    decision: "SHORT",
    entry: 0.4480,
    stop: 0.4550,
    tp1: 0.4410,
    tp2: 0.4340,
    tp3: 0.4200,
    confidence: 7,
    setup_type: "clean_breakdown",
    btc_regime: "bear",
    alt_environment: "hostile",
    funding_rate: -0.0001,
    risk_flags: ["funding_negative"],
    reasoning: "Price breaking below support",
    ...overrides,
  };
}

// ── Telegram format tests ──────────────────────────────────

test("buildMessage includes AI analysis block when ai_review is present", () => {
  const input = baseTelegramInput({ ai_review: mockAIReview() });
  const msg = buildMessage(input);

  assert.ok(msg.includes("🤖 AI Analysis:"), "Should contain AI Analysis header");
  assert.ok(msg.includes("72/100"), "Should contain confidence score");
  assert.ok(msg.includes("clean_breakdown"), "Should contain pattern label");
  assert.ok(msg.includes("strong_setup"), "Should contain verdict");
  assert.ok(msg.includes("📊 AI-suggested levels:"), "Should contain AI levels section");
  assert.ok(msg.includes("TP1:"), "Should contain TP1");
  assert.ok(msg.includes("TP2:"), "Should contain TP2");
  assert.ok(msg.includes("⚠️ Concerns:"), "Should contain concerns section");
});

test("buildMessage shows AI stop when different from system stop", () => {
  const ai = mockAIReview({ suggested_stop: 0.4600 });
  const input = baseTelegramInput({ ai_review: ai });
  const msg = buildMessage(input);

  assert.ok(msg.includes("AI:"), "Should show AI stop when different");
  assert.ok(msg.includes("0.4600"), "Should include AI suggested stop price");
});

test("buildMessage does NOT show AI stop annotation when same as system stop", () => {
  const ai = mockAIReview({ suggested_stop: 0.4550 });
  const input = baseTelegramInput({ ai_review: ai });
  const msg = buildMessage(input);

  // Should not have the "(AI:" annotation when stops match
  assert.ok(!msg.includes("(AI:"), "Should not show AI stop annotation when same as system");
});

test("buildMessage handles null TP3 gracefully", () => {
  const ai = mockAIReview({ tp3_price: null, tp3_rationale: null });
  const input = baseTelegramInput({ ai_review: ai });
  const msg = buildMessage(input);

  assert.ok(msg.includes("TP3: none"), "Should show 'none' for null TP3");
});

test("buildMessage shows no AI block when ai_review is undefined", () => {
  const input = baseTelegramInput();
  const msg = buildMessage(input);

  assert.ok(!msg.includes("🤖 AI Analysis:"), "Should NOT contain AI Analysis when undefined");
  assert.ok(!msg.includes("📊 AI-suggested levels:"), "Should NOT contain AI levels when undefined");
});

test("buildMessage handles avoid verdict", () => {
  const ai = mockAIReview({
    confidence: 15,
    pattern: "fading_support",
    overall_verdict: "avoid",
    concerns: ["support_nearby", "btc_headwind", "range_low"],
  });
  const input = baseTelegramInput({ ai_review: ai });
  const msg = buildMessage(input);

  assert.ok(msg.includes("15/100"), "Should show low confidence");
  assert.ok(msg.includes("avoid"), "Should show avoid verdict");
  assert.ok(msg.includes("support_nearby"), "Should list concerns");
});

test("buildMessage escapes HTML in AI review fields", () => {
  const ai = mockAIReview({
    reasoning: "Price <broke> below & tested support",
    pattern: "test<pattern>",
    tp1_rationale: "level <with> special & chars",
  });
  const input = baseTelegramInput({ ai_review: ai });
  const msg = buildMessage(input);

  assert.ok(!msg.includes("<broke>"), "Should escape angle brackets in reasoning");
  assert.ok(msg.includes("&lt;broke&gt;"), "Should HTML-escape reasoning");
  assert.ok(msg.includes("test&lt;pattern&gt;"), "Should HTML-escape pattern");
});

// ── AI review result validation (unit tests for the reviewer) ──

test("AIReviewResult types are structurally correct", () => {
  const review = mockAIReview();

  // Verify required fields and types
  assert.equal(typeof review.confidence, "number");
  assert.ok(review.confidence >= 0 && review.confidence <= 100);
  assert.equal(typeof review.pattern, "string");
  assert.equal(typeof review.reasoning, "string");
  assert.equal(typeof review.tp1_price, "number");
  assert.equal(typeof review.tp2_price, "number");
  assert.equal(typeof review.suggested_stop, "number");
  assert.ok(Array.isArray(review.concerns));
  assert.ok(["strong_setup", "marginal", "avoid"].includes(review.overall_verdict));
});

test("AI review with null TP3 is valid", () => {
  const review = mockAIReview({ tp3_price: null, tp3_rationale: null });
  assert.equal(review.tp3_price, null);
  assert.equal(review.tp3_rationale, null);
});

test("AI review pipeline continues when review is null (API failure simulation)", () => {
  // Simulate what pipeline does when reviewSignalWithSonnet returns null
  // Use a function to avoid TS narrowing the const null to `never`
  function simulatePipelineFallback(aiReview: AIReviewResult | null) {
    const claudeConfidence = aiReview ? Math.round(aiReview.confidence / 10) : null;
    const setupType = aiReview ? aiReview.pattern : null;
    const reasoning = aiReview ? aiReview.reasoning : "AI review unavailable";
    return { claudeConfidence, setupType, reasoning };
  }

  const result = simulatePipelineFallback(null);
  assert.equal(result.claudeConfidence, null);
  assert.equal(result.setupType, null);
  assert.equal(result.reasoning, "AI review unavailable");

  // Also test with a real review
  const resultWithReview = simulatePipelineFallback(mockAIReview({ confidence: 72 }));
  assert.equal(resultWithReview.claudeConfidence, 7);
  assert.equal(resultWithReview.setupType, "clean_breakdown");
});

test("confidence mapping from 0-100 to 1-10 scale", () => {
  // Test the pipeline's confidence remapping logic
  const cases: Array<{ input: number; expected: number }> = [
    { input: 0, expected: 0 },
    { input: 15, expected: 2 },
    { input: 50, expected: 5 },
    { input: 72, expected: 7 },
    { input: 100, expected: 10 },
  ];

  for (const c of cases) {
    const mapped = Math.round(c.input / 10);
    assert.equal(mapped, c.expected, `confidence ${c.input} should map to ${c.expected}`);
  }
});
