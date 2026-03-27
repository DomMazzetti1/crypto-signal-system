export interface PriceLevels {
  entry: number;
  stop: number;
  tp1: number;
  tp2: number;
  tp3: number;
  risk: number;
  rr_tp1: number;
  rr_tp2: number;
  rr_tp3: number;
  valid: boolean;
  invalid_reason: string | null;
}

export function calculateLevels(
  markPrice: number,
  atr1h: number,
  direction: "long" | "short"
): PriceLevels {
  const atrMultiplier = 1.5;
  const riskDistance = Math.abs(atr1h) * atrMultiplier;

  const isLong = direction !== "short";

  let entry: number, stop: number, tp1: number, tp2: number, tp3: number;

  if (isLong) {
    entry = markPrice;
    stop = entry - riskDistance;
    const risk = riskDistance;
    tp1 = entry + risk * 1.5;
    tp2 = entry + risk * 2.5;
    tp3 = entry + risk * 4.0;
  } else {
    entry = markPrice;
    stop = entry + riskDistance;
    const risk = riskDistance;
    tp1 = entry - risk * 1.5;
    tp2 = entry - risk * 2.5;
    tp3 = entry - risk * 4.0;
  }

  const risk = Math.abs(entry - stop);

  // Validation: detect impossible levels
  let valid = true;
  let invalid_reason: string | null = null;

  if (!Number.isFinite(entry) || entry <= 0) {
    valid = false;
    invalid_reason = `invalid entry: ${entry}`;
  } else if (!Number.isFinite(risk) || risk <= 0) {
    valid = false;
    invalid_reason = `zero or invalid risk: ${risk}`;
  } else if (tp1 <= 0 || tp2 <= 0 || tp3 <= 0) {
    // Clamp negative TPs to a floor (0.1% of entry) instead of allowing negatives
    const floor = entry * 0.001;
    if (tp1 <= 0) tp1 = floor;
    if (tp2 <= 0) tp2 = floor;
    if (tp3 <= 0) tp3 = floor;
    valid = false;
    invalid_reason = `TP clamped to floor: ATR too large relative to price (atr=${atr1h.toFixed(6)}, entry=${entry.toFixed(6)})`;
  } else if (isLong && (tp1 <= entry || stop >= entry)) {
    valid = false;
    invalid_reason = `LONG levels inverted: entry=${entry}, stop=${stop}, tp1=${tp1}`;
  } else if (!isLong && (tp1 >= entry || stop <= entry)) {
    valid = false;
    invalid_reason = `SHORT levels inverted: entry=${entry}, stop=${stop}, tp1=${tp1}`;
  }

  return {
    entry,
    stop,
    tp1,
    tp2,
    tp3,
    risk,
    rr_tp1: risk > 0 ? Math.abs(tp1 - entry) / risk : 0,
    rr_tp2: risk > 0 ? Math.abs(tp2 - entry) / risk : 0,
    rr_tp3: risk > 0 ? Math.abs(tp3 - entry) / risk : 0,
    valid,
    invalid_reason,
  };
}
