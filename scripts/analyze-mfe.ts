/**
 * MFE (Maximum Favorable Excursion) analysis for backtest signals.
 * Fetches 15-min klines from candle_cache, computes MFE/MAE at multiple
 * time horizons, and simulates 4 exit strategies.
 *
 * Usage: npx tsx scripts/analyze-mfe.ts
 */

import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";

// ── Load .env ──────────────────────────────────────────────
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const envPath = resolve(__dirname, "../.env");
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
  console.error("[analyze-mfe] Missing SUPABASE_URL or SUPABASE_ANON_KEY");
  process.exit(1);
}

const SB_HEADERS = {
  "Content-Type": "application/json",
  apikey: SUPABASE_ANON_KEY,
  Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
};

const LOG_PREFIX = "[analyze-mfe]";

// ── Types ─────────────────────────────────────────────────

interface BacktestSignal {
  id: string;
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
  max_favorable: number;
  max_adverse: number;
  regime_production: string;
  backtest_run_id: string;
}

interface Candle {
  start_time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

const HORIZONS = [
  { label: "15m", bars: 1 },
  { label: "30m", bars: 2 },
  { label: "1h", bars: 4 },
  { label: "2h", bars: 8 },
  { label: "4h", bars: 16 },
] as const;

interface MfeResult {
  signal_id: string;
  symbol: string;
  candle_time: string;
  entry_price: number;
  stop_loss: number;
  risk_per_unit: number;
  regime_production: string;
  // Prices at intervals
  price_15m: number | null;
  price_30m: number | null;
  price_1h: number | null;
  price_2h: number | null;
  price_4h: number | null;
  // MFE/MAE at intervals (in R)
  mfe_15m: number | null; mae_15m: number | null;
  mfe_30m: number | null; mae_30m: number | null;
  mfe_1h: number | null;  mae_1h: number | null;
  mfe_2h: number | null;  mae_2h: number | null;
  mfe_4h: number | null;  mae_4h: number | null;
  // Time to R thresholds
  time_to_03r_min: number | null;
  time_to_05r_min: number | null;
  time_to_07r_min: number | null;
  time_to_1r_min: number | null;
  // Strategy R outcomes
  strategy_a_r: number;
  strategy_b_r: number;
  strategy_c_r: number;
  strategy_d_r: number;
}

// ── Data Fetching ─────────────────────────────────────────

async function fetchSignals(): Promise<BacktestSignal[]> {
  const all: BacktestSignal[] = [];
  let offset = 0;
  const LIMIT = 1000;

  while (true) {
    const url = `${SUPABASE_URL}/rest/v1/backtest_signals?select=id,symbol,setup_type,candle_time,entry_price,stop_loss,tp1,tp2,tp3,hit_tp1,hit_tp2,hit_tp3,hit_sl,max_favorable,max_adverse,regime_production,backtest_run_id&order=candle_time.asc&limit=${LIMIT}&offset=${offset}&hit_tp1=not.is.null`;
    const res = await fetch(url, { headers: SB_HEADERS });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`fetchSignals error: ${text}`);
    }
    const rows: Record<string, unknown>[] = await res.json();
    if (rows.length === 0) break;

    for (const r of rows) {
      all.push({
        id: String(r.id),
        symbol: String(r.symbol),
        setup_type: String(r.setup_type),
        candle_time: String(r.candle_time),
        entry_price: Number(r.entry_price),
        stop_loss: Number(r.stop_loss),
        tp1: Number(r.tp1),
        tp2: Number(r.tp2),
        tp3: Number(r.tp3),
        hit_tp1: Boolean(r.hit_tp1),
        hit_tp2: Boolean(r.hit_tp2),
        hit_tp3: Boolean(r.hit_tp3),
        hit_sl: Boolean(r.hit_sl),
        max_favorable: Number(r.max_favorable),
        max_adverse: Number(r.max_adverse),
        regime_production: String(r.regime_production ?? "unknown"),
        backtest_run_id: String(r.backtest_run_id),
      });
    }

    offset += rows.length;
    if (rows.length < LIMIT) break;
  }

  return all;
}

async function fetchAll15mCandles(
  symbol: string,
  fromISO: string,
  toISO: string
): Promise<Candle[]> {
  const all: Candle[] = [];
  let offset = 0;
  const LIMIT = 1000;

  while (true) {
    const url = `${SUPABASE_URL}/rest/v1/candle_cache?symbol=eq.${symbol}&interval=eq.15&start_time=gte.${fromISO}&start_time=lt.${toISO}&select=start_time,open,high,low,close,volume&order=start_time.asc&limit=${LIMIT}&offset=${offset}`;
    const res = await fetch(url, { headers: SB_HEADERS });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`fetchAll15mCandles(${symbol}) error: ${text}`);
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

// ── MFE/MAE Computation ──────────────────────────────────

function computeMfeAtHorizons(
  entry: number,
  riskPerUnit: number,
  candles: Candle[]
): { mfe: (number | null)[]; mae: (number | null)[]; prices: (number | null)[] } {
  const mfe: (number | null)[] = [];
  const mae: (number | null)[] = [];
  const prices: (number | null)[] = [];

  for (const h of HORIZONS) {
    if (candles.length < h.bars) {
      mfe.push(null);
      mae.push(null);
      prices.push(null);
      continue;
    }
    let maxFav = 0;
    let maxAdv = 0;
    for (let j = 0; j < h.bars; j++) {
      const fav = (entry - candles[j].low) / riskPerUnit;
      const adv = (candles[j].high - entry) / riskPerUnit;
      if (fav > maxFav) maxFav = fav;
      if (adv > maxAdv) maxAdv = adv;
    }
    mfe.push(Math.round(maxFav * 1000) / 1000);
    mae.push(Math.round(maxAdv * 1000) / 1000);
    prices.push(candles[h.bars - 1].close);
  }

  return { mfe, mae, prices };
}

const R_THRESHOLDS = [0.3, 0.5, 0.7, 1.0] as const;

function computeTimeToR(
  entry: number,
  riskPerUnit: number,
  entryTimeMs: number,
  candles: Candle[]
): (number | null)[] {
  const results: (number | null)[] = new Array(R_THRESHOLDS.length).fill(null);
  let found = 0;

  for (const bar of candles) {
    const fav = (entry - bar.low) / riskPerUnit; // short: entry - low
    const barTimeMs = new Date(bar.start_time).getTime();
    const elapsedMin = (barTimeMs - entryTimeMs) / 60_000 + 15; // end of bar

    for (let t = 0; t < R_THRESHOLDS.length; t++) {
      if (results[t] === null && fav >= R_THRESHOLDS[t]) {
        results[t] = elapsedMin;
        found++;
      }
    }
    if (found === R_THRESHOLDS.length) break;
  }

  return results;
}

// ── Exit Strategy Simulation ─────────────────────────────

function strategyAFromFlags(sig: BacktestSignal): number {
  if (sig.hit_tp1 && sig.hit_tp2 && sig.hit_tp3) return 2.38;
  if (sig.hit_tp1 && sig.hit_tp2) return 1.17;
  if (sig.hit_tp1) return 0.5;
  if (sig.hit_sl && !sig.hit_tp1) return -1.0;
  return 0;
}

interface TpLevel {
  pct: number;
  targetR: number;
}

function simLadder(
  entry: number,
  stop: number,
  R: number,
  candles: Candle[],
  levels: TpLevel[]
): number {
  let realizedR = 0;
  let remainingPct = 1.0;
  let currentStop = stop;
  let firstTpHit = false;
  const filled = new Array(levels.length).fill(false);

  for (const bar of candles) {
    // Check SL first (conservative: if both SL and TP hit same bar, SL wins)
    if (bar.high >= currentStop) {
      const slR = firstTpHit ? 0 : -1;
      realizedR += remainingPct * slR;
      remainingPct = 0;
      break;
    }

    // Check each unfilled TP level
    for (let k = 0; k < levels.length; k++) {
      if (filled[k]) continue;
      const tpPrice = entry - levels[k].targetR * R;
      if (bar.low <= tpPrice) {
        filled[k] = true;
        realizedR += levels[k].pct * levels[k].targetR;
        remainingPct -= levels[k].pct;
        if (!firstTpHit) {
          firstTpHit = true;
          currentStop = entry; // move to breakeven
        }
      }
    }

    if (remainingPct <= 0.001) break;
  }

  // Mark-to-market residual at last close
  if (remainingPct > 0.001 && candles.length > 0) {
    const lastClose = candles[candles.length - 1].close;
    const unrealizedR = (entry - lastClose) / R;
    realizedR += remainingPct * unrealizedR;
  }

  return Math.round(realizedR * 1000) / 1000;
}

function simulateStrategiesBCD(
  entry: number,
  stop: number,
  riskPerUnit: number,
  candles: Candle[]
): { b: number; c: number; d: number } {
  return {
    b: simLadder(entry, stop, riskPerUnit, candles, [
      { pct: 0.50, targetR: 1.0 },
      { pct: 0.25, targetR: 2.0 },
      { pct: 0.25, targetR: 3.5 },
    ]),
    c: simLadder(entry, stop, riskPerUnit, candles, [
      { pct: 1.0, targetR: 0.5 },
    ]),
    d: simLadder(entry, stop, riskPerUnit, candles, [
      { pct: 0.50, targetR: 0.5 },
      { pct: 0.165, targetR: 1.0 },
      { pct: 0.165, targetR: 2.0 },
      { pct: 0.17, targetR: 3.5 },
    ]),
  };
}

// ── Aggregation & Stats ──────────────────────────────────

interface StrategyStats {
  name: string;
  regime: string;
  trades: number;
  wins: number;
  winRate: string;
  avgR: string;
  profitFactor: string;
  maxConsecLosses: number;
}

function computeStats(
  name: string,
  regime: string,
  rValues: number[]
): StrategyStats {
  const trades = rValues.length;
  const wins = rValues.filter((r) => r > 0).length;
  const winRate = trades > 0 ? ((wins / trades) * 100).toFixed(1) : "0.0";
  const avgR =
    trades > 0
      ? (rValues.reduce((a, b) => a + b, 0) / trades).toFixed(3)
      : "0.000";

  const sumPos = rValues.filter((r) => r > 0).reduce((a, b) => a + b, 0);
  const sumNeg = Math.abs(
    rValues.filter((r) => r < 0).reduce((a, b) => a + b, 0)
  );
  const profitFactor =
    sumNeg > 0 ? (sumPos / sumNeg).toFixed(2) : sumPos > 0 ? "∞" : "0.00";

  let maxConsecLosses = 0;
  let streak = 0;
  for (const r of rValues) {
    if (r <= 0) {
      streak++;
      if (streak > maxConsecLosses) maxConsecLosses = streak;
    } else {
      streak = 0;
    }
  }

  return { name, regime, trades, wins, winRate, avgR, profitFactor, maxConsecLosses };
}

function printTable(stats: StrategyStats[]): void {
  const hdr = [
    "Strategy".padEnd(16),
    "Regime".padEnd(12),
    "Trades".padStart(7),
    "Win Rate".padStart(9),
    "Avg R".padStart(8),
    "PF".padStart(8),
    "Max CL".padStart(8),
  ].join(" │ ");

  const sep = hdr.replace(/[^│]/g, "─").replace(/│/g, "┼");
  console.log(`┌${sep.replace(/┼/g, "┬").replace(/^./, "").replace(/.$/, "")}┐`);
  console.log(`│ ${hdr} │`);
  console.log(`├${sep}┤`);

  for (const s of stats) {
    const row = [
      s.name.padEnd(16),
      s.regime.padEnd(12),
      String(s.trades).padStart(7),
      (s.winRate + "%").padStart(9),
      s.avgR.padStart(8),
      s.profitFactor.padStart(8),
      String(s.maxConsecLosses).padStart(8),
    ].join(" │ ");
    console.log(`│ ${row} │`);
  }

  const bot = sep.replace(/┼/g, "┴").replace(/^./, "").replace(/.$/, "");
  console.log(`└${bot}┘`);
}

// ── CSV Output ───────────────────────────────────────────

function writeCsv(results: MfeResult[]): void {
  const outDir = resolve(__dirname, "output");
  mkdirSync(outDir, { recursive: true });

  const headers = [
    "signal_id", "symbol", "candle_time", "entry_price", "stop_loss",
    "risk_per_unit", "regime_production",
    "price_15m", "price_30m", "price_1h", "price_2h", "price_4h",
    "mfe_15m", "mae_15m", "mfe_30m", "mae_30m",
    "mfe_1h", "mae_1h", "mfe_2h", "mae_2h",
    "mfe_4h", "mae_4h",
    "time_to_03r_min", "time_to_05r_min", "time_to_07r_min", "time_to_1r_min",
    "strategy_a_r", "strategy_b_r", "strategy_c_r", "strategy_d_r",
  ];

  const lines = [headers.join(",")];
  for (const r of results) {
    lines.push([
      r.signal_id, r.symbol, r.candle_time, r.entry_price, r.stop_loss,
      r.risk_per_unit, r.regime_production,
      r.price_15m ?? "", r.price_30m ?? "", r.price_1h ?? "", r.price_2h ?? "", r.price_4h ?? "",
      r.mfe_15m ?? "", r.mae_15m ?? "", r.mfe_30m ?? "", r.mae_30m ?? "",
      r.mfe_1h ?? "", r.mae_1h ?? "", r.mfe_2h ?? "", r.mae_2h ?? "",
      r.mfe_4h ?? "", r.mae_4h ?? "",
      r.time_to_03r_min ?? "", r.time_to_05r_min ?? "", r.time_to_07r_min ?? "", r.time_to_1r_min ?? "",
      r.strategy_a_r, r.strategy_b_r, r.strategy_c_r, r.strategy_d_r,
    ].join(","));
  }

  const outPath = resolve(outDir, "mfe-analysis.csv");
  writeFileSync(outPath, lines.join("\n") + "\n", "utf8");
  console.log(`${LOG_PREFIX} CSV written to ${outPath}`);
}

// ── Upsert to Supabase ──────────────────────────────────

async function upsertMfe(results: MfeResult[]): Promise<void> {
  const url = `${SUPABASE_URL}/rest/v1/signal_mfe_analysis`;
  const BATCH = 200;

  for (let i = 0; i < results.length; i += BATCH) {
    const batch = results.slice(i, i + BATCH).map((r) => ({
      signal_id: r.signal_id,
      symbol: r.symbol,
      candle_time: r.candle_time,
      entry_price: r.entry_price,
      stop_loss: r.stop_loss,
      risk_per_unit: r.risk_per_unit,
      regime_production: r.regime_production,
      price_15m: r.price_15m,
      price_30m: r.price_30m,
      price_1h: r.price_1h,
      price_2h: r.price_2h,
      price_4h: r.price_4h,
      mfe_15m: r.mfe_15m,
      mae_15m: r.mae_15m,
      mfe_30m: r.mfe_30m,
      mae_30m: r.mae_30m,
      mfe_1h: r.mfe_1h,
      mae_1h: r.mae_1h,
      mfe_2h: r.mfe_2h,
      mae_2h: r.mae_2h,
      mfe_4h: r.mfe_4h,
      mae_4h: r.mae_4h,
      time_to_03r_min: r.time_to_03r_min,
      time_to_05r_min: r.time_to_05r_min,
      time_to_07r_min: r.time_to_07r_min,
      time_to_1r_min: r.time_to_1r_min,
      strategy_a_r: r.strategy_a_r,
      strategy_b_r: r.strategy_b_r,
      strategy_c_r: r.strategy_c_r,
      strategy_d_r: r.strategy_d_r,
    }));

    const res = await fetch(url, {
      method: "POST",
      headers: {
        ...SB_HEADERS,
        Prefer: "return=minimal,resolution=merge-duplicates",
      },
      body: JSON.stringify(batch),
    });

    if (!res.ok) {
      const text = await res.text();
      console.error(`${LOG_PREFIX} UPSERT batch ${Math.floor(i / BATCH) + 1} error: ${text}`);
    }
  }

  console.log(`${LOG_PREFIX} Upserted ${results.length} rows to signal_mfe_analysis`);
}

// ── Main ─────────────────────────────────────────────────

async function main() {
  const t0 = Date.now();

  // 1. Fetch all backtest signals with hit_tp1 IS NOT NULL
  const signals = await fetchSignals();
  console.log(
    `${LOG_PREFIX} Loaded ${signals.length} signals (hit_tp1 IS NOT NULL)`
  );

  if (signals.length === 0) {
    console.log(`${LOG_PREFIX} No signals found. Exiting.`);
    return;
  }

  // 2. Group signals by symbol
  const bySymbol = new Map<string, BacktestSignal[]>();
  for (const sig of signals) {
    const arr = bySymbol.get(sig.symbol) ?? [];
    arr.push(sig);
    bySymbol.set(sig.symbol, arr);
  }

  // 3. Process each symbol
  const results: MfeResult[] = [];
  let skipped = 0;
  let warned15m = false;

  for (const [symbol, syms] of Array.from(bySymbol.entries())) {
    console.log(`${LOG_PREFIX} ${symbol}: ${syms.length} signals`);

    // Find time range for this symbol's signals
    const times = syms.map((s) => new Date(s.candle_time).getTime());
    const minTime = Math.min(...times);
    const maxTime = Math.max(...times);
    // Fetch from 1h after earliest signal to 49h after latest signal
    const fromISO = new Date(minTime + 3600_000).toISOString();
    const toISO = new Date(maxTime + 49 * 3600_000).toISOString();

    const allCandles = await fetchAll15mCandles(symbol, fromISO, toISO);

    if (allCandles.length === 0) {
      if (!warned15m) {
        console.warn(
          `${LOG_PREFIX} ⚠ No 15m candles found for ${symbol}. Run: npx tsx scripts/fetch-historical-klines.ts --interval 15`
        );
        warned15m = true;
      }
      skipped += syms.length;
      continue;
    }

    for (const sig of syms) {
      const R = sig.stop_loss - sig.entry_price; // positive for short
      if (R <= 0) {
        skipped++;
        continue;
      }

      // Entry is at candle_time close = candle_time + 1h
      const entryTimeMs = new Date(sig.candle_time).getTime() + 3600_000;
      const entryISO = new Date(entryTimeMs).toISOString();
      const endISO = new Date(entryTimeMs + 48 * 3600_000).toISOString();

      // Slice relevant candles from pre-fetched array
      const candles = allCandles.filter(
        (c) => c.start_time >= entryISO && c.start_time < endISO
      );

      if (candles.length === 0) {
        skipped++;
        continue;
      }

      // MFE/MAE at horizons + prices
      const { mfe, mae, prices } = computeMfeAtHorizons(sig.entry_price, R, candles);

      // Time-to-R thresholds
      const timeToR = computeTimeToR(sig.entry_price, R, entryTimeMs, candles);

      // Strategy A from hit flags
      const stratA = strategyAFromFlags(sig);

      // Strategies B/C/D from 15-min bar simulation
      const stratBCD = simulateStrategiesBCD(sig.entry_price, sig.stop_loss, R, candles);

      results.push({
        signal_id: sig.id,
        symbol: sig.symbol,
        candle_time: sig.candle_time,
        entry_price: sig.entry_price,
        stop_loss: sig.stop_loss,
        risk_per_unit: R,
        regime_production: sig.regime_production ?? "unknown",
        price_15m: prices[0],
        price_30m: prices[1],
        price_1h: prices[2],
        price_2h: prices[3],
        price_4h: prices[4],
        mfe_15m: mfe[0], mae_15m: mae[0],
        mfe_30m: mfe[1], mae_30m: mae[1],
        mfe_1h: mfe[2],  mae_1h: mae[2],
        mfe_2h: mfe[3],  mae_2h: mae[3],
        mfe_4h: mfe[4],  mae_4h: mae[4],
        time_to_03r_min: timeToR[0],
        time_to_05r_min: timeToR[1],
        time_to_07r_min: timeToR[2],
        time_to_1r_min: timeToR[3],
        strategy_a_r: stratA,
        strategy_b_r: stratBCD.b,
        strategy_c_r: stratBCD.c,
        strategy_d_r: stratBCD.d,
      });
    }
  }

  console.log(
    `${LOG_PREFIX} Processed ${results.length} signals, skipped ${skipped}`
  );

  // 4. Write CSV
  if (results.length > 0) {
    writeCsv(results);
  }

  // 4b. Upsert to signal_mfe_analysis
  if (results.length > 0) {
    await upsertMfe(results);
  }

  // 5. Print summary table grouped by regime
  if (results.length > 0) {
    const regimes = Array.from(
      new Set(results.map((r) => r.regime_production))
    ).sort();

    const strategyDefs: { key: keyof MfeResult; name: string }[] = [
      { key: "strategy_a_r", name: "A (33/33/34)" },
      { key: "strategy_b_r", name: "B (50/25/25)" },
      { key: "strategy_c_r", name: "C (100@0.5R)" },
      { key: "strategy_d_r", name: "D (50+ladder)" },
    ];

    const allStats: StrategyStats[] = [];

    for (const sd of strategyDefs) {
      // ALL regimes
      const allR = results.map((r) => r[sd.key] as number);
      allStats.push(computeStats(sd.name, "ALL", allR));

      // Per regime
      for (const regime of regimes) {
        const regimeResults = results.filter(
          (r) => r.regime_production === regime
        );
        const rValues = regimeResults.map((r) => r[sd.key] as number);
        allStats.push(computeStats(sd.name, regime, rValues));
      }
    }

    console.log("");
    printTable(allStats);
  }

  // 6. Print MFE horizon summary
  if (results.length > 0) {
    console.log(`\n${LOG_PREFIX} MFE by horizon (median R):`);
    for (let i = 0; i < HORIZONS.length; i++) {
      const h = HORIZONS[i];
      const vals = results
        .map((r) => {
          const key = `mfe_${h.label}` as keyof MfeResult;
          return r[key] as number | null;
        })
        .filter((v): v is number => v !== null)
        .sort((a, b) => a - b);

      if (vals.length === 0) {
        console.log(`  ${h.label.padEnd(4)}: no data`);
        continue;
      }
      const median =
        vals.length % 2 === 0
          ? (vals[vals.length / 2 - 1] + vals[vals.length / 2]) / 2
          : vals[Math.floor(vals.length / 2)];
      const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
      const p75 = vals[Math.floor(vals.length * 0.75)];
      const p90 = vals[Math.floor(vals.length * 0.9)];
      console.log(
        `  ${h.label.padEnd(4)}: median=${median.toFixed(3)}R  mean=${mean.toFixed(3)}R  p75=${p75.toFixed(3)}R  p90=${p90.toFixed(3)}R  (n=${vals.length})`
      );
    }
  }

  // 7. Time-to-profit distribution
  if (results.length > 0) {
    console.log(`\n${LOG_PREFIX} Time-to-profit distribution:`);
    const rThresholds = ["0.3R", "0.5R", "1.0R"] as const;
    const timeWindows = [
      { label: "15m", mins: 15 },
      { label: "1h", mins: 60 },
      { label: "4h", mins: 240 },
    ];
    const ttFields: (keyof MfeResult)[] = [
      "time_to_03r_min", "time_to_05r_min", "time_to_1r_min",
    ];

    console.log(`  ${"".padEnd(6)} │ ${timeWindows.map((w) => w.label.padStart(8)).join(" │ ")}`);

    for (let t = 0; t < rThresholds.length; t++) {
      const field = ttFields[t];
      const pcts: string[] = [];
      for (const tw of timeWindows) {
        const reached = results.filter((r) => {
          const v = r[field] as number | null;
          return v !== null && v <= tw.mins;
        }).length;
        pcts.push(((reached / results.length) * 100).toFixed(1) + "%");
      }
      console.log(
        `  ${rThresholds[t].padEnd(6)} │ ${pcts.map((p) => p.padStart(8)).join(" │ ")}`
      );
    }
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n${LOG_PREFIX} Done in ${elapsed}s`);
}

main().catch((err) => {
  console.error(`${LOG_PREFIX} Fatal:`, err);
  process.exit(1);
});
