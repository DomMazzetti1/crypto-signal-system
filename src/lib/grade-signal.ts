/**
 * Shared signal grading logic for backtest/shadow research paths.
 *
 * This tracks the current live 3-target ladder:
 *   TP1 = 0.5R
 *   TP2 = 1.0R
 *   TP3 = 2.5R
 *
 * Entry slippage is applied to the fill estimate. TP2/TP3 are fee-adjusted to
 * stay conservative, while TP1 remains the raw maker target.
 */

import { Kline } from "./bybit";

const ATR_MULT = 1.5;
const TAKER_FEE = 0.00055;
const SLIPPAGE = 0.0005;
const FIRST_TRANCHE_PCT = 0.34;
const SECOND_TRANCHE_PCT = 0.33;
const THIRD_TRANCHE_PCT = 0.33;
const TP1_R = 0.5;
const TP2_R = 1.0;
const TP3_R = 2.5;

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
    tp1 = entry + risk * TP1_R;
    tp2 = (entry + risk * TP2_R) * (1 - TAKER_FEE);
    tp3 = (entry + risk * TP3_R) * (1 - TAKER_FEE);
  } else {
    sl = entry + risk;
    tp1 = entry - risk * TP1_R;
    tp2 = (entry - risk * TP2_R) * (1 + TAKER_FEE);
    tp3 = (entry - risk * TP3_R) * (1 + TAKER_FEE);
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

export function computeLadderR(grade: GradeResult): number {
  const risk = Math.abs(grade.entry_price - grade.stop_loss);
  if (!Number.isFinite(risk) || risk === 0) return 0;

  const tp1R = Math.abs(grade.tp1 - grade.entry_price) / risk;
  const tp2R = Math.abs(grade.tp2 - grade.entry_price) / risk;
  const tp3R = Math.abs(grade.tp3 - grade.entry_price) / risk;

  if (!grade.hit_tp1 && grade.hit_sl) return -1;
  if (!grade.hit_tp1) return 0;

  let realizedR = FIRST_TRANCHE_PCT * tp1R;

  if (grade.hit_tp2) {
    realizedR += SECOND_TRANCHE_PCT * tp2R;
    if (grade.hit_tp3) {
      realizedR += THIRD_TRANCHE_PCT * tp3R;
    }
  } else if (grade.hit_sl) {
    realizedR -= SECOND_TRANCHE_PCT + THIRD_TRANCHE_PCT;
  }

  return Math.round(realizedR * 1000) / 1000;
}
