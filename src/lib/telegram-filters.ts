export interface TelegramFilterInput {
  regime: string;
  isRelaxed: boolean;
  regimeWeakening: boolean;
  bbWidth: number;
  telegramVolRatio: number;
  volRatio: number | null;
  compositeScore: number;
  rrTp2: number;
  direction: "long" | "short";
  tp1: number;
  entry: number;
  markPrice: number;
  claudeConfidence: number | null;
  bearBbMax: number;
  bearVolDeadLow: number;
  bearVolDeadHigh: number;
}

export function getTelegramFilterBlockReason(
  input: TelegramFilterInput
): string | null {
  if (input.regime === "bear") {
    const bearChecks = [
      { name: `bear_bb_width<${input.bearBbMax}`, pass: input.bbWidth < input.bearBbMax },
      {
        name: "bear_vol_not_dead_zone",
        pass: !(
          input.telegramVolRatio >= input.bearVolDeadLow &&
          input.telegramVolRatio < input.bearVolDeadHigh
        ),
      },
    ];
    const bearFailed = bearChecks.filter((check) => !check.pass);
    if (bearFailed.length > 0) {
      return `BEAR regime filtered: ${bearFailed.map((failed) => failed.name).join(", ")}`;
    }
  }

  // REGIME_WEAKENING gate removed 2026-04-09: OOS validation showed the filter
  // was catastrophically inverted on 2026 hold-out data (blocked +1.79R/68%WR
  // signals while passing +0.07R/28%WR signals). `regime_weakening` is still
  // computed in regime.ts and persisted on decisions for future analysis, but
  // is no longer used to gate Telegram delivery.
  // Ref: brain/regime_weakening_oos_2026-04-09.md

  if (input.isRelaxed) {
    const relaxedChecks = [
      { name: "pass_count", pass: true },
      { name: "rr_tp2>=0.8", pass: input.rrTp2 >= 0.8 },
      {
        name: "tp1_positive",
        pass: input.direction === "long" ? input.tp1 > input.entry : input.tp1 < input.entry,
      },
      {
        name: "entry_mark_dev<=1%",
        pass:
          input.markPrice > 0 &&
          Math.abs(input.entry - input.markPrice) / input.markPrice <= 0.01,
      },
    ];
    const relaxedFailed = relaxedChecks.filter((check) => !check.pass);
    if (relaxedFailed.length > 0) {
      return `RELAXED filtered: ${relaxedFailed.map((failed) => failed.name).join(", ")}`;
    }
  }

  if (input.compositeScore < 20) {
    return `score_too_low: ${input.compositeScore.toFixed(1)}`;
  }

  if (input.volRatio !== null && input.volRatio < 0.5) {
    return `vol_ratio_too_low: ${input.volRatio.toFixed(2)}`;
  }

  if (
    input.isRelaxed &&
    input.claudeConfidence !== null &&
    input.claudeConfidence > 0 &&
    input.claudeConfidence < 5
  ) {
    return `LOW_CONFIDENCE: ${input.claudeConfidence}/10 — below minimum threshold of 5`;
  }

  return null;
}
