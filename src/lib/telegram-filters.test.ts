import assert from "node:assert/strict";
import test from "node:test";
import { getTelegramFilterBlockReason } from "./telegram-filters";

function baseInput() {
  return {
    regime: "sideways",
    isRelaxed: false,
    regimeWeakening: false,
    bbWidth: 0.08,
    telegramVolRatio: 1.2,
    volRatio: 1.2,
    compositeScore: 42,
    rrTp2: 1.0,
    direction: "long" as const,
    tp1: 101,
    entry: 100,
    markPrice: 100,
    claudeConfidence: 8,
    bearBbMax: 0.05,
    bearVolDeadLow: 0.8,
    bearVolDeadHigh: 1.2,
  };
}

test("telegram filters still block low-volume longs", () => {
  const reason = getTelegramFilterBlockReason({
    ...baseInput(),
    volRatio: 0.24,
  });

  assert.equal(reason, "vol_ratio_too_low: 0.24");
});

test("telegram filters reject low-score setups before Telegram", () => {
  const reason = getTelegramFilterBlockReason({
    ...baseInput(),
    compositeScore: 12.4,
  });

  assert.equal(reason, "score_too_low: 12.4");
});

test("telegram filters allow a healthy strict setup through", () => {
  const reason = getTelegramFilterBlockReason(baseInput());

  assert.equal(reason, null);
});
