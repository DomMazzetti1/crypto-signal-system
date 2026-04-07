import assert from "node:assert/strict";
import test from "node:test";
import {
  buildEligibleClusterUpdates,
  rankClusterMembers,
  selectClusterWinnerId,
} from "./cluster";

test("eligible-only finalization chooses a lower-scoring valid sibling", () => {
  const ranked = rankClusterMembers([
    {
      id: "aster",
      alert_type: "SQ_SHORT",
      composite_score: 76.08,
      rr_tp1: 0.5,
      cooldown_active: false,
      suppressed_reason: null,
    },
    {
      id: "shib",
      alert_type: "SQ_SHORT",
      composite_score: 74.63,
      rr_tp1: 0.5,
      cooldown_active: false,
      suppressed_reason: null,
    },
    {
      id: "hype",
      alert_type: "SQ_SHORT",
      composite_score: 66.1,
      rr_tp1: 0.5,
      cooldown_active: false,
      suppressed_reason: null,
    },
  ]);

  const selectedId = selectClusterWinnerId(ranked, ["hype"]);

  assert.equal(selectedId, "hype");
});

test("strict still beats relaxed inside the eligible subset", () => {
  const ranked = rankClusterMembers([
    {
      id: "relaxed",
      alert_type: "SQ_SHORT_RELAXED",
      composite_score: 82,
      rr_tp1: 0.6,
      cooldown_active: false,
      suppressed_reason: null,
    },
    {
      id: "strict",
      alert_type: "SQ_SHORT",
      composite_score: 71,
      rr_tp1: 0.4,
      cooldown_active: false,
      suppressed_reason: null,
    },
  ]);

  const selectedId = selectClusterWinnerId(ranked, ["relaxed", "strict"]);

  assert.equal(selectedId, "strict");
});

test("eligible finalization only marks eligible losers as LOWER_SCORE_IN_CLUSTER", () => {
  const ranked = rankClusterMembers([
    {
      id: "aster",
      alert_type: "SQ_SHORT",
      composite_score: 76.08,
      rr_tp1: 0.5,
      cooldown_active: false,
      selected_for_execution: false,
      suppressed_reason: null,
    },
    {
      id: "shib",
      alert_type: "SQ_SHORT",
      composite_score: 74.63,
      rr_tp1: 0.5,
      cooldown_active: false,
      selected_for_execution: false,
      suppressed_reason: null,
    },
    {
      id: "hype",
      alert_type: "SQ_SHORT",
      composite_score: 66.1,
      rr_tp1: 0.5,
      cooldown_active: false,
      selected_for_execution: false,
      suppressed_reason: null,
    },
  ]);

  const updates = buildEligibleClusterUpdates(ranked, ["shib", "hype"], "hype");

  assert.deepEqual(
    updates.map((update) => ({
      id: update.id,
      selected: update.selected_for_execution,
      suppressed: update.suppressed_reason,
      rank: update.cluster_rank,
    })),
    [
      { id: "aster", selected: false, suppressed: null, rank: 1 },
      { id: "shib", selected: false, suppressed: "LOWER_SCORE_IN_CLUSTER", rank: 2 },
      { id: "hype", selected: true, suppressed: null, rank: 3 },
    ]
  );
});
