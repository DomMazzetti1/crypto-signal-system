import assert from "node:assert/strict";
import test from "node:test";
import {
  calculateBtcRangePositionPct,
  getBtcRangeFilterConfig,
  runGateB,
  shouldEvaluateBtcRangeFilter,
} from "./gate-b";

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
  };
}

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
