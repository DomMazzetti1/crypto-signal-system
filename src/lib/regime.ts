import { fetchKlines, Kline } from "./bybit";
import { computeHTFTrend, ema, atr, adx, rollingMedian, TrendDirection } from "./ta";
import { getSupabase } from "./supabase";

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
  transition_zone: boolean;
  regime_age_hours: number | null;
  regime_weakening: boolean;
}

export async function classifyRegime(): Promise<RegimeResult> {
  const [btc4h, btc1d] = await Promise.all([
    fetchKlines("BTCUSDT", "240", 60),
    fetchKlines("BTCUSDT", "D", 220),
  ]);

  const base = classifyRegimeFromCandles(btc4h, btc1d);

  // ── transition_zone: BTC within 2% of EMA200 ──
  let transition_zone = false;
  let regime_age_hours: number | null = null;

  try {
    const supabase = getSupabase();
    const { data: latestRow } = await supabase
      .from("btc_regime_history")
      .select("distance_to_ema200_pct, regime, date")
      .order("date", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (latestRow) {
      transition_zone = Math.abs(Number(latestRow.distance_to_ema200_pct)) < 0.02;

      // ── regime_age_hours: find earliest consecutive day with same regime ──
      const { data: history } = await supabase
        .from("btc_regime_history")
        .select("date, regime")
        .order("date", { ascending: false })
        .limit(90);

      if (history && history.length > 0) {
        const currentRegime = latestRow.regime;
        let earliestDate = latestRow.date;
        for (const row of history) {
          if (row.regime === currentRegime) {
            earliestDate = row.date;
          } else {
            break;
          }
        }
        const startMs = new Date(earliestDate + "T00:00:00Z").getTime();
        regime_age_hours = Math.round((Date.now() - startMs) / (1000 * 60 * 60));
      }
    } else {
      // Fallback: compute inline from candle data
      if (base.btc_ema200 > 0) {
        const distPct = Math.abs(base.btc_close - base.btc_ema200) / base.btc_ema200 * 100;
        transition_zone = distPct < 2.0;
      }
    }
  } catch (err) {
    console.warn("[regime] btc_regime_history query failed, using inline fallback:", err);
    if (base.btc_ema200 > 0) {
      const distPct = Math.abs(base.btc_close - base.btc_ema200) / base.btc_ema200 * 100;
      transition_zone = distPct < 2.0;
    }
  }

  // ── regime_weakening: 4H EMA50 slope vs daily regime ──
  let regime_weakening = false;
  try {
    const closes4h = btc4h.map((c) => c.close);
    const ema50_4h = ema(closes4h, 50);
    const latest = ema50_4h[ema50_4h.length - 1];
    const fiveBarsAgo = ema50_4h[ema50_4h.length - 6];
    if (latest !== undefined && fiveBarsAgo !== undefined && fiveBarsAgo > 0) {
      const slopePositive = latest > fiveBarsAgo;
      if (slopePositive && base.btc_regime === "bear") regime_weakening = true;
      if (!slopePositive && base.btc_regime === "bull") regime_weakening = true;
    }
  } catch {
    // regime_weakening stays false
  }

  return { ...base, transition_zone, regime_age_hours, regime_weakening };
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
  const btc4hAdxRaw = adx(btc4h, 14);
  const btc4hAdxValue = typeof btc4hAdxRaw === 'number' && Number.isFinite(btc4hAdxRaw) ? btc4hAdxRaw : 50;

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
  } else if (Math.abs(distFromEma200) < 0.03 || btc4hAdxValue < 20) {
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
    transition_zone: false,
    regime_age_hours: null,
    regime_weakening: false,
  };
}
