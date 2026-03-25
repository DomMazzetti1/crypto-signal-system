/**
 * Shared signal grading logic.
 * Extracted from src/app/api/backtest/batch/route.ts gradeSignal()
 * for reuse by both backtest and shadow outcome grading.
 *
 * Constants match backtest exactly:
 *   ATR_MULT = 1.5, SLIPPAGE = 0.0005, TAKER_FEE = 0.00055
 */

import { Kline } from "./bybit";

const ATR_MULT = 1.5;
const TAKER_FEE = 0.00055;
const SLIPPAGE = 0.0005;

export interface GradeResult {
  hit_tp1: boolean;
  hit_tp2: boolean;
  hit_tp3: boolean;
  hit_sl: boolean;
  bars_to_resolution: number;
  max_favorable: number;
  max_adverse: number;
  tp1: number;
  tp2: number;
  tp3: number;
  stop_loss: number;
  entry_price: number;
}

export function gradeSignal(
  rawEntry: number,
  atrVal: number,
  isLong: boolean,
  futureBars: Kline[]
): GradeResult {
  const entry = isLong
    ? rawEntry * (1 + SLIPPAGE)
    : rawEntry * (1 - SLIPPAGE);

  const risk = atrVal * ATR_MULT;
  let tp1: number, tp2: number, tp3: number, sl: number;

  if (isLong) {
    sl = entry - risk;
    tp1 = (entry + risk * 1.5) * (1 - TAKER_FEE);
    tp2 = (entry + risk * 2.5) * (1 - TAKER_FEE);
    tp3 = (entry + risk * 4.0) * (1 - TAKER_FEE);
  } else {
    sl = entry + risk;
    tp1 = (entry - risk * 1.5) * (1 + TAKER_FEE);
    tp2 = (entry - risk * 2.5) * (1 + TAKER_FEE);
    tp3 = (entry - risk * 4.0) * (1 + TAKER_FEE);
  }

  let hit_tp1 = false, hit_tp2 = false, hit_tp3 = false, hit_sl = false;
  let max_favorable = 0;
  let max_adverse = 0;
  let bars_to_resolution = futureBars.length;

  for (let i = 0; i < futureBars.length; i++) {
    const bar = futureBars[i];

    if (isLong) {
      const favorable = bar.high - entry;
      const adverse = entry - bar.low;
      if (favorable > max_favorable) max_favorable = favorable;
      if (adverse > max_adverse) max_adverse = adverse;

      if (!hit_sl && bar.low <= sl) {
        hit_sl = true;
        if (!hit_tp1) { bars_to_resolution = i + 1; break; }
      }
      if (!hit_tp1 && bar.high >= tp1) hit_tp1 = true;
      if (!hit_tp2 && bar.high >= tp2) hit_tp2 = true;
      if (!hit_tp3 && bar.high >= tp3) hit_tp3 = true;
    } else {
      const favorable = entry - bar.low;
      const adverse = bar.high - entry;
      if (favorable > max_favorable) max_favorable = favorable;
      if (adverse > max_adverse) max_adverse = adverse;

      if (!hit_sl && bar.high >= sl) {
        hit_sl = true;
        if (!hit_tp1) { bars_to_resolution = i + 1; break; }
      }
      if (!hit_tp1 && bar.low <= tp1) hit_tp1 = true;
      if (!hit_tp2 && bar.low <= tp2) hit_tp2 = true;
      if (!hit_tp3 && bar.low <= tp3) hit_tp3 = true;
    }

    if (hit_tp3) {
      bars_to_resolution = i + 1;
      break;
    }
  }

  if (hit_tp1 && bars_to_resolution === futureBars.length) {
    for (let i = 0; i < futureBars.length; i++) {
      const bar = futureBars[i];
      if (isLong && bar.high >= tp1) { bars_to_resolution = i + 1; break; }
      if (!isLong && bar.low <= tp1) { bars_to_resolution = i + 1; break; }
    }
  }

  return { hit_tp1, hit_tp2, hit_tp3, hit_sl, bars_to_resolution, max_favorable, max_adverse, tp1, tp2, tp3, stop_loss: sl, entry_price: entry };
}

export function computeR(grade: GradeResult): number {
  const risk = Math.abs(grade.entry_price - grade.stop_loss);
  if (!Number.isFinite(risk) || risk === 0) return 0;
  if (grade.hit_tp3) return Math.abs(grade.tp3 - grade.entry_price) / risk;
  if (grade.hit_tp2) return Math.abs(grade.tp2 - grade.entry_price) / risk;
  if (grade.hit_tp1) return Math.abs(grade.tp1 - grade.entry_price) / risk;
  if (grade.hit_sl) return -1;
  return 0;
}
