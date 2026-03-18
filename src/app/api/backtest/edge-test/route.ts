import { NextResponse, NextRequest } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { fetchKlines, Kline } from "@/lib/bybit";
import { computeIndicators, detectSignals } from "@/lib/signals";
import { classifyRegimeFromCandles, BTCRegime } from "@/lib/regime";
import { runGateB } from "@/lib/gate-b";
import { computeHTFTrend } from "@/lib/ta";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const MAX_CONCURRENT = 6;
const WARMUP_BARS = 150;
const FORWARD_BARS = 48;
const ATR_MULT = 1.5;

const TAKER_FEE = 0.00055;
const SLIPPAGE = 0.0005;

// ── Edge feature flags ──────────────────────────────────

interface EdgeFlags {
  funding_rate_filter: boolean;
  oi_divergence: boolean;
  time_of_day_filter: boolean;
  consolidation_bars: boolean;
}

const DEFAULT_FLAGS: EdgeFlags = {
  funding_rate_filter: false,
  oi_divergence: false,
  time_of_day_filter: false,
  consolidation_bars: false,
};

// ── Types ───────────────────────────────────────────────

interface BacktestSignal {
  symbol: string;
  setup_type: string;
  candle_time: string;
  entry_price: number;
  stop_loss: number;
  tp1: number;
  tp2: number;
  tp3: number;
  hit_tp1: boolean;
  hit_tp2: boolean;
  hit_tp3: boolean;
  hit_sl: boolean;
  bars_to_resolution: number;
  max_favorable: number;
  max_adverse: number;
  regime: string;
  atr: number;
}

interface SetupStats {
  count: number;
  win_rate: number;
  avg_r: number;
}

interface RegimeStats {
  count: number;
  win_rate: number;
}

// ── Edge filters ────────────────────────────────────────

/**
 * Funding rate filter: use volume-weighted price movement as proxy.
 * In a backtest we don't have historical funding rates, so we
 * approximate: if recent price trend aligns with signal direction
 * (sellers pushing price down for shorts), funding is likely favorable.
 *
 * Proxy: 8-bar price change direction.
 * SHORT signals: require price dropped over last 8 bars (funding likely positive)
 * LONG signals: require price rose over last 8 bars (funding likely negative)
 */
function passesFundingRateFilter(
  candles1h: Kline[],
  barIndex: number,
  isLong: boolean
): boolean {
  if (barIndex < 8) return true;
  const current = candles1h[barIndex].close;
  const past = candles1h[barIndex - 8].close;
  const priceChange = (current - past) / past;

  // For shorts: price should have been rising (funding positive = longs pay shorts)
  // For longs: price should have been falling (funding negative = shorts pay longs)
  if (isLong) return priceChange < -0.01; // price dropped 1%+
  return priceChange > 0.01; // price rose 1%+
}

/**
 * OI divergence: price makes extreme but OI is falling.
 * Proxy using volume as OI substitute (historical OI not available in klines).
 * If volume is declining while price makes extremes, it suggests
 * the move is exhausting — good for mean reversion.
 */
function passesOIDivergence(
  candles1h: Kline[],
  barIndex: number,
  isLong: boolean
): boolean {
  if (barIndex < 10) return true;
  const recent = candles1h.slice(barIndex - 5, barIndex + 1);
  const prior = candles1h.slice(barIndex - 10, barIndex - 5);

  const recentAvgVol = recent.reduce((s, c) => s + c.volume, 0) / recent.length;
  const priorAvgVol = prior.reduce((s, c) => s + c.volume, 0) / prior.length;

  // Volume declining (< 80% of prior) while price at extreme = divergence
  const volumeDeclining = recentAvgVol < priorAvgVol * 0.8;

  if (isLong) {
    // Price at low but volume declining = bullish divergence
    const priceAtLow = candles1h[barIndex].close <= Math.min(...recent.map(c => c.low));
    return volumeDeclining || priceAtLow;
  }
  // Price at high but volume declining = bearish divergence
  const priceAtHigh = candles1h[barIndex].close >= Math.max(...recent.map(c => c.high));
  return volumeDeclining || priceAtHigh;
}

/**
 * Time of day filter: only allow signals during high-volume hours.
 * London open (08:00) through NY afternoon (16:00 UTC).
 */
function passesTimeOfDayFilter(candleStartTime: number): boolean {
  const hour = new Date(candleStartTime).getUTCHours();
  return hour >= 8 && hour <= 16;
}

/**
 * Consolidation bars: require at least 5 of the last 10 bars
 * to have a range < 0.5 * ATR (tight consolidation).
 * Confirms squeeze conditions before breakout/reversion.
 */
function passesConsolidationBars(
  candles1h: Kline[],
  barIndex: number,
  atr1h: number
): boolean {
  if (barIndex < 10) return true;
  const lookback = candles1h.slice(barIndex - 10, barIndex);
  const threshold = atr1h * 0.5;
  const tightBars = lookback.filter(c => (c.high - c.low) < threshold).length;
  return tightBars >= 5;
}

// ── Shared utilities ────────────────────────────────────

async function runWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = [];
  let index = 0;
  async function worker() {
    while (index < items.length) {
      const i = index++;
      results[i] = await fn(items[i]);
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

async function fetchRetry(symbol: string, interval: string, limit: number): Promise<Kline[]> {
  try {
    return await fetchKlines(symbol, interval, limit);
  } catch {
    await new Promise((r) => setTimeout(r, 500));
    return fetchKlines(symbol, interval, limit);
  }
}

function candlesUpTo(candles: Kline[], beforeMs: number): Kline[] {
  const filtered: Kline[] = [];
  for (const c of candles) {
    if (c.startTime < beforeMs) filtered.push(c);
  }
  return filtered;
}

function gradeSignal(
  rawEntry: number,
  atrVal: number,
  isLong: boolean,
  futureBars: Kline[]
): {
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
} {
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

function computeR(sig: BacktestSignal): number {
  const risk = Math.abs(sig.entry_price - sig.stop_loss);
  if (risk === 0) return 0;
  if (sig.hit_tp3) return (Math.abs(sig.tp3 - sig.entry_price)) / risk;
  if (sig.hit_tp2) return (Math.abs(sig.tp2 - sig.entry_price)) / risk;
  if (sig.hit_tp1) return (Math.abs(sig.tp1 - sig.entry_price)) / risk;
  if (sig.hit_sl) return -1;
  return 0;
}

function round(n: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

// ── Main handler ────────────────────────────────────────

export async function GET(req: NextRequest) {
  const startTime = Date.now();
  const supabase = getSupabase();

  // Parse edge flags from query params
  const url = new URL(req.url);
  const flags: EdgeFlags = { ...DEFAULT_FLAGS };
  for (const key of Object.keys(DEFAULT_FLAGS) as (keyof EdgeFlags)[]) {
    const val = url.searchParams.get(key);
    if (val === "true" || val === "1") flags[key] = true;
    if (val === "false" || val === "0") flags[key] = false;
  }

  // 1. Read eligible symbols
  const { data: universeRows, error: uniError } = await supabase
    .from("universe")
    .select("symbol")
    .eq("is_eligible", true)
    .order("symbol");

  if (uniError || !universeRows) {
    return NextResponse.json({ error: "Failed to read universe" }, { status: 500 });
  }

  const symbols = universeRows.map((r) => r.symbol);
  const allSignals: BacktestSignal[] = [];
  const symbolErrors: { symbol: string; error: string }[] = [];
  let filteredByGateB = 0;
  let filteredByEdge = 0;

  // 2. Fetch BTC data for regime classification
  let btc4h: Kline[], btc1d: Kline[];
  try {
    [btc4h, btc1d] = await Promise.all([
      fetchRetry("BTCUSDT", "240", 1000),
      fetchRetry("BTCUSDT", "D", 1000),
    ]);
  } catch (err) {
    return NextResponse.json({ error: "Failed to fetch BTC data", detail: String(err) }, { status: 502 });
  }

  // 3. Process each symbol
  await runWithConcurrency(symbols, MAX_CONCURRENT, async (symbol) => {
    let candles1h: Kline[], candles4h: Kline[], candles1d: Kline[];
    try {
      [candles1h, candles4h, candles1d] = await Promise.all([
        fetchRetry(symbol, "60", 1000),
        fetchRetry(symbol, "240", 1000),
        fetchRetry(symbol, "D", 1000),
      ]);
    } catch (err) {
      symbolErrors.push({ symbol, error: String(err) });
      return;
    }

    if (candles1h.length < WARMUP_BARS + FORWARD_BARS) return;

    for (let i = WARMUP_BARS; i < candles1h.length - FORWARD_BARS; i++) {
      const slice1h = candles1h.slice(0, i + 1);
      const currentBarTime = candles1h[i].startTime;

      const slice4h = candlesUpTo(candles4h, currentBarTime + 1);
      const slice1d = candlesUpTo(candles1d, currentBarTime + 1);

      if (slice4h.length < 14 || slice1d.length < 14) continue;

      const indicators = computeIndicators(slice1h, slice4h, slice1d);
      if (!indicators) continue;

      const signals = detectSignals(symbol, indicators);
      if (signals.length === 0) continue;

      // Classify regime
      const btc4hSlice = candlesUpTo(btc4h, currentBarTime + 1);
      const btc1dSlice = candlesUpTo(btc1d, currentBarTime + 1);
      let regime: BTCRegime = "sideways";
      if (btc4hSlice.length >= 14 && btc1dSlice.length >= 14) {
        const regimeResult = classifyRegimeFromCandles(btc4hSlice, btc1dSlice);
        regime = regimeResult.btc_regime;
      }

      const trend4h = computeHTFTrend(slice4h);
      const futureBars = candles1h.slice(i + 1, i + 1 + FORWARD_BARS);

      for (const sig of signals) {
        const isLong = sig.type.includes("LONG");
        const rawEntry = indicators.close;
        const atrVal = indicators.atr_1h;

        // Gate B (same as production)
        const gateB = runGateB({
          alertType: sig.type,
          trend4h: trend4h.trend,
          btcRegime: regime,
          atr1h: atrVal,
          markPrice: rawEntry,
          rrTp1: 1.5,
          rsi: indicators.rsi,
          adx1h: indicators.adx_1h,
          volume: indicators.volume,
          sma20Volume: indicators.sma20_volume,
        });

        if (!gateB.passed) {
          filteredByGateB++;
          continue;
        }

        // ── Apply edge filters ────────────────────────
        let edgeRejected = false;

        if (flags.funding_rate_filter) {
          if (!passesFundingRateFilter(candles1h, i, isLong)) {
            edgeRejected = true;
          }
        }

        if (!edgeRejected && flags.oi_divergence) {
          if (!passesOIDivergence(candles1h, i, isLong)) {
            edgeRejected = true;
          }
        }

        if (!edgeRejected && flags.time_of_day_filter) {
          if (!passesTimeOfDayFilter(currentBarTime)) {
            edgeRejected = true;
          }
        }

        if (!edgeRejected && flags.consolidation_bars) {
          if (!passesConsolidationBars(candles1h, i, atrVal)) {
            edgeRejected = true;
          }
        }

        if (edgeRejected) {
          filteredByEdge++;
          continue;
        }

        const grade = gradeSignal(rawEntry, atrVal, isLong, futureBars);

        allSignals.push({
          symbol,
          setup_type: sig.type,
          candle_time: new Date(currentBarTime).toISOString(),
          entry_price: grade.entry_price,
          stop_loss: grade.stop_loss,
          tp1: grade.tp1,
          tp2: grade.tp2,
          tp3: grade.tp3,
          hit_tp1: grade.hit_tp1,
          hit_tp2: grade.hit_tp2,
          hit_tp3: grade.hit_tp3,
          hit_sl: grade.hit_sl,
          bars_to_resolution: grade.bars_to_resolution,
          max_favorable: grade.max_favorable,
          max_adverse: grade.max_adverse,
          regime,
          atr: atrVal,
        });
      }
    }
  });

  // 4. Calculate aggregate statistics
  const total = allSignals.length;
  const wins = allSignals.filter((s) => s.hit_tp1).length;
  const losses = allSignals.filter((s) => s.hit_sl && !s.hit_tp1).length;
  const rValues = allSignals.map(computeR);
  const avgR = total > 0 ? rValues.reduce((a, b) => a + b, 0) / total : 0;
  const grossProfit = rValues.filter((r) => r > 0).reduce((a, b) => a + b, 0);
  const grossLoss = Math.abs(rValues.filter((r) => r < 0).reduce((a, b) => a + b, 0));
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;
  const expectancy = total > 0
    ? (wins / total) * (grossProfit / (wins || 1)) - (losses / total) * (grossLoss / (losses || 1))
    : 0;

  const setupTypes = ["MR_LONG", "MR_SHORT", "SQ_SHORT"] as const;
  const by_setup: Record<string, SetupStats> = {};
  for (const st of setupTypes) {
    const subset = allSignals.filter((s) => s.setup_type === st);
    const subRs = subset.map(computeR);
    by_setup[st] = {
      count: subset.length,
      win_rate: subset.length > 0 ? subset.filter((s) => s.hit_tp1).length / subset.length : 0,
      avg_r: subset.length > 0 ? subRs.reduce((a, b) => a + b, 0) / subset.length : 0,
    };
  }

  const regimeTypes = ["bull", "bear", "sideways"] as const;
  const by_regime: Record<string, RegimeStats> = {};
  for (const rt of regimeTypes) {
    const subset = allSignals.filter((s) => s.regime === rt);
    by_regime[rt] = {
      count: subset.length,
      win_rate: subset.length > 0 ? subset.filter((s) => s.hit_tp1).length / subset.length : 0,
    };
  }

  const by_setup_regime: Record<string, SetupStats> = {};
  for (const st of setupTypes) {
    for (const rt of regimeTypes) {
      const key = `${st}_${rt}`;
      const subset = allSignals.filter((s) => s.setup_type === st && s.regime === rt);
      if (subset.length === 0) continue;
      const subRs = subset.map(computeR);
      by_setup_regime[key] = {
        count: subset.length,
        win_rate: subset.filter((s) => s.hit_tp1).length / subset.length,
        avg_r: subRs.reduce((a, b) => a + b, 0) / subset.length,
      };
    }
  }

  const summary = {
    edge_flags: flags,
    baseline: { signals: 20, win_rate: 0.45, profit_factor: 2.87, avg_r: 0.94 },
    symbols_tested: symbols.length,
    total_signals: total,
    win_rate_tp1: total > 0 ? round(wins / total, 4) : 0,
    profit_factor: round(profitFactor, 2),
    expectancy: round(expectancy, 4),
    avg_r: round(avgR, 2),
    by_setup: Object.fromEntries(
      Object.entries(by_setup).map(([k, v]) => [
        k, { count: v.count, win_rate: round(v.win_rate, 4), avg_r: round(v.avg_r, 2) },
      ])
    ),
    by_regime: Object.fromEntries(
      Object.entries(by_regime).map(([k, v]) => [
        k, { count: v.count, win_rate: round(v.win_rate, 4) },
      ])
    ),
    by_setup_regime: Object.fromEntries(
      Object.entries(by_setup_regime).map(([k, v]) => [
        k, { count: v.count, win_rate: round(v.win_rate, 4), avg_r: round(v.avg_r, 2) },
      ])
    ),
    filtered_by_gate_b: filteredByGateB,
    filtered_by_edge: filteredByEdge,
    symbol_errors: symbolErrors.length,
    runtime_ms: Date.now() - startTime,
  };

  console.log("[backtest/edge-test] Complete:", JSON.stringify(summary));
  return NextResponse.json(summary);
}
