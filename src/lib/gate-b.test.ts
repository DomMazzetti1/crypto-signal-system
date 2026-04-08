import assert from "node:assert/strict";
import test from "node:test";
import {
  calculateBtcRangePositionPct,
  getBtcRangeFilterConfig,
  runGateB,
  shouldEvaluateBtcRangeFilter,
} from "./gate-b";

// Wednesday 2026-04-08 16:00 UTC — not a Tuesday, so the day-of-week filter
// never fires and existing tests stay deterministic.
const TEST_SIGNAL_TIME = new Date(Date.UTC(2026, 3, 8, 16, 0, 0));

function baseGateBInput() {
  return {
    symbol: "DOGEUSDT",
    alertType: "SQ_SHORT",
    trend4h: "bearish" as const,
    btcRegime: "bear" as const,
    atr1h: 0.01,
    markPrice: 1,
    rrTp1: 0.5,
    rrTp2: 1.0,
    rsi: 42,
    signalTime: TEST_SIGNAL_TIME,
  };
}

// ── BTC 12h range helpers ────────────────────────────────

test("calculateBtcRangePositionPct returns normalized BTC position", () => {
  const pct = calculateBtcRangePositionPct([
    { low: 90, high: 100, close: 92 },
    { low: 91, high: 105, close: 98 },
    { low: 95, high: 110, close: 100 },
    { low: 96, high: 111, close: 101 },
    { low: 97, high: 112, close: 103 },
    { low: 98, high: 114, close: 102 },
  ]);

  assert.equal(pct, 50);
});

test("calculateBtcRangePositionPct returns null for insufficient history", () => {
  const pct = calculateBtcRangePositionPct([
    { low: 90, high: 100, close: 92 },
    { low: 91, high: 105, close: 98 },
  ]);

  assert.equal(pct, null);
});

test("short BTC range filter blocks out-of-range SHORT signals", () => {
  const result = runGateB({
    ...baseGateBInput(),
    btcRangePct12h: 6.7,
  });

  assert.equal(result.passed, false);
  assert.equal(result.reason, "BTC_RANGE_POSITION_OUT_OF_RANGE");
});

test("short BTC range filter allows in-range SHORT signals", () => {
  const result = runGateB({
    ...baseGateBInput(),
    btcRangePct12h: 34.2,
  });

  assert.equal(result.passed, true);
  assert.equal(result.reason, null);
});

test("short BTC range filter is skipped for LONG signals", () => {
  const result = runGateB({
    ...baseGateBInput(),
    alertType: "SQ_LONG",
    trend4h: "bullish",
    btcRegime: "bull",
    btcRangePct12h: 90,
  });

  assert.equal(result.passed, true);
  assert.equal(result.reason, null);
});

test("btc range filter config defaults to enabled 15-50", () => {
  const config = getBtcRangeFilterConfig({});

  assert.deepEqual(config, {
    enabled: true,
    low: 15,
    high: 50,
  });
});

test("shouldEvaluateBtcRangeFilter only applies to executable SHORT alerts", () => {
  const config = { enabled: true, low: 15, high: 50 };

  assert.equal(shouldEvaluateBtcRangeFilter("SQ_SHORT", config), true);
  assert.equal(shouldEvaluateBtcRangeFilter("SQ_SHORT_DATA", config), false);
  assert.equal(shouldEvaluateBtcRangeFilter("SQ_LONG_REVERSAL", config), false);
});

// ── Path C filter stack (OOS-validated subset, April 2026) ──

test("symbol blacklist rejects banned tickers with SYMBOL_BLACKLIST reason", () => {
  const banned = [
    "BERAUSDT",
    "CAKEUSDT",
    "APTUSDT",
    "RESOLVUSDT",
    "PIPPINUSDT",
    "ASTERUSDT",
    "HYPEUSDT",
    "LINKUSDT",
    "ARBUSDT",
  ];
  for (const symbol of banned) {
    const result = runGateB({ ...baseGateBInput(), symbol });
    assert.equal(result.passed, false, `${symbol} should be blocked`);
    assert.equal(result.reason, "SYMBOL_BLACKLIST", `${symbol} reason mismatch`);
  }
});

test("symbol blacklist allows non-banned tickers", () => {
  const result = runGateB({ ...baseGateBInput(), symbol: "SOLUSDT" });
  assert.equal(result.passed, true);
});

test("day-of-week gate rejects Tuesday UTC with TUESDAY_AVOID reason", () => {
  // 2026-04-07 is a Tuesday
  const signalTime = new Date(Date.UTC(2026, 3, 7, 16, 0, 0));
  const result = runGateB({ ...baseGateBInput(), signalTime });
  assert.equal(result.passed, false);
  assert.equal(result.reason, "TUESDAY_AVOID");
});

test("day-of-week gate allows Monday and Wed-Sun UTC", () => {
  // 2026-04-04 Sat, 2026-04-05 Sun, 2026-04-06 Mon, 2026-04-08 Wed,
  // 2026-04-09 Thu, 2026-04-10 Fri
  for (const day of [4, 5, 6, 8, 9, 10]) {
    const signalTime = new Date(Date.UTC(2026, 3, day, 16, 0, 0));
    const result = runGateB({ ...baseGateBInput(), signalTime });
    assert.equal(
      result.passed,
      true,
      `2026-04-${day} should be allowed (was ${result.reason ?? "null"})`
    );
  }
});

test("day-of-week gate does not fire on any hour other than Tuesday", () => {
  // Regression test: the hour-of-day filter was removed entirely. Hours
  // that used to be in the old avoid set (6, 8, 9, 15, 18, 20, 22) should
  // now pass on non-Tuesday days.
  for (const hour of [6, 8, 9, 15, 18, 20, 22]) {
    const signalTime = new Date(Date.UTC(2026, 3, 8, hour, 0, 0)); // Wed
    const result = runGateB({ ...baseGateBInput(), signalTime });
    assert.equal(
      result.passed,
      true,
      `Wed ${hour}:00 UTC should be allowed (was ${result.reason ?? "null"})`
    );
  }
});

test("data-only signals bypass blacklist and day-of-week filters", () => {
  // Data-only cohorts must keep firing so we can compare against the gated set.
  const result = runGateB({
    ...baseGateBInput(),
    symbol: "BERAUSDT",
    alertType: "SQ_SHORT_DATA",
    signalTime: new Date(Date.UTC(2026, 3, 7, 16, 0, 0)), // Tue
  });
  assert.equal(result.passed, true);
});

test("bear SQ_LONG exact-match rule does not reject SQ_LONG_REVERSAL", () => {
  // Regression test for the substring bug: lowerType.includes("sq_long")
  // used to also match "sq_long_reversal". After the fix, SQ_LONG_REVERSAL
  // should pass the bear-regime gate (subject only to the directional
  // trend filter, which it bypasses via the `reversal` carve-out).
  const result = runGateB({
    ...baseGateBInput(),
    alertType: "SQ_LONG_REVERSAL",
    btcRegime: "bear",
    trend4h: "bearish",
  });
  assert.equal(result.passed, true);
  assert.equal(result.reason, null);
});

test("bear SQ_LONG (exact) is still blocked", () => {
  const result = runGateB({
    ...baseGateBInput(),
    alertType: "SQ_LONG",
    btcRegime: "bear",
    trend4h: "neutral",
  });
  assert.equal(result.passed, false);
  assert.equal(result.reason, "SQ_LONG blocked in bear regime");
});

test("sideways MR_LONG soft gate rejects below composite_score 40", () => {
  const result = runGateB({
    ...baseGateBInput(),
    alertType: "MR_LONG",
    btcRegime: "sideways",
    trend4h: "neutral",
    rsi: 28,
    compositeScore: 25,
  });
  assert.equal(result.passed, false);
  assert.equal(result.reason, "SIDEWAYS_MR_LONG_LOW_SCORE");
});

test("sideways MR_LONG soft gate passes at composite_score == 40", () => {
  const result = runGateB({
    ...baseGateBInput(),
    alertType: "MR_LONG",
    btcRegime: "sideways",
    trend4h: "neutral",
    rsi: 28,
    compositeScore: 40,
  });
  assert.equal(result.passed, true);
  assert.equal(result.reason, null);
});

test("sideways MR_LONG soft gate passes above composite_score 40", () => {
  const result = runGateB({
    ...baseGateBInput(),
    alertType: "MR_LONG",
    btcRegime: "sideways",
    trend4h: "neutral",
    rsi: 28,
    compositeScore: 72,
  });
  assert.equal(result.passed, true);
  assert.equal(result.reason, null);
});

test("sideways MR_LONG soft gate fails open when compositeScore is undefined", () => {
  // Backtest / shadow callers may omit compositeScore. The soft gate should
  // NOT block in that case — only score-bearing callers get the extra gate.
  const result = runGateB({
    ...baseGateBInput(),
    alertType: "MR_LONG",
    btcRegime: "sideways",
    trend4h: "neutral",
    rsi: 28,
    // compositeScore intentionally omitted
  });
  assert.equal(result.passed, true);
  assert.equal(result.reason, null);
});

test("sideways MR_SHORT still passes in sideways regime", () => {
  const result = runGateB({
    ...baseGateBInput(),
    alertType: "MR_SHORT",
    btcRegime: "sideways",
    trend4h: "neutral",
    rsi: 75,
  });
  assert.equal(result.passed, true);
});

test("bull regime: MR_LONG no longer hard-banned", () => {
  // Regression test for removed bull MR ban. With trend4h="neutral" the
  // directional trend filter doesn't fire, and after Path C the blanket
  // bull MR ban is gone. MR_LONG in bull should pass.
  const result = runGateB({
    ...baseGateBInput(),
    alertType: "MR_LONG",
    btcRegime: "bull",
    trend4h: "neutral",
    rsi: 28,
  });
  assert.equal(result.passed, true);
  assert.equal(result.reason, null);
});

test("bull regime: MR_SHORT no longer hard-banned (trend4h neutral)", () => {
  // Regression test: the blanket bull MR_SHORT ban has been removed.
  // The directional trend filter still applies (blocks short in bullish
  // 4H trend), but with neutral trend nothing should stop it.
  const result = runGateB({
    ...baseGateBInput(),
    alertType: "MR_SHORT",
    btcRegime: "bull",
    trend4h: "neutral",
    rsi: 75,
  });
  assert.equal(result.passed, true);
  assert.equal(result.reason, null);
});

test("bull regime: SQ_SHORT still allowed", () => {
  const result = runGateB({
    ...baseGateBInput(),
    btcRegime: "bull",
    trend4h: "bullish",
  });
  assert.equal(result.passed, true);
});
