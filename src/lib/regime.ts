import { fetchKlines, Kline } from "./bybit";
import { computeHTFTrend, ema, atr, adx, rollingMedian, TrendDirection } from "./ta";

export type BTCRegime = "bull" | "bear" | "sideways";
export type AltEnvironment = "favorable" | "mixed" | "hostile";

export interface RegimeResult {
  btc_regime: BTCRegime;
  alt_environment: AltEnvironment;
  btc_4h_trend: TrendDirection;
  btc_1d_trend: TrendDirection;
  btc_atr_ratio: number;
  btc_ema200: number;
  btc_ema200_slope: number;
  btc_close: number;
}

export async function classifyRegime(): Promise<RegimeResult> {
  const [btc4h, btc1d] = await Promise.all([
    fetchKlines("BTCUSDT", "240", 50),
    fetchKlines("BTCUSDT", "D", 220),
  ]);

  return classifyRegimeFromCandles(btc4h, btc1d);
}

export function classifyRegimeFromCandles(
  btc4h: Kline[],
  btc1d: Kline[]
): RegimeResult {
  const trend4h = computeHTFTrend(btc4h);
  const trend1d = computeHTFTrend(btc1d);

  // ATR volatility check on 4H
  const atrValues = atr(btc4h, 14);
  const definedAtrs = atrValues.filter((v) => v !== undefined);
  const currentATR = definedAtrs[definedAtrs.length - 1];
  const medianATR = rollingMedian(definedAtrs);
  const atrRatio = medianATR > 0 ? currentATR / medianATR : 1;

  // EMA200 on daily closes
  const dailyCloses = btc1d.map((c) => c.close);
  const ema200Values = ema(dailyCloses, 200);
  const currentEma200 = ema200Values[ema200Values.length - 1];
  const ema200_10ago = ema200Values[ema200Values.length - 11];
  const btcClose = dailyCloses[dailyCloses.length - 1];

  // EMA200 slope: percentage change over last 10 bars
  const ema200Slope = currentEma200 && ema200_10ago
    ? (currentEma200 - ema200_10ago) / ema200_10ago
    : 0;

  // Distance from EMA200 as percentage
  const distFromEma200 = currentEma200
    ? (btcClose - currentEma200) / currentEma200
    : 0;

  // ADX on 4H for sideways detection
  const btc4hAdx = adx(btc4h, 14);

  let btc_regime: BTCRegime;

  if (!currentEma200) {
    // Not enough daily data for EMA200 — fall back to trend-based
    if (trend4h.trend === "bullish" && trend1d.trend === "bullish") {
      btc_regime = "bull";
    } else if (trend4h.trend === "bearish" && trend1d.trend === "bearish") {
      btc_regime = "bear";
    } else {
      btc_regime = "sideways";
    }
  } else if (Math.abs(distFromEma200) < 0.03 || btc4hAdx < 20) {
    // Within 3% of EMA200 OR low ADX — sideways
    btc_regime = "sideways";
  } else if (btcClose > currentEma200 && ema200Slope > 0) {
    btc_regime = "bull";
  } else if (btcClose < currentEma200 && ema200Slope < 0) {
    btc_regime = "bear";
  } else {
    // Price on one side but slope disagrees — sideways
    btc_regime = "sideways";
  }

  let alt_environment: AltEnvironment;
  if (btc_regime === "bull") {
    alt_environment = "favorable";
  } else if (btc_regime === "bear") {
    alt_environment = "hostile";
  } else {
    alt_environment = "mixed";
  }

  return {
    btc_regime,
    alt_environment,
    btc_4h_trend: trend4h.trend,
    btc_1d_trend: trend1d.trend,
    btc_atr_ratio: atrRatio,
    btc_ema200: currentEma200 ?? 0,
    btc_ema200_slope: ema200Slope,
    btc_close: btcClose,
  };
}
