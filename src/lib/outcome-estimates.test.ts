import assert from "node:assert/strict";
import test from "node:test";
import { estimateLadderR, isPositiveOutcome } from "./outcome-estimates";

test("estimateLadderR reflects the current 0.5 / 1.0 / 2.5R ladder", () => {
  assert.ok(
    Math.abs(estimateLadderR("WIN_FULL", "TP1->TP2->TP3") - 1.325) < 1e-9
  );
});

test("estimateLadderR treats TP1 then stop as a negative partial", () => {
  assert.equal(estimateLadderR("WIN_PARTIAL_THEN_SL", "TP1->SL"), -0.49);
});

test("isPositiveOutcome only returns true for positive ladder outcomes", () => {
  assert.equal(isPositiveOutcome("WIN_PARTIAL_THEN_SL", "TP1->SL"), false);
  assert.equal(isPositiveOutcome(null, "TP1->TP2->SL"), true);
});
