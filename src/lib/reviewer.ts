/**
 * @deprecated — Haiku reviewer replaced by Sonnet AI signal reviewer.
 * See: src/lib/ai-signal-reviewer.ts
 *
 * This file retains STRATEGY_PROFILE for backward compatibility with
 * backtest routes. The reviewWithClaude function has been removed.
 * Safe to refactor these imports after PR merge.
 */

export const STRATEGY_PROFILE = {
  primary_setup: "SQ_SHORT",
  secondary_setup: "MR_SHORT",
  disabled_setups: ["MR_LONG", "SQ_LONG"],
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
