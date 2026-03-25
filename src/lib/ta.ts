import { Kline } from "./bybit";

// ── EMA ─────────────────────────────────────────────────

export function ema(closes: number[], period: number): number[] {
  const k = 2 / (period + 1);
  const result: number[] = [];

  // Seed with SMA of first `period` values
  let sum = 0;
  for (let i = 0; i < period && i < closes.length; i++) {
    sum += closes[i];
  }
  result[period - 1] = sum / period;

  for (let i = period; i < closes.length; i++) {
    result[i] = closes[i] * k + result[i - 1] * (1 - k);
  }

  return result;
}

// ── ATR ─────────────────────────────────────────────────

export function atr(candles: Kline[], period: number): number[] {
  const trs: number[] = [];

  for (let i = 0; i < candles.length; i++) {
    if (i === 0) {
      trs.push(candles[i].high - candles[i].low);
    } else {
      const prevClose = candles[i - 1].close;
      const tr = Math.max(
        candles[i].high - candles[i].low,
        Math.abs(candles[i].high - prevClose),
        Math.abs(candles[i].low - prevClose)
      );
      trs.push(tr);
    }
  }

  // RMA (Wilder's smoothing) for ATR
  const result: number[] = [];
  let sum = 0;
  for (let i = 0; i < period && i < trs.length; i++) {
    sum += trs[i];
  }
  result[period - 1] = sum / period;

  for (let i = period; i < trs.length; i++) {
    result[i] = (result[i - 1] * (period - 1) + trs[i]) / period;
  }

  return result;
}

// ── HTF Trend ───────────────────────────────────────────

export type TrendDirection = "bullish" | "bearish" | "neutral";

export interface HTFTrendResult {
  ema20: number;
  ema50: number;
  close: number;
  trend: TrendDirection;
}

export function computeHTFTrend(candles: Kline[]): HTFTrendResult {
  const closes = candles.map((c) => c.close);
  const ema20 = ema(closes, 20);
  const ema50 = ema(closes, 50);

  const lastClose = closes[closes.length - 1];
  const lastEma20 = ema20[ema20.length - 1];
  const lastEma50 = ema50[ema50.length - 1];

  let trend: TrendDirection = "neutral";
  if (lastClose > lastEma50 && lastEma20 >= lastEma50) {
    trend = "bullish";
  } else if (lastClose < lastEma50 && lastEma20 <= lastEma50) {
    trend = "bearish";
  }

  return {
    ema20: lastEma20,
    ema50: lastEma50,
    close: lastClose,
    trend,
  };
}

// ── ATR latest value helper ─────────────────────────────

export function latestATR(candles: Kline[], period: number = 14): number {
  if (candles.length < period) return 0;
  const atrValues = atr(candles, period);
  if (atrValues.length === 0) return 0;
  return atrValues[atrValues.length - 1];
}

// ── ADX (Average Directional Index) ─────────────────────

export function adx(candles: Kline[], period: number): number {
  if (candles.length < period * 2) return 50; // not enough data

  // Compute +DM, -DM, TR series
  const pDM: number[] = [];
  const mDM: number[] = [];
  const tr: number[] = [];

  for (let i = 1; i < candles.length; i++) {
    const highDiff = candles[i].high - candles[i - 1].high;
    const lowDiff = candles[i - 1].low - candles[i].low;
    pDM.push(highDiff > lowDiff && highDiff > 0 ? highDiff : 0);
    mDM.push(lowDiff > highDiff && lowDiff > 0 ? lowDiff : 0);
    tr.push(Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i - 1].close),
      Math.abs(candles[i].low - candles[i - 1].close)
    ));
  }

  // Wilder's smoothing
  function smooth(values: number[], p: number): number[] {
    const result: number[] = [];
    let sum = 0;
    for (let i = 0; i < p && i < values.length; i++) sum += values[i];
    result[p - 1] = sum;
    for (let i = p; i < values.length; i++) {
      result[i] = result[i - 1] - result[i - 1] / p + values[i];
    }
    return result;
  }

  const smoothTR = smooth(tr, period);
  const smoothPDM = smooth(pDM, period);
  const smoothMDM = smooth(mDM, period);

  // DX series
  const dx: number[] = [];
  for (let i = period - 1; i < smoothTR.length; i++) {
    if (!smoothTR[i]) continue;
    const pdi = (smoothPDM[i] / smoothTR[i]) * 100;
    const mdi = (smoothMDM[i] / smoothTR[i]) * 100;
    const sum = pdi + mdi;
    dx.push(sum === 0 ? 0 : (Math.abs(pdi - mdi) / sum) * 100);
  }

  if (dx.length < period) return 50;

  // ADX = EMA of DX using Wilder's smoothing
  let adxVal = 0;
  for (let i = 0; i < period; i++) adxVal += dx[i];
  adxVal /= period;
  for (let i = period; i < dx.length; i++) {
    adxVal = (adxVal * (period - 1) + dx[i]) / period;
  }

  return adxVal;
}

// ── Rolling median helper ───────────────────────────────

export function rollingMedian(values: number[]): number {
  const sorted = [...values].filter((v) => v !== undefined).sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}
