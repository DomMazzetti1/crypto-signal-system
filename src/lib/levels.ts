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
}

export function calculateLevels(
  markPrice: number,
  atr1h: number,
  direction: "long" | "short"
): PriceLevels {
  const atrMultiplier = 1.5;
  const riskDistance = Math.abs(atr1h) * atrMultiplier;

  let entry: number, stop: number, tp1: number, tp2: number, tp3: number;

  if (direction === "long") {
    entry = markPrice;
    stop = entry - riskDistance;
    const risk = entry - stop;
    tp1 = entry + risk * 1.5;
    tp2 = entry + risk * 2.5;
    tp3 = entry + risk * 4.0;
  } else {
    entry = markPrice;
    stop = entry + riskDistance;
    const risk = stop - entry;
    tp1 = entry - risk * 1.5;
    tp2 = entry - risk * 2.5;
    tp3 = entry - risk * 4.0;
  }

  const risk = Math.abs(entry - stop);

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
  };
}
