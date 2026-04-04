/**
 * Extended backtest: re-runs BB squeeze SQ_SHORT detection against all
 * historical 1H klines stored in candle_cache. Grades each signal and
 * writes results to backtest_signals.
 *
 * Usage: npx tsx scripts/run-extended-backtest.ts
 */

import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";

// ── Load .env.local ────────────────────────────────────────
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const envPath = resolve(__dirname, "../.env.local");
try {
  const lines = readFileSync(envPath, "utf8").split("\n");
  for (const line of lines) {
    const match = line.match(/^([^#=]+)=(.*)$/);
    if (match) process.env[match[1].trim()] ??= match[2].trim();
  }
} catch {}

const SUPABASE_URL =
  process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "";
const SUPABASE_ANON_KEY =
  process.env.SUPABASE_ANON_KEY ||
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
  "";

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error("[extended-backtest] Missing SUPABASE_URL or SUPABASE_ANON_KEY");
  process.exit(1);
}

const SB_HEADERS = {
  "Content-Type": "application/json",
  apikey: SUPABASE_ANON_KEY,
  Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
};

// ── Constants ──────────────────────────────────────────────

const RUN_GROUP_ID = "extended_2yr_v1";
const BB_PERIOD = 20;
const BB_STDEV = 2.0;
const BB_WIDTH_THRESHOLD = 0.04;
const ATR_PERIOD = 14;
const COOLDOWN_HOURS = 8; // 8 candles at 1H
const FORWARD_BARS = 48;
const LOG_PREFIX = "[extended-backtest]";

// Scoring weights (mirrors scoring.ts)
const W_ATR = 0.35;
const W_VOL = 0.35;
const W_TIER = 0.20;
const W_DEV = 0.10;

// ── Types ──────────────────────────────────────────────────

interface Candle {
  start_time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

// ── Helpers ────────────────────────────────────────────────

function clamp(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, val));
}

// ── Supabase data fetching ─────────────────────────────────

async function fetchSymbols(): Promise<string[]> {
  const url = `${SUPABASE_URL}/rest/v1/candle_cache?interval=eq.60&select=symbol`;
  const res = await fetch(url, {
    headers: { ...SB_HEADERS, Prefer: "return=representation" },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`fetchSymbols error: ${text}`);
  }
  const rows: { symbol: string }[] = await res.json();
  return Array.from(new Set(rows.map((r) => r.symbol)));
}

async function fetchCandles(symbol: string): Promise<Candle[]> {
  const all: Candle[] = [];
  let offset = 0;
  const LIMIT = 1000;

  while (true) {
    const url = `${SUPABASE_URL}/rest/v1/candle_cache?symbol=eq.${symbol}&interval=eq.60&select=start_time,open,high,low,close,volume&order=start_time.asc&limit=${LIMIT}&offset=${offset}`;
    const res = await fetch(url, { headers: SB_HEADERS });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`fetchCandles(${symbol}) error: ${text}`);
    }
    const rows: Record<string, unknown>[] = await res.json();
    if (rows.length === 0) break;

    for (const r of rows) {
      all.push({
        start_time: String(r.start_time),
        open: Number(r.open),
        high: Number(r.high),
        low: Number(r.low),
        close: Number(r.close),
        volume: Number(r.volume),
      });
    }

    offset += rows.length;
    if (rows.length < LIMIT) break;
  }

  return all;
}

async function fetchRegimeMap(): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  let offset = 0;
  const LIMIT = 1000;

  while (true) {
    const url = `${SUPABASE_URL}/rest/v1/btc_regime_history?select=date,regime&order=date.asc&limit=${LIMIT}&offset=${offset}`;
    const res = await fetch(url, { headers: SB_HEADERS });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`fetchRegimeMap error: ${text}`);
    }
    const rows: { date: string; regime: string }[] = await res.json();
    if (rows.length === 0) break;

    for (const r of rows) {
      map.set(r.date, r.regime);
    }

    offset += rows.length;
    if (rows.length < LIMIT) break;
  }

  console.log(`${LOG_PREFIX} Loaded ${map.size} regime entries`);
  return map;
}

// ── Indicators ─────────────────────────────────────────────

function sma(values: number[], period: number): (number | null)[] {
  const result: (number | null)[] = new Array(values.length).fill(null);
  for (let i = period - 1; i < values.length; i++) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += values[j];
    result[i] = sum / period;
  }
  return result;
}

function atrSeries(candles: Candle[], period: number): (number | null)[] {
  const result: (number | null)[] = new Array(candles.length).fill(null);
  if (candles.length < 2) return result;

  // Compute True Range for i >= 1
  const tr: number[] = [0]; // placeholder for index 0
  for (let i = 1; i < candles.length; i++) {
    const high = candles[i].high;
    const low = candles[i].low;
    const prevClose = candles[i - 1].close;
    tr.push(
      Math.max(
        high - low,
        Math.abs(high - prevClose),
        Math.abs(low - prevClose)
      )
    );
  }

  // Wilder's smoothing: first ATR = simple average of first `period` TRs (indices 1..period)
  if (candles.length < period + 1) return result;

  let atr = 0;
  for (let i = 1; i <= period; i++) atr += tr[i];
  atr /= period;
  result[period] = atr;

  for (let i = period + 1; i < candles.length; i++) {
    atr = (atr * (period - 1) + tr[i]) / period;
    result[i] = atr;
  }

  return result;
}

// ── Scoring (inline replica of scoring.ts) ─────────────────

function computeCompositeScore(
  atr: number,
  entry: number,
  volRatio: number
): number {
  // ATR% component: lower ATR% = higher score
  const atrPct = atr / entry;
  const atrClamped = clamp(atrPct, 0.001, 0.04);
  const atrComponent = (1 - (atrClamped - 0.001) / (0.04 - 0.001)) * 100;

  // Vol component: clamp to [0, 5], map to [0, 100]
  const volComponent = (clamp(volRatio, 0, 5) / 5) * 100;

  // Tier component: all signals are STRICT SQ_SHORT → 100
  const tierComponent = 100;

  // Deviation penalty: always 0
  const deviationPenalty = 0;

  // Weighted sum with redistribution for missing components
  // All components available here, so totalWeight = W_ATR + W_VOL + W_TIER
  const totalWeight = W_ATR + W_VOL + W_TIER;
  const weightedSum =
    atrComponent * W_ATR +
    volComponent * W_VOL +
    tierComponent * W_TIER -
    deviationPenalty * W_DEV;

  const finalScore = totalWeight > 0 ? clamp(weightedSum / totalWeight, 0, 100) : 0;
  return Math.round(finalScore * 100) / 100;
}

// ── Signal processing per symbol ───────────────────────────

interface SignalRow {
  backtest_run_id: string;
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
  regime_production: string;
  composite_score: number;
  vol_ratio: number;
}

function processSymbol(
  symbol: string,
  candles: Candle[],
  regimeMap: Map<string, string>
): { signals: number; tp1Count: number; totalR: number; rows: SignalRow[] } {
  const atr14 = atrSeries(candles, ATR_PERIOD);
  const smaVolumes = sma(
    candles.map((c) => c.volume),
    BB_PERIOD
  );

  const rows: SignalRow[] = [];
  let lastSignalIndex = -COOLDOWN_HOURS; // allow first signal
  let prevBbWidth: number | null = null;

  for (let i = BB_PERIOD - 1; i < candles.length; i++) {
    // BB computation
    const closes = candles.slice(i - BB_PERIOD + 1, i + 1).map((c) => c.close);
    const sma20 = closes.reduce((a, b) => a + b, 0) / BB_PERIOD;
    const stddev = Math.sqrt(
      closes.reduce((s, v) => s + (v - sma20) ** 2, 0) / BB_PERIOD
    );
    const upper = sma20 + BB_STDEV * stddev;
    const lower = sma20 - BB_STDEV * stddev;
    const bbWidth = (upper - lower) / sma20;

    // Volume ratio
    const smaVol = smaVolumes[i];
    const volRatio =
      smaVol != null && smaVol > 0 ? candles[i].volume / smaVol : 0;

    // SQ_SHORT detection: prev was in squeeze, now expanding downside
    if (
      prevBbWidth != null &&
      prevBbWidth <= BB_WIDTH_THRESHOLD &&
      bbWidth > BB_WIDTH_THRESHOLD &&
      candles[i].close < lower
    ) {
      // Cooldown check
      if (i - lastSignalIndex < COOLDOWN_HOURS) {
        prevBbWidth = bbWidth;
        continue;
      }

      // Need ATR for this candle
      const atrVal = atr14[i];
      if (atrVal == null) {
        prevBbWidth = bbWidth;
        continue;
      }

      lastSignalIndex = i;

      // Entry, stop, TP levels
      const entry = candles[i].close;
      const recentHighs = candles
        .slice(Math.max(0, i - 4), i + 1)
        .map((c) => c.high);
      const stop = Math.max(...recentHighs) + atrVal * 0.5;
      const R = stop - entry; // positive because stop > entry for short
      const tp1 = entry - 1.0 * R;
      const tp2 = entry - 2.0 * R;
      const tp3 = entry - 3.5 * R;

      // Grading
      let hitTp1 = false,
        hitTp2 = false,
        hitTp3 = false,
        hitSl = false;
      let maxFavorable = 0; // max drop from entry, in R
      let maxAdverse = 0; // max rise from entry, in R
      let barsToResolution = Math.min(
        FORWARD_BARS,
        candles.length - i - 1
      );

      for (
        let j = i + 1;
        j < Math.min(i + 1 + FORWARD_BARS, candles.length);
        j++
      ) {
        const bar = candles[j];
        const favorable = (entry - bar.low) / R;
        const adverse = (bar.high - entry) / R;
        if (favorable > maxFavorable) maxFavorable = favorable;
        if (adverse > maxAdverse) maxAdverse = adverse;

        if (!hitSl && bar.high >= stop) {
          hitSl = true;
          if (!hitTp1) {
            barsToResolution = j - i;
            break;
          }
        }
        if (!hitTp1 && bar.low <= tp1) hitTp1 = true;
        if (!hitTp2 && bar.low <= tp2) hitTp2 = true;
        if (!hitTp3 && bar.low <= tp3) {
          hitTp3 = true;
          barsToResolution = j - i;
          break;
        }
      }

      // Regime lookup
      const dateStr = candles[i].start_time.slice(0, 10);
      const regimeProduction = regimeMap.get(dateStr) ?? "unknown";

      // Composite score
      const compositeScore = computeCompositeScore(atrVal, entry, volRatio);

      rows.push({
        backtest_run_id: RUN_GROUP_ID,
        symbol,
        setup_type: "SQ_SHORT",
        candle_time: candles[i].start_time,
        entry_price: entry,
        stop_loss: stop,
        tp1,
        tp2,
        tp3,
        hit_tp1: hitTp1,
        hit_tp2: hitTp2,
        hit_tp3: hitTp3,
        hit_sl: hitSl,
        bars_to_resolution: barsToResolution,
        max_favorable: Math.round(maxFavorable * 1000) / 1000,
        max_adverse: Math.round(maxAdverse * 1000) / 1000,
        regime: "N/A",
        atr: atrVal,
        regime_production: regimeProduction,
        composite_score: compositeScore,
        vol_ratio: Math.round(volRatio * 100) / 100,
      });
    }

    prevBbWidth = bbWidth;
  }

  const tp1Count = rows.filter((r) => r.hit_tp1).length;
  const totalR = rows.reduce((sum, r) => {
    if (r.hit_tp3) return sum + 3.5;
    if (r.hit_tp2) return sum + 2.0;
    if (r.hit_tp1) return sum + 1.0;
    if (r.hit_sl) return sum - 1.0;
    return sum;
  }, 0);

  return { signals: rows.length, tp1Count, totalR, rows };
}

// ── Delete + Insert ────────────────────────────────────────

async function deleteOldRun(): Promise<void> {
  const url = `${SUPABASE_URL}/rest/v1/backtest_signals?backtest_run_id=eq.${RUN_GROUP_ID}`;
  const res = await fetch(url, {
    method: "DELETE",
    headers: { ...SB_HEADERS, Prefer: "return=minimal" },
  });
  if (!res.ok) {
    const text = await res.text();
    console.error(`${LOG_PREFIX} DELETE old run error: ${text}`);
  } else {
    console.log(`${LOG_PREFIX} Deleted old run group '${RUN_GROUP_ID}'`);
  }
}

async function insertSignals(rows: SignalRow[]): Promise<void> {
  const url = `${SUPABASE_URL}/rest/v1/backtest_signals`;
  const BATCH = 500;

  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    const res = await fetch(url, {
      method: "POST",
      headers: { ...SB_HEADERS, Prefer: "return=minimal" },
      body: JSON.stringify(batch),
    });

    if (!res.ok) {
      const text = await res.text();
      console.error(
        `${LOG_PREFIX} INSERT batch ${i / BATCH + 1} error: ${text}`
      );
    }
  }

  console.log(`${LOG_PREFIX} Inserted ${rows.length} signals`);
}

// ── Main ───────────────────────────────────────────────────

async function main() {
  const t0 = Date.now();

  // 1. Fetch regime map
  const regimeMap = await fetchRegimeMap();

  // 2. Get distinct symbols
  const symbols = await fetchSymbols();
  console.log(`${LOG_PREFIX} ${symbols.length} symbols found in candle_cache`);

  // 3. Delete old run group
  await deleteOldRun();

  // 4. Process each symbol sequentially
  let totalSignals = 0;
  let totalTp1 = 0;
  let totalR = 0;
  const allRows: SignalRow[] = [];

  for (const symbol of symbols) {
    const candles = await fetchCandles(symbol);
    if (candles.length < BB_PERIOD + FORWARD_BARS) {
      console.log(
        `${LOG_PREFIX} ${symbol}: skipped (${candles.length} candles)`
      );
      continue;
    }

    const result = processSymbol(symbol, candles, regimeMap);
    totalSignals += result.signals;
    totalTp1 += result.tp1Count;
    totalR += result.totalR;
    allRows.push(...result.rows);

    if (result.signals > 0) {
      const wr = ((result.tp1Count / result.signals) * 100).toFixed(1);
      const avgR = (result.totalR / result.signals).toFixed(2);
      console.log(
        `${LOG_PREFIX} ${symbol}: ${candles.length} candles, ${result.signals} signals, WR=${wr}%, avgR=${avgR}`
      );
    } else {
      console.log(
        `${LOG_PREFIX} ${symbol}: ${candles.length} candles, 0 signals`
      );
    }
  }

  // 5. Batch insert
  if (allRows.length > 0) {
    await insertSignals(allRows);
  }

  // 6. Summary
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  const wr = totalSignals > 0 ? ((totalTp1 / totalSignals) * 100).toFixed(1) : "0.0";
  const avgR = totalSignals > 0 ? (totalR / totalSignals).toFixed(2) : "0.00";
  console.log(
    `${LOG_PREFIX} Done. ${totalSignals} signals across ${symbols.length} symbols, WR=${wr}%, avgR=${avgR}, ${elapsed}s`
  );
}

main().catch((err) => {
  console.error(`${LOG_PREFIX} Fatal:`, err);
  process.exit(1);
});
