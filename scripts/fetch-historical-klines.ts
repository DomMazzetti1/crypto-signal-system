/**
 * Fetch historical klines from Bybit V5 API and upsert into candle_cache.
 *
 * Usage: npx tsx scripts/fetch-historical-klines.ts --symbols BTCUSDT,SOLUSDT --interval 60 --years 1
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
  console.error("[fetch-klines] Missing SUPABASE_URL or SUPABASE_ANON_KEY");
  process.exit(1);
}

const SB_HEADERS = {
  "Content-Type": "application/json",
  apikey: SUPABASE_ANON_KEY,
  Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
};

// ── Constants ─────────────────────────────────────────────

const ALL_SYMBOLS = [
  "1000BONKUSDT","1000PEPEUSDT","ADAUSDT","ALGOUSDT","APTUSDT","ARBUSDT",
  "ARIAUSDT","ASTERUSDT","AVAXUSDT","BANKUSDT","BARDUSDT","BEATUSDT",
  "BLURUSDT","BRUSDT","CRVUSDT","DOGEUSDT","DOTUSDT","DRIFTUSDT",
  "ENAUSDT","FARTCOINUSDT","FIDAUSDT","GALAUSDT","HBARUSDT","HEMIUSDT",
  "HYPEUSDT","KERNELUSDT","KITEUSDT","LINKUSDT","LITUSDT","MONUSDT",
  "NEARUSDT","NOMUSDT","ONDOUSDT","ONTUSDT","OPUSDT","PENGUUSDT",
  "PIPPINUSDT","PUMPFUNUSDT","RENDERUSDT","RESOLVUSDT","SEIUSDT",
  "SIRENUSDT","SOLUSDT","BTCUSDT",
] as const;

const BYBIT_BASE = "https://api.bybit.com/v5/market";
const BATCH_UPSERT = 500;
const RATE_LIMIT_MS = 200;
const PAUSE_EVERY = 20;
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 10000;
const PAUSE_MS = 3000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── Types ─────────────────────────────────────────────────

interface Candle {
  startTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

// ── CLI arg parsing ───────────────────────────────────────

function parseArgs(): { symbols: string[]; interval: string; years: number } {
  const args = process.argv.slice(2);
  let symbols: string[] = [...ALL_SYMBOLS];
  let interval = "60";
  let years = 2;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--symbols" && args[i + 1]) {
      const val = args[++i];
      symbols = val === "all" ? [...ALL_SYMBOLS] : val.split(",");
    } else if (args[i] === "--interval" && args[i + 1]) {
      interval = args[++i];
    } else if (args[i] === "--years" && args[i + 1]) {
      years = Number(args[++i]);
    }
  }
  return { symbols, interval, years };
}

// ── Query latest stored candle time ───────────────────────

async function getLatestStoredTime(
  symbol: string,
  interval: string
): Promise<number | null> {
  const url = `${SUPABASE_URL}/rest/v1/candle_cache?symbol=eq.${symbol}&interval=eq.${interval}&select=start_time&order=start_time.desc&limit=1`;
  const res = await fetch(url, { headers: SB_HEADERS });
  if (!res.ok) return null;
  const rows: { start_time: string }[] = await res.json();
  if (rows.length === 0) return null;
  return new Date(rows[0].start_time).getTime();
}

// ── Fetch single page of klines from Bybit ────────────────

async function fetchKlinesPage(
  symbol: string,
  interval: string,
  endMs: number
): Promise<Candle[]> {
  const url = `${BYBIT_BASE}/kline?category=linear&symbol=${symbol}&interval=${interval}&limit=200&end=${endMs}`;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const res = await fetch(url);

    if (res.status === 429) {
      console.warn(`[fetch-klines] HTTP 429 for ${symbol}, retry ${attempt}/${MAX_RETRIES}...`);
      await sleep(RETRY_DELAY_MS);
      continue;
    }

    const json = await res.json();

    if (json.retCode === 10006 || (json.retMsg && /rate limit/i.test(json.retMsg))) {
      console.warn(`[fetch-klines] Rate limited (retCode=${json.retCode}) for ${symbol}, retry ${attempt}/${MAX_RETRIES}...`);
      await sleep(RETRY_DELAY_MS);
      continue;
    }

    if (json.retCode !== 0) {
      throw new Error(`Bybit kline error for ${symbol}: ${json.retMsg}`);
    }

    const list: string[][] = json.result?.list ?? [];
    return list.map((k: string[]) => ({
      startTime: Number(k[0]),
      open: parseFloat(k[1]),
      high: parseFloat(k[2]),
      low: parseFloat(k[3]),
      close: parseFloat(k[4]),
      volume: parseFloat(k[5]),
    }));
  }

  throw new Error(`[fetch-klines] Rate limit retries exhausted for ${symbol}`);
}

// ── Paginate backwards to fetch all klines ────────────────

async function fetchAllKlines(
  symbol: string,
  interval: string,
  years: number,
  latestStoredMs: number | null
): Promise<Candle[]> {
  const cutoffMs = Date.now() - years * 365.25 * 24 * 60 * 60 * 1000;
  let endMs = Date.now();
  let callCount = 0;
  const allCandles: Candle[] = [];

  while (true) {
    const page = await fetchKlinesPage(symbol, interval, endMs);
    if (page.length === 0) break;

    const filtered = latestStoredMs
      ? page.filter((c) => c.startTime > latestStoredMs)
      : page;

    if (filtered.length === 0) break;

    allCandles.push(...filtered);

    // Oldest candle in page for backward pagination
    const oldestTime = Math.min(...page.map((c) => c.startTime));
    endMs = oldestTime;

    if (endMs <= cutoffMs) break;

    // Rate limiting
    callCount++;
    if (callCount % PAUSE_EVERY === 0) {
      await sleep(PAUSE_MS);
    } else {
      await sleep(RATE_LIMIT_MS);
    }
  }

  return allCandles;
}

// ── Batch upsert candles to Supabase ──────────────────────

async function upsertCandles(
  symbol: string,
  interval: string,
  candles: Candle[]
): Promise<void> {
  const url = `${SUPABASE_URL}/rest/v1/candle_cache?on_conflict=symbol,interval,start_time`;

  // Deduplicate by (symbol, interval, start_time) — Bybit can return
  // overlapping candles at pagination boundaries.
  const seen = new Map<string, Candle>();
  for (const c of candles) {
    const key = `${symbol}|${interval}|${c.startTime}`;
    if (!seen.has(key)) seen.set(key, c);
  }
  const unique = Array.from(seen.values());

  for (let i = 0; i < unique.length; i += BATCH_UPSERT) {
    const batch = unique.slice(i, i + BATCH_UPSERT).map((c) => ({
      symbol,
      interval,
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
      throw new Error(`[fetch-klines] Upsert error for ${symbol}: ${text}`);
    }
  }
}

// ── Main ──────────────────────────────────────────────────

async function main() {
  const { symbols, interval, years } = parseArgs();
  console.log(
    `[fetch-klines] ${symbols.length} symbols, interval=${interval}, years=${years}`
  );

  let totalCandles = 0;
  const failedSymbols: string[] = [];

  for (const symbol of symbols) {
    try {
      const latestMs = await getLatestStoredTime(symbol, interval);
      const latestStr = latestMs
        ? new Date(latestMs).toISOString().slice(0, 16)
        : "none";
      console.log(`[fetch-klines] Fetching ${symbol} (latest stored: ${latestStr})`);

      const candles = await fetchAllKlines(symbol, interval, years, latestMs);

      if (candles.length > 0) {
        await upsertCandles(symbol, interval, candles);
      }

      totalCandles += candles.length;
      console.log(`[fetch-klines] ${symbol}: ${candles.length} candles upserted`);
    } catch (err) {
      console.error(`[fetch-klines] ${symbol} failed:`, err);
      failedSymbols.push(symbol);
    }
  }

  console.log(
    `[fetch-klines] Done. ${totalCandles} candles across ${symbols.length} symbols`
  );

  if (failedSymbols.length > 0) {
    console.error(
      `[fetch-klines] Failed symbols (${failedSymbols.length}): ${failedSymbols.join(",")}`
    );
    console.error(
      `[fetch-klines] Re-run with: --symbols ${failedSymbols.join(",")}`
    );
  }
}

main().catch((err) => {
  console.error("[fetch-klines] Fatal:", err);
  process.exit(1);
});
