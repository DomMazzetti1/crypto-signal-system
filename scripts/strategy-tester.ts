/**
 * Strategy Tester: reusable backtesting engine that runs configurable strategies
 * against stored candle_cache data in Supabase.
 *
 * Usage:
 *   npx tsx scripts/strategy-tester.ts --config strategy.json
 *   npx tsx scripts/strategy-tester.ts --name 'SQ_SHORT_bear' --direction SHORT --entry BB_SQUEEZE \
 *     --regime bear --tp '0.5,1.0,2.5' --split '0.34,0.33,0.33' --sl-method UPPER_BB --interval 60
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
  console.error("[strategy-tester] Missing SUPABASE_URL or SUPABASE_ANON_KEY");
  process.exit(1);
}

const SB_HEADERS = {
  "Content-Type": "application/json",
  apikey: SUPABASE_ANON_KEY,
  Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
};

// ── Constants ──────────────────────────────────────────────

const BB_PERIOD = 20;
const BB_STDEV = 2.0;
const SQUEEZE_LOOKBACK = 120;
const ATR_PERIOD = 14;
const FORWARD_BARS = 48;
const LOG_PREFIX = "[strategy-tester]";

// Fee schedule (Bybit)
const MAKER_FEE = 0.0000;  // 0% for PostOnly limit orders (entry + TP1)
const TAKER_FEE = 0.00055; // 0.055% for market orders (SL, BE stop, TP2, TP3)

const SCANNER_SYMBOLS: string[] = [
  "1000BONKUSDT","1000PEPEUSDT","ADAUSDT","ALGOUSDT","APTUSDT","ARBUSDT",
  "ARIAUSDT","ASTERUSDT","AVAXUSDT","BANKUSDT","BARDUSDT","BEATUSDT",
  "BLURUSDT","BRUSDT","CRVUSDT","DOGEUSDT","DOTUSDT","DRIFTUSDT",
  "ENAUSDT","FARTCOINUSDT","FIDAUSDT","GALAUSDT","HBARUSDT","HEMIUSDT",
  "HYPEUSDT","KERNELUSDT","KITEUSDT","LINKUSDT","LITUSDT","MONUSDT",
  "NEARUSDT","NOMUSDT","ONDOUSDT","ONTUSDT","OPUSDT","PENGUUSDT",
  "PIPPINUSDT","PUMPFUNUSDT","RENDERUSDT","RESOLVUSDT","SEIUSDT",
  "SIRENUSDT","SOLUSDT","BTCUSDT",
];

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

interface StrategyConfig {
  name: string;
  direction: "SHORT" | "LONG" | "REVERSE";
  entry_logic: "BB_SQUEEZE" | "BB_SQUEEZE_REVERSAL";
  regime_filter: string[];
  sl_method: "UPPER_BB" | "FIXED_PCT";
  sl_param?: number;
  tp_levels: number[];
  tp_split: number[];
  move_sl_to_be_after_tp: number | null;
  min_vol_ratio: number | null;
  min_score: number | null;
  max_stop_pct: number;
  cooldown_bars: number;
  symbols: string[];
  interval: number;
  sr_filter: "none" | "block" | "grade";
  ms_filter: "none" | "grade";
  apply_fees: boolean;
}

interface Trade {
  symbol: string;
  candle_time: string;
  direction: "SHORT" | "LONG";
  entry_price: number;
  stop_loss: number;
  tp_levels: number[];
  tp_split: number[];
  regime: string;
  composite_score: number;
  vol_ratio: number;
  atr: number;
  realized_r: number;
  hit_sl: boolean;
  tp_hits: boolean[];
  bars_to_resolution: number;
  max_favorable_r: number;
  max_adverse_r: number;
  sr_obstacle: boolean;
  sr_distance_pct: number;
  ms_structure: "DOWNTREND" | "UPTREND" | "RANGE";
  resolution_path:
    | "FULL_SL"
    | "TP1_ONLY_SL"
    | "TP1_ONLY_BE"
    | "TP1_ONLY_EXPIRED"
    | "TP1_TP2_SL"
    | "TP1_TP2_BE"
    | "TP1_TP2_EXPIRED"
    | "TP1_TP2_TP3"
    | "EXPIRED";
  fee_in_r: number;
}

interface TestSummary {
  name: string;
  config: StrategyConfig;
  total_trades: number;
  win_rate: number;
  avg_r: number;
  total_r: number;
  profit_factor: number;
  max_consecutive_losses: number;
  max_drawdown_r: number;
  sharpe: number;
  by_regime: Record<string, { trades: number; wr: number; avg_r: number; pf: number }>;
  by_month: Record<string, { trades: number; wr: number; avg_r: number }>;
  top_symbols: { symbol: string; trades: number; avg_r: number }[];
  bottom_symbols: { symbol: string; trades: number; avg_r: number }[];
}

// ── Helpers ────────────────────────────────────────────────

function clamp(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, val));
}

function getArg(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(`--${flag}`);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  return args[idx + 1];
}

// ── CLI Parsing ────────────────────────────────────────────

function parseArgs(): StrategyConfig {
  const args = process.argv.slice(2);

  const configPath = getArg(args, "config");
  if (configPath) {
    const resolved = resolve(process.cwd(), configPath);
    const raw = JSON.parse(readFileSync(resolved, "utf8"));
    return normalizeConfig(raw);
  }

  const raw: Record<string, unknown> = {};
  raw.name = getArg(args, "name") ?? "unnamed";
  raw.direction = getArg(args, "direction") ?? "SHORT";
  raw.entry_logic = getArg(args, "entry") ?? "BB_SQUEEZE";
  const regimeStr = getArg(args, "regime") ?? "all";
  raw.regime_filter = regimeStr.split(",").map((s: string) => s.trim());
  raw.sl_method = getArg(args, "sl-method") ?? "UPPER_BB";
  raw.sl_param = getArg(args, "sl-param") ? Number(getArg(args, "sl-param")) : 0.02;
  const tpStr = getArg(args, "tp-levels") ?? getArg(args, "tp") ?? "0.5,1.0,2.5";
  raw.tp_levels = tpStr.split(",").map(Number);
  const splitStr = getArg(args, "tp-split") ?? getArg(args, "split");
  if (splitStr) {
    const nums = splitStr.split(",").map(Number);
    // Accept integer percentages (34,33,33) or fractions (0.34,0.33,0.33)
    const sum = nums.reduce((a, b) => a + b, 0);
    raw.tp_split = sum > 2 ? nums.map((n) => n / 100) : nums;
  } else {
    raw.tp_split = [0.34, 0.33, 0.33];
  }
  // Default to the live behavior: move SL to breakeven after TP2.
  // Also accept legacy --move-sl-be as "after TP1".
  const useBeStop = args.includes("--use-be-stop");
  const movSlArg = getArg(args, "move-sl-be");
  const beAfterArg = getArg(args, "move-sl-be-after") ?? getArg(args, "be-after");
  if (beAfterArg != null) {
    raw.move_sl_to_be_after_tp = Number(beAfterArg);
  } else if (movSlArg === "false") {
    raw.move_sl_to_be_after_tp = null;
  } else if (useBeStop || movSlArg != null) {
    raw.move_sl_to_be_after_tp = 1;
  } else {
    raw.move_sl_to_be_after_tp = 1;
  }
  raw.min_vol_ratio = getArg(args, "min-vol") ? Number(getArg(args, "min-vol")) : 0;
  raw.min_score = getArg(args, "min-score") ? Number(getArg(args, "min-score")) : 0;
  raw.max_stop_pct = getArg(args, "max-stop") ? Number(getArg(args, "max-stop")) : 0.05;
  raw.cooldown_bars = getArg(args, "cooldown") ? Number(getArg(args, "cooldown")) : 8;
  const symStr = getArg(args, "symbols") ?? "all";
  raw.symbols = symStr === "all" ? SCANNER_SYMBOLS : symStr.split(",").map((s: string) => s.trim());
  raw.interval = getArg(args, "interval") ? Number(getArg(args, "interval")) : 60;
  raw.sr_filter = getArg(args, "sr-filter") ?? "none";
  raw.ms_filter = getArg(args, "ms-filter") ?? "none";
  raw.apply_fees = !args.includes("--no-fees"); // default true, --no-fees to disable

  return normalizeConfig(raw);
}

function normalizeConfig(raw: Record<string, unknown>): StrategyConfig {
  let moveSlToBeAfterTp: number | null;
  if (raw.move_sl_to_be_after_tp === null) {
    moveSlToBeAfterTp = null;
  } else if (raw.move_sl_to_be_after_tp != null && raw.move_sl_to_be_after_tp !== "") {
    moveSlToBeAfterTp = Number(raw.move_sl_to_be_after_tp);
  } else if (raw.move_sl_to_be === true) {
    moveSlToBeAfterTp = 1;
  } else if (raw.move_sl_to_be === false) {
    moveSlToBeAfterTp = null;
  } else {
    moveSlToBeAfterTp = 2;
  }

  const config: StrategyConfig = {
    name: String(raw.name ?? "unnamed"),
    direction: String(raw.direction ?? "SHORT") as StrategyConfig["direction"],
    entry_logic: String(raw.entry_logic ?? "BB_SQUEEZE") as StrategyConfig["entry_logic"],
    regime_filter: Array.isArray(raw.regime_filter)
      ? raw.regime_filter.map(String)
      : ["all"],
    sl_method: String(raw.sl_method ?? "UPPER_BB") as StrategyConfig["sl_method"],
    sl_param: raw.sl_param != null ? Number(raw.sl_param) : undefined,
    tp_levels: Array.isArray(raw.tp_levels) ? raw.tp_levels.map(Number) : [0.5, 1.0, 2.5],
    tp_split: Array.isArray(raw.tp_split) ? raw.tp_split.map(Number) : [0.34, 0.33, 0.33],
    move_sl_to_be_after_tp: moveSlToBeAfterTp,
    min_vol_ratio: raw.min_vol_ratio != null ? Number(raw.min_vol_ratio) : null,
    min_score: raw.min_score != null ? Number(raw.min_score) : null,
    max_stop_pct: Number(raw.max_stop_pct ?? 0.05),
    cooldown_bars: Number(raw.cooldown_bars ?? 8),
    symbols: Array.isArray(raw.symbols)
      ? (raw.symbols.length === 1 && raw.symbols[0] === "all"
          ? SCANNER_SYMBOLS
          : raw.symbols.map(String))
      : SCANNER_SYMBOLS,
    interval: Number(raw.interval ?? 60),
    sr_filter: (["none", "block", "grade"].includes(String(raw.sr_filter ?? "none"))
      ? String(raw.sr_filter)
      : "none") as StrategyConfig["sr_filter"],
    ms_filter: (["none", "grade"].includes(String(raw.ms_filter ?? "none"))
      ? String(raw.ms_filter)
      : "none") as StrategyConfig["ms_filter"],
    apply_fees: raw.apply_fees !== false,
  };

  // Validate tp_levels and tp_split lengths match
  if (config.tp_levels.length !== config.tp_split.length) {
    console.error(
      `${LOG_PREFIX} tp_levels (${config.tp_levels.length}) and tp_split (${config.tp_split.length}) must have the same length`
    );
    process.exit(1);
  }

  const splitSum = config.tp_split.reduce((a, b) => a + b, 0);
  if (Math.abs(splitSum - 1.0) > 0.01) {
    console.error(
      `${LOG_PREFIX} tp_split sums to ${splitSum.toFixed(4)}, expected ~1.0`
    );
    process.exit(1);
  }

  if (config.move_sl_to_be_after_tp != null) {
    const beAfterTp = config.move_sl_to_be_after_tp;
    if (
      !Number.isInteger(beAfterTp) ||
      beAfterTp < 1 ||
      beAfterTp >= config.tp_levels.length
    ) {
      console.error(
        `${LOG_PREFIX} move_sl_to_be_after_tp must be an integer between 1 and ${config.tp_levels.length - 1}`
      );
      process.exit(1);
    }
  }

  if (config.sl_method === "FIXED_PCT" && config.sl_param == null) {
    console.error(
      `${LOG_PREFIX} --sl_param is required when --sl FIXED_PCT`
    );
    process.exit(1);
  }

  return config;
}

// ── Supabase data fetching ─────────────────────────────────

async function fetchCandles(symbol: string, interval: number): Promise<Candle[]> {
  const all: Candle[] = [];
  let offset = 0;
  const LIMIT = 1000; // Must match Supabase max_rows (1000) for pagination to work

  while (true) {
    const url = `${SUPABASE_URL}/rest/v1/candle_cache?symbol=eq.${symbol}&interval=eq.${interval}&select=start_time,open,high,low,close,volume&order=start_time.asc&limit=${LIMIT}&offset=${offset}`;
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
  const LIMIT = 1000; // Must match Supabase max_rows (1000) for pagination to work

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

  const tr: number[] = [0];
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
  const atrPct = atr / entry;
  const atrClamped = clamp(atrPct, 0.001, 0.04);
  const atrComponent = (1 - (atrClamped - 0.001) / (0.04 - 0.001)) * 100;

  const volComponent = (clamp(volRatio, 0, 5) / 5) * 100;

  const tierComponent = 100;
  const deviationPenalty = 0;

  const totalWeight = W_ATR + W_VOL + W_TIER;
  const weightedSum =
    atrComponent * W_ATR +
    volComponent * W_VOL +
    tierComponent * W_TIER -
    deviationPenalty * W_DEV;

  const finalScore = totalWeight > 0 ? clamp(weightedSum / totalWeight, 0, 100) : 0;
  return Math.round(finalScore * 100) / 100;
}

// ── Support / Resistance Detection ────────────────────────

const SR_LOOKBACK = 10;
const SR_WINDOW = 500;
const SR_TOUCH_TOLERANCE = 0.003; // 0.3%
const SR_TOUCH_LOOKBACK = 200;

interface SRLevel {
  price: number;
  type: "support" | "resistance";
  strength: number;
  bar_index: number;
}

/**
 * Identify swing highs and swing lows across the full candle array.
 * A swing high at bar j means candles[j].high > high of all bars within lookback on each side.
 * A swing low at bar j means candles[j].low < low of all bars within lookback on each side.
 * Returns raw swing points (strength computed per-query via getRelevantSRLevels).
 */
function detectSwingLevels(
  candles: Candle[],
  lookback: number = SR_LOOKBACK
): { price: number; type: "support" | "resistance"; bar_index: number }[] {
  const swings: { price: number; type: "support" | "resistance"; bar_index: number }[] = [];

  for (let j = lookback; j < candles.length - lookback; j++) {
    // Check swing high
    let isSwingHigh = true;
    for (let k = j - lookback; k <= j + lookback; k++) {
      if (k === j) continue;
      if (candles[k].high >= candles[j].high) {
        isSwingHigh = false;
        break;
      }
    }
    if (isSwingHigh) {
      swings.push({ price: candles[j].high, type: "resistance", bar_index: j });
    }

    // Check swing low
    let isSwingLow = true;
    for (let k = j - lookback; k <= j + lookback; k++) {
      if (k === j) continue;
      if (candles[k].low <= candles[j].low) {
        isSwingLow = false;
        break;
      }
    }
    if (isSwingLow) {
      swings.push({ price: candles[j].low, type: "support", bar_index: j });
    }
  }

  return swings;
}

/**
 * Get S/R levels relevant for a signal at bar_index, using a sliding window.
 * Only includes confirmed swings (bar_index + lookback <= current bar) within the last SR_WINDOW bars.
 * Strength = how many times price touched this level (within tolerance) in the last SR_TOUCH_LOOKBACK bars.
 */
function getRelevantSRLevels(
  allSwings: { price: number; type: "support" | "resistance"; bar_index: number }[],
  candles: Candle[],
  currentBar: number,
  lookback: number = SR_LOOKBACK
): SRLevel[] {
  const windowStart = Math.max(0, currentBar - SR_WINDOW);
  const confirmedEnd = currentBar - lookback; // swing must be confirmed

  const windowSwings = allSwings.filter(
    (s) => s.bar_index >= windowStart && s.bar_index <= confirmedEnd
  );

  // Count touches for each swing level
  const touchStart = Math.max(0, currentBar - SR_TOUCH_LOOKBACK);
  return windowSwings.map((s) => {
    let touches = 0;
    for (let k = touchStart; k <= currentBar; k++) {
      const high = candles[k].high;
      const low = candles[k].low;
      // Price "touched" the level if the bar's range came within tolerance
      if (
        Math.abs(high - s.price) / s.price <= SR_TOUCH_TOLERANCE ||
        Math.abs(low - s.price) / s.price <= SR_TOUCH_TOLERANCE
      ) {
        touches++;
      }
    }
    return { ...s, strength: touches };
  });
}

/**
 * Find the nearest S/R obstacle between entry and TP1.
 * For LONG: find resistance levels above entry (obstacles to upside).
 * For SHORT: find support levels below entry (obstacles to downside).
 */
function findNearestSR(
  levels: SRLevel[],
  price: number,
  direction: "LONG" | "SHORT"
): { level: number; strength: number; distance_pct: number } | null {
  let best: { level: number; strength: number; distance_pct: number } | null = null;

  for (const lvl of levels) {
    if (direction === "LONG" && lvl.type === "resistance" && lvl.price > price) {
      const dist = (lvl.price - price) / price;
      if (!best || dist < best.distance_pct) {
        best = { level: lvl.price, strength: lvl.strength, distance_pct: Math.round(dist * 10000) / 10000 };
      }
    } else if (direction === "SHORT" && lvl.type === "support" && lvl.price < price) {
      const dist = (price - lvl.price) / price;
      if (!best || dist < best.distance_pct) {
        best = { level: lvl.price, strength: lvl.strength, distance_pct: Math.round(dist * 10000) / 10000 };
      }
    }
  }

  return best;
}

// ── Market Structure Detection ─────────────────────────────

const MS_PIVOT_LOOKBACK = 5;

interface MarketStructure {
  structure: "DOWNTREND" | "UPTREND" | "RANGE";
  last_swing_high: number;
  last_swing_low: number;
}

/**
 * Detect market structure at a given bar index by finding the last 4 swing points
 * (alternating highs and lows) using 5-bar pivot detection.
 * Returns DOWNTREND (lower highs + lower lows), UPTREND (higher highs + higher lows), or RANGE.
 */
function detectMarketStructure(
  candles: Candle[],
  index: number,
  lookback: number = 50
): MarketStructure {
  const start = Math.max(MS_PIVOT_LOOKBACK, index - lookback);
  // Only consider confirmed pivots (need MS_PIVOT_LOOKBACK bars after the pivot)
  const end = index - MS_PIVOT_LOOKBACK;

  const swingHighs: { price: number; idx: number }[] = [];
  const swingLows: { price: number; idx: number }[] = [];

  for (let j = start; j <= end; j++) {
    // Swing high: high > high of 5 bars on each side
    let isHigh = true;
    for (let k = j - MS_PIVOT_LOOKBACK; k <= j + MS_PIVOT_LOOKBACK; k++) {
      if (k === j || k < 0 || k >= candles.length) continue;
      if (candles[k].high >= candles[j].high) { isHigh = false; break; }
    }
    if (isHigh) swingHighs.push({ price: candles[j].high, idx: j });

    // Swing low: low < low of 5 bars on each side
    let isLow = true;
    for (let k = j - MS_PIVOT_LOOKBACK; k <= j + MS_PIVOT_LOOKBACK; k++) {
      if (k === j || k < 0 || k >= candles.length) continue;
      if (candles[k].low <= candles[j].low) { isLow = false; break; }
    }
    if (isLow) swingLows.push({ price: candles[j].low, idx: j });
  }

  const lastHigh = swingHighs.length > 0 ? swingHighs[swingHighs.length - 1].price : 0;
  const lastLow = swingLows.length > 0 ? swingLows[swingLows.length - 1].price : 0;

  // Need at least 2 swing highs and 2 swing lows to classify
  if (swingHighs.length < 2 || swingLows.length < 2) {
    return { structure: "RANGE", last_swing_high: lastHigh, last_swing_low: lastLow };
  }

  const prevHigh = swingHighs[swingHighs.length - 2].price;
  const currHigh = swingHighs[swingHighs.length - 1].price;
  const prevLow = swingLows[swingLows.length - 2].price;
  const currLow = swingLows[swingLows.length - 1].price;

  const lowerHighs = currHigh < prevHigh;
  const lowerLows = currLow < prevLow;
  const higherHighs = currHigh > prevHigh;
  const higherLows = currLow > prevLow;

  let structure: "DOWNTREND" | "UPTREND" | "RANGE";
  if (lowerHighs && lowerLows) {
    structure = "DOWNTREND";
  } else if (higherHighs && higherLows) {
    structure = "UPTREND";
  } else {
    structure = "RANGE";
  }

  return { structure, last_swing_high: lastHigh, last_swing_low: lastLow };
}

// ── Core Engine ────────────────────────────────────────────

function processSymbolStrategy(
  symbol: string,
  candles: Candle[],
  regimeMap: Map<string, string>,
  config: StrategyConfig
): Trade[] {
  const atr14 = atrSeries(candles, ATR_PERIOD);
  const smaVolumes = sma(
    candles.map((c) => c.volume),
    BB_PERIOD
  );

  // Pre-compute all swing points once per symbol (only if S/R filtering is active)
  const allSwings = config.sr_filter !== "none"
    ? detectSwingLevels(candles, SR_LOOKBACK)
    : [];

  const trades: Trade[] = [];
  let lastSignalIndex = -config.cooldown_bars;
  let prevSqueezeMin: number | null = null;
  const bbWidthHistory: number[] = [];

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

    // Rolling min of bb_width for squeeze detection
    const lookbackSlice = bbWidthHistory.slice(-SQUEEZE_LOOKBACK);
    const rollingMin = lookbackSlice.length > 0 ? Math.min(...lookbackSlice) : bbWidth;
    const squeezeActive = bbWidth <= rollingMin;
    bbWidthHistory.push(bbWidth);

    if (squeezeActive) {
      prevSqueezeMin = rollingMin;
    }

    // Squeeze expansion detection
    const squeezeExpanded = prevSqueezeMin != null && bbWidth > prevSqueezeMin * 1.5;

    // Signal detection based on direction and entry_logic
    let signalDetected = false;
    let tradeDirection: "SHORT" | "LONG" = "SHORT";

    if (squeezeExpanded) {
      if (config.entry_logic === "BB_SQUEEZE") {
        if (config.direction === "SHORT") {
          signalDetected = candles[i].close < lower;
          tradeDirection = "SHORT";
        } else if (config.direction === "LONG") {
          signalDetected = candles[i].close > upper;
          tradeDirection = "LONG";
        } else if (config.direction === "REVERSE") {
          // Detect SHORT signal (close < lower), but enter LONG
          signalDetected = candles[i].close < lower;
          tradeDirection = "LONG";
        }
      } else if (config.entry_logic === "BB_SQUEEZE_REVERSAL") {
        // Same squeeze detection but flip direction
        if (config.direction === "SHORT") {
          // Detect LONG signal (close > upper), enter SHORT
          signalDetected = candles[i].close > upper;
          tradeDirection = "SHORT";
        } else if (config.direction === "LONG") {
          // Detect SHORT signal (close < lower), enter LONG
          signalDetected = candles[i].close < lower;
          tradeDirection = "LONG";
        } else if (config.direction === "REVERSE") {
          // Detect SHORT signal (close < lower), enter LONG
          signalDetected = candles[i].close < lower;
          tradeDirection = "LONG";
        }
      }
    }

    if (signalDetected) {
      // Cooldown check
      if (i - lastSignalIndex < config.cooldown_bars) {
        continue;
      }

      // Need ATR
      const atrVal = atr14[i];
      if (atrVal == null) continue;

      // Regime filter
      const dateStr = candles[i].start_time.slice(0, 10);
      const regime = regimeMap.get(dateStr) ?? "unknown";
      if (
        !config.regime_filter.includes("all") &&
        !config.regime_filter.includes(regime)
      ) {
        continue;
      }

      // Vol ratio filter (0 = no filter)
      if (config.min_vol_ratio != null && config.min_vol_ratio > 0 && volRatio < config.min_vol_ratio) {
        continue;
      }

      // Composite score
      const entry = candles[i].close;
      const compositeScore = computeCompositeScore(atrVal, entry, volRatio);

      // Score filter (0 = no filter)
      if (config.min_score != null && config.min_score > 0 && compositeScore < config.min_score) {
        continue;
      }

      lastSignalIndex = i;
      prevSqueezeMin = null; // reset squeeze state after firing

      // SL computation
      let stop: number;
      if (config.sl_method === "UPPER_BB") {
        stop = tradeDirection === "SHORT" ? upper : lower;
      } else {
        // FIXED_PCT
        stop =
          tradeDirection === "SHORT"
            ? entry * (1 + config.sl_param!)
            : entry * (1 - config.sl_param!);
      }

      // BB_SQUEEZE_REVERSAL override: swap the original signal's geometry
      let R: number;
      let tpLevels: number[];
      if (config.entry_logic === "BB_SQUEEZE_REVERSAL") {
        if (tradeDirection === "LONG") {
          const shortR = upper - entry;
          stop = entry - shortR;
          R = shortR;
          tpLevels = config.tp_levels.map((level) => entry + level * R);
        } else {
          const longR = entry - lower;
          stop = entry + longR;
          R = longR;
          tpLevels = config.tp_levels.map((level) => entry - level * R);
        }
      } else {
        R = Math.abs(stop - entry);
        tpLevels = config.tp_levels.map((level) =>
          tradeDirection === "SHORT" ? entry - level * R : entry + level * R
        );
      }
      if (R <= 0 || R / entry > config.max_stop_pct) continue;

      // S/R obstacle check
      let srObstacle = false;
      let srDistancePct = 0;

      if (config.sr_filter !== "none") {
        const srLevels = getRelevantSRLevels(allSwings, candles, i, SR_LOOKBACK);
        const nearest = findNearestSR(srLevels, entry, tradeDirection);

        if (nearest && nearest.strength >= 3) {
          // Check if the S/R level sits between entry and TP1
          const tp1Price = tpLevels[0];
          const levelBetween = tradeDirection === "LONG"
            ? nearest.level > entry && nearest.level < tp1Price
            : nearest.level < entry && nearest.level > tp1Price;

          if (levelBetween) {
            // Check if it's within 50% of the R distance from entry
            const distFromEntry = Math.abs(nearest.level - entry);
            if (distFromEntry <= R * 0.5) {
              srObstacle = true;
              srDistancePct = nearest.distance_pct;
            }
          }
        }

        if (config.sr_filter === "block" && srObstacle) {
          continue; // Skip this signal
        }
      }

      // Grading
      const tpHits: boolean[] = config.tp_levels.map(() => false);
      let hitSl = false;
      let maxFavorable = 0;
      let maxAdverse = 0;
      let barsToResolution = Math.min(FORWARD_BARS, candles.length - i - 1);
      let effectiveStop = stop;
      let slMovedToBe = false;

      for (
        let j = i + 1;
        j < Math.min(i + 1 + FORWARD_BARS, candles.length);
        j++
      ) {
        const bar = candles[j];

        let favorable: number;
        let adverse: number;
        if (tradeDirection === "SHORT") {
          favorable = (entry - bar.low) / R;
          adverse = (bar.high - entry) / R;
        } else {
          favorable = (bar.high - entry) / R;
          adverse = (entry - bar.low) / R;
        }
        if (favorable > maxFavorable) maxFavorable = favorable;
        if (adverse > maxAdverse) maxAdverse = adverse;

        // Check SL hit
        if (!hitSl) {
          const slHitThisBar =
            tradeDirection === "SHORT"
              ? bar.high >= effectiveStop
              : bar.low <= effectiveStop;
          if (slHitThisBar) {
            hitSl = true;
            // If no TP hit yet, we're fully stopped out
            if (!tpHits.some(Boolean)) {
              barsToResolution = j - i;
              break;
            }
            // If SL hit after move_sl_to_be, remaining exits at BE
            barsToResolution = j - i;
            break;
          }
        }

        // Check TP levels
        for (let k = 0; k < tpLevels.length; k++) {
          if (tpHits[k]) continue;
          const tpHitThisBar =
            tradeDirection === "SHORT"
              ? bar.low <= tpLevels[k]
              : bar.high >= tpLevels[k];
          if (tpHitThisBar) {
            tpHits[k] = true;

            // Move SL to breakeven after the configured target is hit.
            if (
              config.move_sl_to_be_after_tp != null &&
              !slMovedToBe &&
              k + 1 >= config.move_sl_to_be_after_tp
            ) {
              effectiveStop = entry;
              slMovedToBe = true;
            }

            // If all TPs hit, we're done
            if (tpHits.every(Boolean)) {
              barsToResolution = j - i;
              // Use a flag to break outer loop
              j = candles.length; // force exit
              break;
            }
          }
        }
      }

      // Fee model: taker fee in R-units varies per trade
      const stopDistPct = R / entry;
      const feeInR = config.apply_fees ? TAKER_FEE / stopDistPct : 0;

      // Calculate realized R using ladder (with fee adjustments)
      // Entry: PostOnly limit (0% maker) — no fee
      // TP1 (k=0): exchange limit (0% maker) — no fee
      // TP2+ (k>=1): market order — subtract feeInR
      // SL: market order — subtract feeInR
      // BE stop: market order — remaining portion loses feeInR
      let realizedR = 0;
      for (let k = 0; k < config.tp_levels.length; k++) {
        if (tpHits[k]) {
          const tpFee = k === 0 ? 0 : feeInR; // TP1 is maker (free), TP2+ are taker
          realizedR += config.tp_split[k] * (config.tp_levels[k] - tpFee);
        } else {
          // This TP was not hit
          if (hitSl) {
            if (slMovedToBe) {
              // SL hit after move to BE — remaining exits at 0R minus taker fee
              realizedR -= config.tp_split[k] * feeInR;
            } else {
              // SL hit before any TP — full loss on this portion plus taker fee
              realizedR -= config.tp_split[k] * (1.0 + feeInR);
            }
          }
          // If neither TP nor SL hit (ran out of bars), treat as 0R
        }
      }

      // Determine resolution path
      const tpHitCount = tpHits.filter(Boolean).length;
      let resolutionPath: Trade["resolution_path"];
      if (hitSl && tpHitCount === 0) {
        resolutionPath = "FULL_SL";
      } else if (tpHits.every(Boolean)) {
        resolutionPath = "TP1_TP2_TP3";
      } else if (hitSl && tpHitCount >= 2) {
        resolutionPath = slMovedToBe ? "TP1_TP2_BE" : "TP1_TP2_SL";
      } else if (hitSl && tpHitCount >= 1) {
        resolutionPath = slMovedToBe ? "TP1_ONLY_BE" : "TP1_ONLY_SL";
      } else if (tpHitCount >= 2) {
        resolutionPath = "TP1_TP2_EXPIRED";
      } else if (tpHitCount >= 1) {
        resolutionPath = "TP1_ONLY_EXPIRED";
      } else {
        resolutionPath = "EXPIRED";
      }

      trades.push({
        symbol,
        candle_time: candles[i].start_time,
        direction: tradeDirection,
        entry_price: entry,
        stop_loss: stop,
        tp_levels: tpLevels,
        tp_split: config.tp_split,
        regime,
        composite_score: compositeScore,
        vol_ratio: Math.round(volRatio * 100) / 100,
        atr: atrVal,
        realized_r: Math.round(realizedR * 1000) / 1000,
        hit_sl: hitSl,
        tp_hits: tpHits,
        bars_to_resolution: barsToResolution,
        max_favorable_r: Math.round(maxFavorable * 1000) / 1000,
        max_adverse_r: Math.round(maxAdverse * 1000) / 1000,
        sr_obstacle: srObstacle,
        sr_distance_pct: srDistancePct,
        ms_structure: config.ms_filter !== "none"
          ? detectMarketStructure(candles, i).structure
          : "RANGE",
        resolution_path: resolutionPath,
        fee_in_r: Math.round(feeInR * 10000) / 10000,
      });
    }

    // Reset squeeze state if width has expanded far beyond any recent squeeze
    if (prevSqueezeMin != null && bbWidth > prevSqueezeMin * 3) {
      prevSqueezeMin = null;
    }
  }

  return trades;
}

// ── Summary Computation ────────────────────────────────────

function computeSummary(trades: Trade[], config: StrategyConfig): TestSummary {
  const totalTrades = trades.length;
  if (totalTrades === 0) {
    return {
      name: config.name,
      config,
      total_trades: 0,
      win_rate: 0,
      avg_r: 0,
      total_r: 0,
      profit_factor: 0,
      max_consecutive_losses: 0,
      max_drawdown_r: 0,
      sharpe: 0,
      by_regime: {},
      by_month: {},
      top_symbols: [],
      bottom_symbols: [],
    };
  }

  const wins = trades.filter((t) => t.realized_r > 0).length;
  const winRate = Math.round((wins / totalTrades) * 10000) / 100;
  const totalR = trades.reduce((s, t) => s + t.realized_r, 0);
  const avgR = Math.round((totalR / totalTrades) * 1000) / 1000;

  // Profit factor
  const sumPositive = trades.reduce(
    (s, t) => s + (t.realized_r > 0 ? t.realized_r : 0),
    0
  );
  const sumNegative = trades.reduce(
    (s, t) => s + (t.realized_r < 0 ? t.realized_r : 0),
    0
  );
  const profitFactor =
    sumNegative === 0
      ? sumPositive > 0
        ? Infinity
        : 0
      : Math.round((sumPositive / Math.abs(sumNegative)) * 100) / 100;

  // Max consecutive losses
  let maxConsecLosses = 0;
  let currentStreak = 0;
  for (const t of trades) {
    if (t.realized_r <= 0) {
      currentStreak++;
      if (currentStreak > maxConsecLosses) maxConsecLosses = currentStreak;
    } else {
      currentStreak = 0;
    }
  }

  // Max drawdown in R (peak-to-trough of equity curve)
  let peak = 0;
  let cumR = 0;
  let maxDD = 0;
  for (const t of trades) {
    cumR += t.realized_r;
    if (cumR > peak) peak = cumR;
    const dd = peak - cumR;
    if (dd > maxDD) maxDD = dd;
  }
  const maxDrawdownR = Math.round(maxDD * 1000) / 1000;

  // Sharpe ratio (annualized)
  const rValues = trades.map((t) => t.realized_r);
  const mean = totalR / totalTrades;
  const variance =
    rValues.reduce((s, r) => s + (r - mean) ** 2, 0) / totalTrades;
  const stddev = Math.sqrt(variance);
  const sharpe =
    stddev > 0
      ? Math.round((mean / stddev) * Math.sqrt(252) * 100) / 100
      : 0;

  // By regime
  const byRegime: Record<string, { trades: number; wr: number; avg_r: number; pf: number }> = {};
  const regimeGroups = new Map<string, Trade[]>();
  for (const t of trades) {
    const group = regimeGroups.get(t.regime) ?? [];
    group.push(t);
    regimeGroups.set(t.regime, group);
  }
  for (const [regime, group] of Array.from(regimeGroups)) {
    const w = group.filter((t) => t.realized_r > 0).length;
    const sum = group.reduce((s, t) => s + t.realized_r, 0);
    const regimePos = group.reduce((s, t) => s + (t.realized_r > 0 ? t.realized_r : 0), 0);
    const regimeNeg = group.reduce((s, t) => s + (t.realized_r < 0 ? t.realized_r : 0), 0);
    const regimePf = regimeNeg === 0
      ? (regimePos > 0 ? Infinity : 0)
      : Math.round((regimePos / Math.abs(regimeNeg)) * 100) / 100;
    byRegime[regime] = {
      trades: group.length,
      wr: Math.round((w / group.length) * 10000) / 100,
      avg_r: Math.round((sum / group.length) * 1000) / 1000,
      pf: regimePf,
    };
  }

  // By month
  const byMonth: Record<string, { trades: number; wr: number; avg_r: number }> = {};
  const monthGroups = new Map<string, Trade[]>();
  for (const t of trades) {
    const month = t.candle_time.slice(0, 7);
    const group = monthGroups.get(month) ?? [];
    group.push(t);
    monthGroups.set(month, group);
  }
  for (const [month, group] of Array.from(monthGroups)) {
    const w = group.filter((t) => t.realized_r > 0).length;
    const sum = group.reduce((s, t) => s + t.realized_r, 0);
    byMonth[month] = {
      trades: group.length,
      wr: Math.round((w / group.length) * 10000) / 100,
      avg_r: Math.round((sum / group.length) * 1000) / 1000,
    };
  }

  // Top/bottom symbols
  const symbolGroups = new Map<string, Trade[]>();
  for (const t of trades) {
    const group = symbolGroups.get(t.symbol) ?? [];
    group.push(t);
    symbolGroups.set(t.symbol, group);
  }
  const symbolStats = Array.from(symbolGroups).map(([sym, group]) => ({
    symbol: sym,
    trades: group.length,
    avg_r:
      Math.round(
        (group.reduce((s, t) => s + t.realized_r, 0) / group.length) * 1000
      ) / 1000,
  }));
  symbolStats.sort((a, b) => b.avg_r - a.avg_r);
  const topSymbols = symbolStats.slice(0, 5);
  const bottomSymbols = symbolStats.slice(-5).reverse();

  return {
    name: config.name,
    config,
    total_trades: totalTrades,
    win_rate: winRate,
    avg_r: avgR,
    total_r: Math.round(totalR * 1000) / 1000,
    profit_factor: profitFactor,
    max_consecutive_losses: maxConsecLosses,
    max_drawdown_r: maxDrawdownR,
    sharpe,
    by_regime: byRegime,
    by_month: byMonth,
    top_symbols: topSymbols,
    bottom_symbols: bottomSymbols,
  };
}

// ── Output Formatting ──────────────────────────────────────

function printSummary(summary: TestSummary, trades: Trade[] = []): void {
  const c = summary.config;
  console.log("");
  console.log("═══════════════════════════════════════════");
  console.log(`Strategy Test: ${summary.name}`);
  console.log(
    `Direction: ${c.direction} | Entry: ${c.entry_logic} | SL: ${c.sl_method}`
  );
  console.log(
    `TP Levels: [${c.tp_levels.join(", ")}] | Split: [${c.tp_split.join(", ")}]`
  );
  console.log(
    `Regime Filter: [${c.regime_filter.join(", ")}] | Interval: ${c.interval}m | BE Stop After: ${c.move_sl_to_be_after_tp == null ? "disabled" : `TP${c.move_sl_to_be_after_tp}`} | Fees: ${c.apply_fees}`
  );
  console.log("═══════════════════════════════════════════");

  // Fee model summary
  if (c.apply_fees && trades.length > 0) {
    const avgFeeInR = trades.reduce((s, t) => s + t.fee_in_r, 0) / trades.length;
    const avgStopDist = trades.reduce((s, t) => {
      const sd = Math.abs(t.stop_loss - t.entry_price) / t.entry_price;
      return s + sd;
    }, 0) / trades.length;
    console.log(
      `Fee model: ON (avg fee_in_r: ${avgFeeInR.toFixed(4)}R per market exit, avg stop distance: ${(avgStopDist * 100).toFixed(2)}%)`
    );
  }
  console.log("");

  const pf =
    summary.profit_factor === Infinity ? "∞" : summary.profit_factor.toFixed(2);
  console.log(
    `OVERALL: ${summary.total_trades} trades | WR ${summary.win_rate}% | Avg R ${summary.avg_r} | Total R ${summary.total_r} | PF ${pf} | Sharpe ${summary.sharpe}`
  );
  console.log(
    `Max Consec Losses: ${summary.max_consecutive_losses} | Max DD: ${summary.max_drawdown_r}R`
  );
  console.log("");

  // By regime
  console.log("BY REGIME:");
  for (const [regime, stats] of Object.entries(summary.by_regime)) {
    const regimePf = stats.pf === Infinity ? "∞" : stats.pf.toFixed(2);
    console.log(
      `  ${regime.padEnd(12)} ${String(stats.trades).padStart(4)} trades  WR ${String(stats.wr).padStart(6)}%  Avg R ${stats.avg_r}  PF ${regimePf}`
    );
  }
  console.log("");

  // By month (last 12)
  const months = Object.keys(summary.by_month).sort();
  const recentMonths = months.slice(-12);
  if (recentMonths.length > 0) {
    console.log("BY MONTH (last 12):");
    for (const month of recentMonths) {
      const stats = summary.by_month[month];
      console.log(
        `  ${month}: ${String(stats.trades).padStart(4)} trades  WR ${String(stats.wr).padStart(6)}%  Avg R ${stats.avg_r}`
      );
    }
    console.log("");
  }

  // Top/bottom symbols
  if (summary.top_symbols.length > 0) {
    console.log("TOP 5 SYMBOLS:                  BOTTOM 5 SYMBOLS:");
    const maxRows = Math.max(
      summary.top_symbols.length,
      summary.bottom_symbols.length
    );
    for (let i = 0; i < maxRows; i++) {
      const top = summary.top_symbols[i];
      const bot = summary.bottom_symbols[i];
      const topStr = top
        ? `  ${top.symbol.padEnd(16)} ${String(top.trades).padStart(3)}t avgR=${top.avg_r}`
        : "";
      const botStr = bot
        ? `  ${bot.symbol.padEnd(16)} ${String(bot.trades).padStart(3)}t avgR=${bot.avg_r}`
        : "";
      console.log(`${topStr.padEnd(34)}${botStr}`);
    }
    console.log("");
  }

  // S/R analysis (only when sr_filter is 'grade')
  if (summary.config.sr_filter === "grade" && trades.length > 0) {
    const withObstacle = trades.filter((t) => t.sr_obstacle);
    const withoutObstacle = trades.filter((t) => !t.sr_obstacle);

    const statsFor = (group: Trade[]) => {
      if (group.length === 0) return { n: 0, wr: 0, avgR: 0 };
      const wins = group.filter((t) => t.realized_r > 0).length;
      const wr = Math.round((wins / group.length) * 10000) / 100;
      const avgR = Math.round((group.reduce((s, t) => s + t.realized_r, 0) / group.length) * 1000) / 1000;
      return { n: group.length, wr, avgR };
    };

    const with_ = statsFor(withObstacle);
    const without_ = statsFor(withoutObstacle);

    console.log("S/R ANALYSIS:");
    console.log(
      `  With S/R obstacle:    ${String(with_.n).padStart(4)} trades  WR ${String(with_.wr).padStart(6)}%  Avg R ${with_.avgR}`
    );
    console.log(
      `  Without S/R obstacle: ${String(without_.n).padStart(4)} trades  WR ${String(without_.wr).padStart(6)}%  Avg R ${without_.avgR}`
    );
    console.log("");
  }

  // Market structure analysis (only when ms_filter is 'grade')
  if (summary.config.ms_filter === "grade" && trades.length > 0) {
    const statsFor = (group: Trade[]) => {
      if (group.length === 0) return { n: 0, wr: 0, avgR: 0 };
      const wins = group.filter((t) => t.realized_r > 0).length;
      const wr = Math.round((wins / group.length) * 10000) / 100;
      const avgR = Math.round((group.reduce((s, t) => s + t.realized_r, 0) / group.length) * 1000) / 1000;
      return { n: group.length, wr, avgR };
    };

    const downtrend = statsFor(trades.filter((t) => t.ms_structure === "DOWNTREND"));
    const uptrend = statsFor(trades.filter((t) => t.ms_structure === "UPTREND"));
    const range = statsFor(trades.filter((t) => t.ms_structure === "RANGE"));

    console.log("MARKET STRUCTURE ANALYSIS:");
    console.log(
      `  DOWNTREND signals:    ${String(downtrend.n).padStart(4)} trades  WR ${String(downtrend.wr).padStart(6)}%  Avg R ${downtrend.avgR}`
    );
    console.log(
      `  UPTREND signals:      ${String(uptrend.n).padStart(4)} trades  WR ${String(uptrend.wr).padStart(6)}%  Avg R ${uptrend.avgR}`
    );
    console.log(
      `  RANGE signals:        ${String(range.n).padStart(4)} trades  WR ${String(range.wr).padStart(6)}%  Avg R ${range.avgR}`
    );
    console.log("");
  }

  // Ladder analysis (always shown when trades exist)
  if (trades.length > 0) {
    const pathStats = (path: Trade["resolution_path"]) => {
      const group = trades.filter((t) => t.resolution_path === path);
      if (group.length === 0) return { n: 0, avgR: "0.000" };
      const avgR = (group.reduce((s, t) => s + t.realized_r, 0) / group.length).toFixed(3);
      return { n: group.length, avgR };
    };

    const fullSl = pathStats("FULL_SL");
    const tp1Sl = pathStats("TP1_ONLY_SL");
    const tp1Be = pathStats("TP1_ONLY_BE");
    const tp1Expired = pathStats("TP1_ONLY_EXPIRED");
    const tp1Tp2Sl = pathStats("TP1_TP2_SL");
    const tp1Tp2Be = pathStats("TP1_TP2_BE");
    const tp1Tp2Expired = pathStats("TP1_TP2_EXPIRED");
    const tp1Tp2Tp3 = pathStats("TP1_TP2_TP3");
    const expired = pathStats("EXPIRED");

    console.log("LADDER ANALYSIS:");
    console.log(`  FULL_SL (missed TP1):   ${String(fullSl.n).padStart(4)} trades  Avg R ${fullSl.avgR}`);
    console.log(`  TP1→SL:                 ${String(tp1Sl.n).padStart(4)} trades  Avg R ${tp1Sl.avgR}`);
    console.log(`  TP1→BE:                 ${String(tp1Be.n).padStart(4)} trades  Avg R ${tp1Be.avgR}`);
    console.log(`  TP1→EXPIRED:            ${String(tp1Expired.n).padStart(4)} trades  Avg R ${tp1Expired.avgR}`);
    console.log(`  TP1→TP2→SL:             ${String(tp1Tp2Sl.n).padStart(4)} trades  Avg R ${tp1Tp2Sl.avgR}`);
    console.log(`  TP1→TP2→BE:             ${String(tp1Tp2Be.n).padStart(4)} trades  Avg R ${tp1Tp2Be.avgR}`);
    console.log(`  TP1→TP2→EXPIRED:        ${String(tp1Tp2Expired.n).padStart(4)} trades  Avg R ${tp1Tp2Expired.avgR}`);
    console.log(`  TP1→TP2→TP3:            ${String(tp1Tp2Tp3.n).padStart(4)} trades  Avg R ${tp1Tp2Tp3.avgR}`);
    if (expired.n > 0) {
      console.log(`  EXPIRED:                ${String(expired.n).padStart(4)} trades  Avg R ${expired.avgR}`);
    }
    console.log("");
  }
}

// ── Supabase Storage ───────────────────────────────────────

// Migration SQL (run manually or via Supabase dashboard):
// CREATE TABLE IF NOT EXISTS strategy_test_results (
//   id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
//   name text NOT NULL,
//   config jsonb NOT NULL,
//   total_trades integer NOT NULL,
//   win_rate numeric NOT NULL,
//   avg_r numeric NOT NULL,
//   total_r numeric NOT NULL,
//   profit_factor numeric NOT NULL,
//   max_consec_loss integer NOT NULL,
//   max_drawdown numeric NOT NULL,
//   sharpe numeric NOT NULL,
//   by_regime jsonb NOT NULL,
//   by_month jsonb NOT NULL,
//   created_at timestamptz DEFAULT now()
// );

async function storeResults(summary: TestSummary): Promise<void> {
  const row = {
    name: summary.name,
    config: summary.config,
    total_trades: summary.total_trades,
    win_rate: summary.win_rate,
    avg_r: summary.avg_r,
    total_r: summary.total_r,
    profit_factor: summary.profit_factor === Infinity ? 9999 : summary.profit_factor,
    max_consec_loss: summary.max_consecutive_losses,
    max_drawdown: summary.max_drawdown_r,
    sharpe: summary.sharpe,
    by_regime: summary.by_regime,
    by_month: summary.by_month,
    created_at: new Date().toISOString(),
  };

  try {
    const url = `${SUPABASE_URL}/rest/v1/strategy_test_results`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        ...SB_HEADERS,
        Prefer: "return=minimal",
      },
      body: JSON.stringify(row),
    });

    if (!res.ok) {
      const text = await res.text();
      console.warn(
        `${LOG_PREFIX} WARNING: Failed to store results (table may not exist): ${text}`
      );
    } else {
      console.log(`${LOG_PREFIX} Results stored in strategy_test_results`);
    }
  } catch (err) {
    console.warn(`${LOG_PREFIX} WARNING: Could not store results:`, err);
  }
}

// ── Main ───────────────────────────────────────────────────

async function main() {
  const t0 = Date.now();
  const config = parseArgs();
  console.log(`${LOG_PREFIX} Running: ${config.name}`);
  console.log(
    `${LOG_PREFIX} ${config.symbols.length} symbols, interval=${config.interval}m, direction=${config.direction}`
  );

  const regimeMap = await fetchRegimeMap();
  const allTrades: Trade[] = [];

  for (const symbol of config.symbols) {
    const candles = await fetchCandles(symbol, config.interval);
    if (candles.length < BB_PERIOD + FORWARD_BARS) {
      console.log(
        `${LOG_PREFIX} ${symbol}: skipped (${candles.length} candles)`
      );
      continue;
    }
    const trades = processSymbolStrategy(symbol, candles, regimeMap, config);
    allTrades.push(...trades);
    if (trades.length > 0) {
      console.log(`  ${symbol}: ${trades.length} trades`);
    }
  }

  // Sort chronologically for correct DD/streak calculation
  allTrades.sort((a, b) => a.candle_time.localeCompare(b.candle_time));

  const summary = computeSummary(allTrades, config);
  printSummary(summary, allTrades);
  await storeResults(summary);

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`${LOG_PREFIX} Done in ${elapsed}s`);
}

main().catch((err) => {
  console.error(`${LOG_PREFIX} Fatal:`, err);
  process.exit(1);
});
