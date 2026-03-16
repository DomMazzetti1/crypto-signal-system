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
  const atrValues = atr(candles, period);
  return atrValues[atrValues.length - 1];
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
