/**
 * Build BTC regime history: fetches daily candles from Bybit, computes
 * EMA200 + ADX(14), classifies regime, and upserts to Supabase.
 *
 * Usage: npx tsx scripts/build-regime-history.ts
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
  console.error("[regime-history] Missing SUPABASE_URL or SUPABASE_ANON_KEY");
  process.exit(1);
}

const SB_HEADERS = {
  "Content-Type": "application/json",
  apikey: SUPABASE_ANON_KEY,
  Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
};

// ── Types ──────────────────────────────────────────────────

interface Candle {
  startTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  turnover: number;
}

interface RegimeRow {
  date: string;
  close: number;
  ema200: number;
  adx14: number;
  regime: string;
  distance_to_ema200_pct: number;
  transition_zone: boolean;
  regime_age_days: number;
}

// ── Step 1: Fetch daily candles from Bybit ─────────────────

async function fetchAllDailyCandles(): Promise<Candle[]> {
  const BYBIT_URL = "https://api.bybit.com/v5/market/kline";
  const LIMIT = 200;
  const TARGET = 1000; // ~930 needed (730 days + 200 warmup)
  const seen = new Map<number, Candle>();

  let end: number | undefined;

  while (seen.size < TARGET) {
    let url = `${BYBIT_URL}?category=linear&symbol=BTCUSDT&interval=D&limit=${LIMIT}`;
    if (end) url += `&end=${end}`;

    const res = await fetch(url);
    const json = await res.json();
    const list: string[][] = json?.result?.list ?? [];

    if (list.length === 0) break;

    for (const row of list) {
      const startTime = Number(row[0]);
      if (!seen.has(startTime)) {
        seen.set(startTime, {
          startTime,
          open: Number(row[1]),
          high: Number(row[2]),
          low: Number(row[3]),
          close: Number(row[4]),
          volume: Number(row[5]),
          turnover: Number(row[6]),
        });
      }
    }

    // Paginate backwards: set end to oldest candle's startTime
    const oldest = Math.min(...list.map((r) => Number(r[0])));
    end = oldest;

    // Rate limit
    await new Promise((r) => setTimeout(r, 200));
  }

  // Sort chronologically ascending
  const candles = Array.from(seen.values()).sort((a, b) => a.startTime - b.startTime);
  const firstDate = new Date(candles[0].startTime).toISOString().slice(0, 10);
  const lastDate = new Date(candles[candles.length - 1].startTime)
    .toISOString()
    .slice(0, 10);
  console.log(
    `[regime-history] Fetched ${candles.length} candles (${firstDate} → ${lastDate})`
  );
  return candles;
}

// ── Step 2: Upsert candles to candle_cache ─────────────────

async function upsertCandleCache(candles: Candle[]): Promise<void> {
  const url = `${SUPABASE_URL}/rest/v1/candle_cache?on_conflict=symbol,interval,start_time`;
  const BATCH = 500;

  for (let i = 0; i < candles.length; i += BATCH) {
    const batch = candles.slice(i, i + BATCH).map((c) => ({
      symbol: "BTCUSDT",
      interval: "D",
      start_time: new Date(c.startTime).toISOString(),
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volume: c.volume,
    }));

    const res = await fetch(url, {
      method: "POST",
      headers: { ...SB_HEADERS, Prefer: "resolution=merge-duplicates" },
      body: JSON.stringify(batch),
    });

    if (!res.ok) {
      const text = await res.text();
      console.error(`[regime-history] candle_cache upsert error: ${text}`);
    }
  }

  console.log(
    `[regime-history] Upserted ${candles.length} candles to candle_cache`
  );
}

// ── Step 3: Compute EMA200 + ADX(14) series ────────────────

function emaSeries(closes: number[], period: number): number[] {
  const k = 2 / (period + 1);
  const result: number[] = [];

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

function adxSeries(
  candles: { high: number; low: number; close: number }[],
  period: number
): number[] {
  const result: number[] = new Array(candles.length).fill(NaN);
  if (candles.length < period * 2 + 1) return result;

  // Compute +DM, -DM, TR (length = candles.length - 1, offset by 1)
  const pDM: number[] = [];
  const mDM: number[] = [];
  const tr: number[] = [];

  for (let i = 1; i < candles.length; i++) {
    const highDiff = candles[i].high - candles[i - 1].high;
    const lowDiff = candles[i - 1].low - candles[i].low;
    pDM.push(highDiff > lowDiff && highDiff > 0 ? highDiff : 0);
    mDM.push(lowDiff > highDiff && lowDiff > 0 ? lowDiff : 0);
    tr.push(
      Math.max(
        candles[i].high - candles[i].low,
        Math.abs(candles[i].high - candles[i - 1].close),
        Math.abs(candles[i].low - candles[i - 1].close)
      )
    );
  }

  // Wilder's smoothing
  function smooth(values: number[], p: number): number[] {
    const out: number[] = [];
    let sum = 0;
    for (let i = 0; i < p && i < values.length; i++) sum += values[i];
    out[p - 1] = sum;
    for (let i = p; i < values.length; i++) {
      out[i] = out[i - 1] - out[i - 1] / p + values[i];
    }
    return out;
  }

  const smoothTR = smooth(tr, period);
  const smoothPDM = smooth(pDM, period);
  const smoothMDM = smooth(mDM, period);

  // DX series (indices relative to pDM/mDM/tr arrays, i.e., offset by 1 from candles)
  const dx: { idx: number; val: number }[] = [];
  for (let i = period - 1; i < smoothTR.length; i++) {
    if (!smoothTR[i]) continue;
    const pdi = (smoothPDM[i] / smoothTR[i]) * 100;
    const mdi = (smoothMDM[i] / smoothTR[i]) * 100;
    const sum = pdi + mdi;
    const dxVal = sum === 0 ? 0 : (Math.abs(pdi - mdi) / sum) * 100;
    dx.push({ idx: i + 1, val: dxVal }); // +1 to map back to candle index
  }

  if (dx.length < period) return result;

  // ADX = running Wilder's smoothing of DX
  let adxVal = 0;
  for (let i = 0; i < period; i++) adxVal += dx[i].val;
  adxVal /= period;
  result[dx[period - 1].idx] = adxVal;

  for (let i = period; i < dx.length; i++) {
    adxVal = (adxVal * (period - 1) + dx[i].val) / period;
    result[dx[i].idx] = adxVal;
  }

  return result;
}

// ── Step 4-6: Classify regimes ─────────────────────────────

function classifyRegimes(candles: Candle[]): RegimeRow[] {
  const closes = candles.map((c) => c.close);
  const ema200 = emaSeries(closes, 200);
  const adx14 = adxSeries(candles, 14);

  const rows: RegimeRow[] = [];
  let prevRegime = "";
  let age = 0;

  for (let i = 0; i < candles.length; i++) {
    const e = ema200[i];
    const a = adx14[i];
    if (e === undefined || isNaN(e)) continue;
    if (a === undefined || isNaN(a)) continue;

    const close = candles[i].close;
    const distPct = (close - e) / e;
    const transitionZone = Math.abs(distPct) <= 0.02;
    const regime = close < e ? "bear" : a > 20 ? "bull" : "sideways";

    if (regime === prevRegime) {
      age++;
    } else {
      age = 1;
      prevRegime = regime;
    }

    const dateStr = new Date(candles[i].startTime).toISOString().slice(0, 10);
    rows.push({
      date: dateStr,
      close,
      ema200: Math.round(e * 100) / 100,
      adx14: Math.round(a * 100) / 100,
      regime,
      distance_to_ema200_pct: Math.round(distPct * 10000) / 10000,
      transition_zone: transitionZone,
      regime_age_days: age,
    });
  }

  console.log(`[regime-history] Classified regimes for ${rows.length} days`);
  return rows;
}

// ── Step 5: Upsert regime history ──────────────────────────

async function upsertRegimeHistory(rows: RegimeRow[]): Promise<void> {
  const url = `${SUPABASE_URL}/rest/v1/btc_regime_history?on_conflict=date`;
  const BATCH = 500;

  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    const res = await fetch(url, {
      method: "POST",
      headers: { ...SB_HEADERS, Prefer: "resolution=merge-duplicates" },
      body: JSON.stringify(batch),
    });

    if (!res.ok) {
      const text = await res.text();
      console.error(`[regime-history] btc_regime_history upsert error: ${text}`);
    }
  }

  console.log(
    `[regime-history] Upserted ${rows.length} regime records to btc_regime_history`
  );
}

// ── Step 6: Update backtest_signals.regime_production ──────

async function updateBacktestSignals(rows: RegimeRow[]): Promise<void> {
  // Build date→regime map
  const regimeMap = new Map<string, string>();
  for (const r of rows) regimeMap.set(r.date, r.regime);

  // Fetch all backtest_signals with pagination
  const PAGE = 1000;
  let offset = 0;
  let totalUpdated = 0;
  const signalsByRegime = new Map<string, string[]>(); // regime → ids[]

  while (true) {
    const url = `${SUPABASE_URL}/rest/v1/backtest_signals?select=id,candle_time&limit=${PAGE}&offset=${offset}`;
    const res = await fetch(url, { headers: SB_HEADERS });

    if (!res.ok) {
      const text = await res.text();
      console.error(`[regime-history] backtest_signals fetch error: ${text}`);
      break;
    }

    const signals: { id: string; candle_time: string }[] = await res.json();
    if (signals.length === 0) break;

    for (const s of signals) {
      const date = s.candle_time?.slice(0, 10);
      const regime = date ? regimeMap.get(date) : undefined;
      if (regime) {
        if (!signalsByRegime.has(regime)) signalsByRegime.set(regime, []);
        signalsByRegime.get(regime)!.push(s.id);
      }
    }

    offset += signals.length;
    if (signals.length < PAGE) break;
  }

  // Batch update per regime value
  for (const [regime, ids] of Array.from(signalsByRegime.entries())) {
    const BATCH = 200;
    for (let i = 0; i < ids.length; i += BATCH) {
      const chunk = ids.slice(i, i + BATCH);
      const url = `${SUPABASE_URL}/rest/v1/backtest_signals?id=in.(${chunk.join(",")})`;
      const res = await fetch(url, {
        method: "PATCH",
        headers: { ...SB_HEADERS, Prefer: "return=minimal" },
        body: JSON.stringify({ regime_production: regime }),
      });

      if (!res.ok) {
        const text = await res.text();
        console.error(
          `[regime-history] backtest_signals PATCH error: ${text}`
        );
      }
      totalUpdated += chunk.length;
    }
  }

  console.log(
    `[regime-history] Updated ${totalUpdated} signals with production regime`
  );
}

// ── Main ───────────────────────────────────────────────────

async function main() {
  const t0 = Date.now();
  console.log("[regime-history] Fetching daily candles from Bybit...");

  const candles = await fetchAllDailyCandles();

  console.log("[regime-history] Upserting candles to candle_cache...");
  await upsertCandleCache(candles);

  console.log("[regime-history] Computing EMA200 + ADX(14)...");
  const regimeRows = classifyRegimes(candles);

  await upsertRegimeHistory(regimeRows);

  console.log("[regime-history] Updating backtest_signals.regime_production...");
  await updateBacktestSignals(regimeRows);

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`[regime-history] Done in ${elapsed}s`);
}

main().catch((err) => {
  console.error("[regime-history] Fatal:", err);
  process.exit(1);
});
