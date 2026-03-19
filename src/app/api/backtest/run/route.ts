import { NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { Kline } from "@/lib/bybit";
import { computeIndicators, detectSignals } from "@/lib/signals";
import { classifyRegimeFromCandles, BTCRegime } from "@/lib/regime";
import { runGateB } from "@/lib/gate-b";
import { computeHTFTrend } from "@/lib/ta";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const MAX_CONCURRENT = 4;
const WARMUP_BARS = 150;
const FORWARD_BARS = 48;
const ATR_MULT = 1.5;

// Friction model (Bybit perps)
const TAKER_FEE = 0.00055;  // 0.055% per side
const SLIPPAGE = 0.0005;     // 0.05% per side

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

// ── Concurrency limiter ─────────────────────────────────

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

// ── Target candle counts for 1 year of data ────────────

const TARGET_CANDLES: Record<string, number> = {
  "60": 8760,    // 1H: 365 × 24
  "240": 2190,   // 4H: 365 × 6
  "D": 400,      // 1D: just over 1 year
};

const BYBIT_BATCH = 1000;

// ── Paginated kline fetch (1 year of data) ──────────────

async function fetchKlinesPaginated(
  symbol: string,
  interval: string,
  target?: number
): Promise<Kline[]> {
  const totalNeeded = target ?? TARGET_CANDLES[interval] ?? 1000;
  const allCandles: Map<number, Kline> = new Map();
  let endParam: number | undefined = undefined;

  while (allCandles.size < totalNeeded) {
    const batchSize = Math.min(BYBIT_BATCH, totalNeeded - allCandles.size);
    let url = `https://api.bybit.com/v5/market/kline?category=linear&symbol=${symbol}&interval=${interval}&limit=${batchSize}`;
    if (endParam !== undefined) {
      url += `&end=${endParam}`;
    }

    let data: { retCode: number; retMsg: string; result: { list: string[][] } };
    try {
      const res = await fetch(url, { cache: "no-store" });
      data = await res.json();
    } catch {
      // Retry once after delay
      await new Promise((r) => setTimeout(r, 500));
      const res = await fetch(url, { cache: "no-store" });
      data = await res.json();
    }

    if (data.retCode !== 0) {
      throw new Error(`Kline fetch failed for ${symbol} (${interval}): ${data.retMsg}`);
    }

    const batch = data.result.list;
    if (batch.length === 0) break; // No more data available

    for (const k of batch) {
      const startTime = Number(k[0]);
      if (!allCandles.has(startTime)) {
        allCandles.set(startTime, {
          startTime,
          open: parseFloat(k[1]),
          high: parseFloat(k[2]),
          low: parseFloat(k[3]),
          close: parseFloat(k[4]),
          volume: parseFloat(k[5]),
        });
      }
    }

    // Bybit returns newest-first; last element is earliest
    const earliestTime = Number(batch[batch.length - 1][0]);
    if (endParam !== undefined && earliestTime >= endParam) break; // No progress
    endParam = earliestTime; // Use earliest startTime as end for next batch
  }

  // Return in chronological order
  return Array.from(allCandles.values()).sort((a, b) => a.startTime - b.startTime);
}

// ── Find 4H/1D candles up to a given 1H timestamp ──────

function candlesUpTo(candles: Kline[], beforeMs: number): Kline[] {
  // Return all candles whose start time is before the given 1H candle start
  const filtered: Kline[] = [];
  for (const c of candles) {
    if (c.startTime < beforeMs) filtered.push(c);
  }
  return filtered;
}

// ── Grade a signal against future bars ──────────────────

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
  // Apply slippage to entry
  const entry = isLong
    ? rawEntry * (1 + SLIPPAGE)
    : rawEntry * (1 - SLIPPAGE);

  const risk = atrVal * ATR_MULT;
  let tp1: number, tp2: number, tp3: number, sl: number;

  // Apply taker fee to exit levels (reduces profit targets, widens stop loss)
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

    if (hit_tp1 && !hit_tp2 && !hit_tp3) {
      // Continue looking for higher TPs
    }
    if (hit_tp3) {
      bars_to_resolution = i + 1;
      break;
    }
  }

  // If TP1 hit first and then SL hit, resolution is at TP1 bar still
  if (hit_tp1 && bars_to_resolution === futureBars.length) {
    // Find the bar where tp1 was first hit
    for (let i = 0; i < futureBars.length; i++) {
      const bar = futureBars[i];
      if (isLong && bar.high >= tp1) { bars_to_resolution = i + 1; break; }
      if (!isLong && bar.low <= tp1) { bars_to_resolution = i + 1; break; }
    }
  }

  return { hit_tp1, hit_tp2, hit_tp3, hit_sl, bars_to_resolution, max_favorable, max_adverse, tp1, tp2, tp3, stop_loss: sl, entry_price: entry };
}

// ── Compute R at close for a signal ─────────────────────

function computeR(sig: BacktestSignal): number {
  const risk = Math.abs(sig.entry_price - sig.stop_loss);
  if (risk === 0) return 0;
  if (sig.hit_tp3) return (Math.abs(sig.tp3 - sig.entry_price)) / risk;
  if (sig.hit_tp2) return (Math.abs(sig.tp2 - sig.entry_price)) / risk;
  if (sig.hit_tp1) return (Math.abs(sig.tp1 - sig.entry_price)) / risk;
  if (sig.hit_sl) return -1;
  return 0; // no resolution
}

// ── Main handler ────────────────────────────────────────

export async function GET() {
  const startTime = Date.now();
  const supabase = getSupabase();

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

  // 2. Fetch BTC data for regime classification (paginated for 1 year)
  let btc4h: Kline[], btc1d: Kline[];
  try {
    [btc4h, btc1d] = await Promise.all([
      fetchKlinesPaginated("BTCUSDT", "240"),
      fetchKlinesPaginated("BTCUSDT", "D"),
    ]);
    console.log(`[backtest] BTC data loaded: ${btc4h.length} 4H candles, ${btc1d.length} 1D candles`);
  } catch (err) {
    return NextResponse.json({ error: "Failed to fetch BTC data", detail: String(err) }, { status: 502 });
  }

  // 3. Process each symbol
  let symbolsDone = 0;
  await runWithConcurrency(symbols, MAX_CONCURRENT, async (symbol) => {
    let candles1h: Kline[], candles4h: Kline[], candles1d: Kline[];
    try {
      [candles1h, candles4h, candles1d] = await Promise.all([
        fetchKlinesPaginated(symbol, "60"),
        fetchKlinesPaginated(symbol, "240"),
        fetchKlinesPaginated(symbol, "D"),
      ]);
    } catch (err) {
      symbolErrors.push({ symbol, error: String(err) });
      symbolsDone++;
      console.log(`[backtest] symbol ${symbolsDone}/${symbols.length} ${symbol} ERROR`);
      return;
    }

    if (candles1h.length < WARMUP_BARS + FORWARD_BARS) return;

    // Walk through each 1H bar starting from warmup
    for (let i = WARMUP_BARS; i < candles1h.length - FORWARD_BARS; i++) {
      const slice1h = candles1h.slice(0, i + 1);
      const currentBarTime = candles1h[i].startTime;

      // Get 4H and 1D candles up to this point
      const slice4h = candlesUpTo(candles4h, currentBarTime + 1);
      const slice1d = candlesUpTo(candles1d, currentBarTime + 1);

      if (slice4h.length < 14 || slice1d.length < 14) continue;

      // Compute indicators
      const indicators = computeIndicators(slice1h, slice4h, slice1d);
      if (!indicators) continue;

      // Detect signals
      const signals = detectSignals(symbol, indicators);
      if (signals.length === 0) continue;

      // Classify regime at this point in time
      const btc4hSlice = candlesUpTo(btc4h, currentBarTime + 1);
      const btc1dSlice = candlesUpTo(btc1d, currentBarTime + 1);
      let regime: BTCRegime = "sideways";
      if (btc4hSlice.length >= 14 && btc1dSlice.length >= 14) {
        const regimeResult = classifyRegimeFromCandles(btc4hSlice, btc1dSlice);
        regime = regimeResult.btc_regime;
      }

      // 4H trend for Gate B
      const trend4h = computeHTFTrend(slice4h);

      // Grade each signal — only if it passes Gate B
      const futureBars = candles1h.slice(i + 1, i + 1 + FORWARD_BARS);

      for (const sig of signals) {
        const isLong = sig.type.includes("LONG");
        const rawEntry = indicators.close;
        const atrVal = indicators.atr_1h;

        // Apply Gate B (same logic as live pipeline)
        const gateB = runGateB({
          alertType: sig.type,
          trend4h: trend4h.trend,
          btcRegime: regime,
          atr1h: atrVal,
          markPrice: rawEntry,
          rrTp1: 1.5, // calculateLevels always produces 1.5 R:R to TP1
          rsi: indicators.rsi,
          adx1h: indicators.adx_1h,
          volume: indicators.volume,
          sma20Volume: indicators.sma20_volume,
        });

        if (!gateB.passed) {
          filteredByGateB++;
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

    symbolsDone++;
    console.log(`[backtest] symbol ${symbolsDone}/${symbols.length} ${symbol} complete`);
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

  // By setup type
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

  // By regime
  const regimeTypes = ["bull", "bear", "sideways"] as const;
  const by_regime: Record<string, RegimeStats> = {};
  for (const rt of regimeTypes) {
    const subset = allSignals.filter((s) => s.regime === rt);
    by_regime[rt] = {
      count: subset.length,
      win_rate: subset.length > 0 ? subset.filter((s) => s.hit_tp1).length / subset.length : 0,
    };
  }

  // By setup × regime combination
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

  // Compute backtest period from signal timestamps
  const candleTimes = allSignals.map((s) => new Date(s.candle_time).getTime());
  const earliestMs = candleTimes.length > 0 ? Math.min(...candleTimes) : 0;
  const latestMs = candleTimes.length > 0 ? Math.max(...candleTimes) : 0;
  const tradingDays = candleTimes.length > 0 ? Math.round((latestMs - earliestMs) / (1000 * 60 * 60 * 24)) : 0;

  const summary = {
    symbols_tested: symbols.length,
    backtest_period: {
      from: earliestMs > 0 ? new Date(earliestMs).toISOString() : null,
      to: latestMs > 0 ? new Date(latestMs).toISOString() : null,
      trading_days: tradingDays,
    },
    total_signals: total,
    win_rate_tp1: total > 0 ? round(wins / total, 4) : 0,
    profit_factor: round(profitFactor, 2),
    expectancy: round(expectancy, 4),
    avg_r: round(avgR, 2),
    by_setup: Object.fromEntries(
      Object.entries(by_setup).map(([k, v]) => [
        k,
        { count: v.count, win_rate: round(v.win_rate, 4), avg_r: round(v.avg_r, 2) },
      ])
    ),
    by_regime: Object.fromEntries(
      Object.entries(by_regime).map(([k, v]) => [
        k,
        { count: v.count, win_rate: round(v.win_rate, 4) },
      ])
    ),
    by_setup_regime: Object.fromEntries(
      Object.entries(by_setup_regime).map(([k, v]) => [
        k,
        { count: v.count, win_rate: round(v.win_rate, 4), avg_r: round(v.avg_r, 2) },
      ])
    ),
    filtered_by_gate_b: filteredByGateB,
    symbol_errors: symbolErrors.length,
    runtime_ms: Date.now() - startTime,
  };

  // 5. Store results in Supabase
  const { data: runRow } = await supabase
    .from("backtest_runs")
    .insert({
      symbols_tested: symbols.length,
      total_signals: total,
      results: allSignals,
      summary,
    })
    .select("id")
    .maybeSingle();

  const runId = runRow?.id ?? null;

  // Store individual signals (batch in chunks of 100)
  if (runId && allSignals.length > 0) {
    for (let i = 0; i < allSignals.length; i += 100) {
      const batch = allSignals.slice(i, i + 100).map((s) => ({
        backtest_run_id: runId,
        symbol: s.symbol,
        setup_type: s.setup_type,
        candle_time: s.candle_time,
        entry_price: s.entry_price,
        stop_loss: s.stop_loss,
        tp1: s.tp1,
        tp2: s.tp2,
        tp3: s.tp3,
        hit_tp1: s.hit_tp1,
        hit_tp2: s.hit_tp2,
        hit_tp3: s.hit_tp3,
        hit_sl: s.hit_sl,
        bars_to_resolution: s.bars_to_resolution,
        max_favorable: s.max_favorable,
        max_adverse: s.max_adverse,
        regime: s.regime,
        atr: s.atr,
      }));
      await supabase.from("backtest_signals").insert(batch);
    }
  }

  console.log("[backtest] Complete:", JSON.stringify(summary));
  return NextResponse.json(summary);
}

function round(n: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}
