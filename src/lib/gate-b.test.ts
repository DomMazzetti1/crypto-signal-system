import assert from "node:assert/strict";
import test from "node:test";
import {
  calculateBtcRangePositionPct,
  getBtcRangeFilterConfig,
  runGateB,
  shouldEvaluateBtcRangeFilter,
} from "./gate-b";

// Wednesday 2026-04-08 16:00 UTC — premium hour, premium day, so the
// hour/day filters never fire and existing tests stay deterministic.
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

// ── Validated 2-yr backtest filters ──────────────────────

test("symbol blacklist rejects banned tickers", () => {
  for (const symbol of ["BERAUSDT", "CAKEUSDT", "APTUSDT", "HYPEUSDT", "LINKUSDT", "ARBUSDT"]) {
    const result = runGateB({ ...baseGateBInput(), symbol });
    assert.equal(result.passed, false, `${symbol} should be blocked`);
    assert.match(result.reason ?? "", /blacklisted/);
  }
});

test("symbol blacklist allows non-banned tickers", () => {
  const result = runGateB({ ...baseGateBInput(), symbol: "SOLUSDT" });
  assert.equal(result.passed, true);
});

test("hour-of-day gate rejects avoid hours UTC", () => {
  for (const hour of [6, 8, 9, 15, 18, 20, 22]) {
    const signalTime = new Date(Date.UTC(2026, 3, 8, hour, 0, 0));
    const result = runGateB({ ...baseGateBInput(), signalTime });
    assert.equal(result.passed, false, `${hour}:00 UTC should be blocked`);
    assert.match(result.reason ?? "", /avoid set/);
  }
});

test("hour-of-day gate allows premium hours UTC", () => {
  for (const hour of [10, 11, 13, 16]) {
    const signalTime = new Date(Date.UTC(2026, 3, 8, hour, 0, 0));
    const result = runGateB({ ...baseGateBInput(), signalTime });
    assert.equal(result.passed, true, `${hour}:00 UTC should be allowed`);
  }
});

test("day-of-week gate rejects Mon and Tue UTC", () => {
  // 2026-04-06 = Monday, 2026-04-07 = Tuesday
  for (const day of [6, 7]) {
    const signalTime = new Date(Date.UTC(2026, 3, day, 16, 0, 0));
    const result = runGateB({ ...baseGateBInput(), signalTime });
    assert.equal(result.passed, false, `2026-04-${day} should be blocked`);
    assert.match(result.reason ?? "", /avoid set/);
  }
});

test("day-of-week gate allows weekends and Wed-Fri UTC", () => {
  // 2026-04-04 Sat, 2026-04-05 Sun, 2026-04-08 Wed, 2026-04-09 Thu, 2026-04-10 Fri
  for (const day of [4, 5, 8, 9, 10]) {
    const signalTime = new Date(Date.UTC(2026, 3, day, 16, 0, 0));
    const result = runGateB({ ...baseGateBInput(), signalTime });
    assert.equal(result.passed, true, `2026-04-${day} should be allowed`);
  }
});

test("data-only signals bypass blacklist/hour/day filters", () => {
  // Data-only cohorts must keep firing so we can compare against the gated set.
  const result = runGateB({
    ...baseGateBInput(),
    symbol: "BERAUSDT",
    alertType: "SQ_SHORT_DATA",
    signalTime: new Date(Date.UTC(2026, 3, 6, 8, 0, 0)), // Mon 8:00 UTC
  });
  assert.equal(result.passed, true);
});

test("MR_LONG blocked in sideways regime", () => {
  const result = runGateB({
    ...baseGateBInput(),
    alertType: "MR_LONG",
    btcRegime: "sideways",
    trend4h: "neutral",
    rsi: 22,
  });
  assert.equal(result.passed, false);
  assert.match(result.reason ?? "", /sideways regime/);
});

test("MR_SHORT allowed in sideways regime", () => {
  const result = runGateB({
    ...baseGateBInput(),
    alertType: "MR_SHORT",
    btcRegime: "sideways",
    trend4h: "neutral",
    rsi: 75,
  });
  assert.equal(result.passed, true);
});

test("MR setups blocked in bull regime", () => {
  // Use trend4h="neutral" so the directional trend gate doesn't intercept
  // MR_SHORT before we reach the bull-regime MR block.
  for (const alertType of ["MR_LONG", "MR_SHORT"]) {
    const result = runGateB({
      ...baseGateBInput(),
      alertType,
      btcRegime: "bull",
      trend4h: "neutral",
    });
    assert.equal(result.passed, false, `${alertType} in bull should be blocked`);
    assert.match(result.reason ?? "", /bull regime/);
  }
});

test("SQ_SHORT still allowed in bull regime", () => {
  const result = runGateB({
    ...baseGateBInput(),
    btcRegime: "bull",
    trend4h: "bullish",
  });
  assert.equal(result.passed, true);
});
