import { fetchKlines } from "./bybit";
import { computeHTFTrend, atr, rollingMedian, TrendDirection } from "./ta";

export type BTCRegime = "trend_up" | "trend_down" | "range" | "high_volatility";
export type AltEnvironment = "favorable" | "mixed" | "hostile";

export interface RegimeResult {
  btc_regime: BTCRegime;
  alt_environment: AltEnvironment;
  btc_4h_trend: TrendDirection;
  btc_1d_trend: TrendDirection;
  btc_atr_ratio: number;
}

export async function classifyRegime(): Promise<RegimeResult> {
  const [btc4h, btc1d] = await Promise.all([
    fetchKlines("BTCUSDT", "240", 50),
    fetchKlines("BTCUSDT", "D", 30),
  ]);

  const trend4h = computeHTFTrend(btc4h);
  const trend1d = computeHTFTrend(btc1d);

  // ATR volatility check on 4H
  const atrValues = atr(btc4h, 14);
  const definedAtrs = atrValues.filter((v) => v !== undefined);
  const currentATR = definedAtrs[definedAtrs.length - 1];
  const medianATR = rollingMedian(definedAtrs);
  const atrRatio = medianATR > 0 ? currentATR / medianATR : 1;

  let btc_regime: BTCRegime;

  if (atrRatio > 2) {
    btc_regime = "high_volatility";
  } else if (trend4h.trend === "bullish" && trend1d.trend === "bullish") {
    btc_regime = "trend_up";
  } else if (trend4h.trend === "bearish" && trend1d.trend === "bearish") {
    btc_regime = "trend_down";
  } else {
    btc_regime = "range";
  }

  let alt_environment: AltEnvironment;
  if (btc_regime === "trend_up" || btc_regime === "range") {
    alt_environment = "favorable";
  } else if (btc_regime === "trend_down" || btc_regime === "high_volatility") {
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
  };
}
