const FIRST_TRANCHE_PCT = 0.34;
const SECOND_TRANCHE_PCT = 0.33;
const THIRD_TRANCHE_PCT = 0.33;

const TP1_R = 0.5;
const TP2_R = 1.0;
const TP3_R = 2.5;

const FULL_LADDER_R =
  FIRST_TRANCHE_PCT * TP1_R +
  SECOND_TRANCHE_PCT * TP2_R +
  THIRD_TRANCHE_PCT * TP3_R;

const TP2_LOCKED_R =
  FIRST_TRANCHE_PCT * TP1_R +
  SECOND_TRANCHE_PCT * TP2_R;

const TP1_THEN_SL_R =
  FIRST_TRANCHE_PCT * TP1_R -
  (SECOND_TRANCHE_PCT + THIRD_TRANCHE_PCT);

const TP1_LOCKED_R = FIRST_TRANCHE_PCT * TP1_R;

export function estimateLadderR(
  gradedOutcome: string | null | undefined,
  resolutionPath: string | null | undefined
): number {
  const outcome = gradedOutcome ?? "";
  const path = resolutionPath ?? "";

  if (outcome === "LOSS") return -1;
  if (outcome === "WIN_BE" || outcome === "WIN_BREAKEVEN") return 0;

  if (outcome === "WIN_FULL" && path.includes("TP2") && !path.includes("TP3")) {
    return FULL_LADDER_R;
  }
  if (path.includes("TP3")) return FULL_LADDER_R;
  if (path.includes("TP2->SL") || path.includes("TP2->EXPIRED") || path.endsWith("->TP2")) {
    return TP2_LOCKED_R;
  }
  if (path.includes("TP1->SL")) return TP1_THEN_SL_R;
  if (path.includes("TP1->EXPIRED") || path.endsWith("->TP1")) return TP1_LOCKED_R;

  if (outcome === "WIN_FULL" || outcome === "WIN_TP3" || outcome === "WIN_TP2") return FULL_LADDER_R;
  if (outcome === "WIN_TP1" || outcome === "WIN_PARTIAL_EXPIRED") return TP1_LOCKED_R;
  if (outcome === "WIN_PARTIAL_THEN_SL") return TP1_THEN_SL_R;
  if (outcome.startsWith("WIN")) return TP1_LOCKED_R;

  return 0;
}

export function isPositiveOutcome(
  gradedOutcome: string | null | undefined,
  resolutionPath: string | null | undefined
): boolean {
  return estimateLadderR(gradedOutcome, resolutionPath) > 0;
}
