/**
 * Fetch historical klines from Bybit V5 API and upsert into candle_cache.
 *
 * Usage:
 *   npx tsx scripts/fetch-historical-klines.ts --symbols BTCUSDT,SOLUSDT --interval 60 --years 1
 *   npx tsx scripts/fetch-historical-klines.ts --symbols HYPEUSDT,ONTUSDT --interval 15 \
 *     --from 2026-03-27T00:00:00Z --to 2026-04-06T00:00:00Z --backfill-range
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
    if (match) {
      let value = match[2].trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      process.env[match[1].trim()] ??= value;
    }
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

interface CliArgs {
  symbols: string[];
  interval: string;
  years: number;
  fromMs: number | null;
  toMs: number | null;
  backfillRange: boolean;
}

// ── CLI arg parsing ───────────────────────────────────────

function parseIsoArg(value: string, flag: string): number {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) {
    console.error(`[fetch-klines] Invalid ${flag}: ${value}`);
    process.exit(1);
  }
  return ms;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  let symbols: string[] = [...ALL_SYMBOLS];
  let interval = "60";
  let years = 2;
  let fromMs: number | null = null;
  let toMs: number | null = null;
  let backfillRange = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--symbols" && args[i + 1]) {
      const val = args[++i];
      symbols = val === "all" ? [...ALL_SYMBOLS] : val.split(",");
    } else if (args[i] === "--interval" && args[i + 1]) {
      interval = args[++i];
    } else if (args[i] === "--years" && args[i + 1]) {
      years = Number(args[++i]);
    } else if (args[i] === "--from" && args[i + 1]) {
      fromMs = parseIsoArg(args[++i], "--from");
    } else if (args[i] === "--to" && args[i + 1]) {
      toMs = parseIsoArg(args[++i], "--to");
    } else if (args[i] === "--backfill-range") {
      backfillRange = true;
    }
  }

  if (backfillRange) {
    if (fromMs == null || toMs == null) {
      console.error("[fetch-klines] --backfill-range requires both --from and --to");
      process.exit(1);
    }
    if (toMs <= fromMs) {
      console.error("[fetch-klines] --to must be later than --from");
      process.exit(1);
    }
  }

  return { symbols, interval, years, fromMs, toMs, backfillRange };
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
  latestStoredMs: number | null,
  opts?: {
    fromMs?: number | null;
    toMs?: number | null;
    backfillRange?: boolean;
  }
): Promise<Candle[]> {
  const fromMs = opts?.fromMs ?? null;
  const toMs = opts?.toMs ?? null;
  const backfillRange = opts?.backfillRange === true;
  const cutoffMs =
    fromMs ?? Date.now() - years * 365.25 * 24 * 60 * 60 * 1000;
  let endMs = toMs ?? Date.now();
  let callCount = 0;
  const allCandles: Candle[] = [];

  while (true) {
    const page = await fetchKlinesPage(symbol, interval, endMs);
    if (page.length === 0) break;

    const filtered = page.filter((c) => {
      if (backfillRange) {
        if (fromMs != null && c.startTime < fromMs) return false;
        if (toMs != null && c.startTime > toMs) return false;
        return true;
      }
      return latestStoredMs ? c.startTime > latestStoredMs : true;
    });

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
  const { symbols, interval, years, fromMs, toMs, backfillRange } = parseArgs();
  console.log(backfillRange
    ? `[fetch-klines] ${symbols.length} symbols, interval=${interval}, range=${new Date(fromMs!).toISOString()} -> ${new Date(toMs!).toISOString()}`
    : `[fetch-klines] ${symbols.length} symbols, interval=${interval}, years=${years}`
  );

  let totalCandles = 0;
  const failedSymbols: string[] = [];

  for (const symbol of symbols) {
    try {
      const latestMs = await getLatestStoredTime(symbol, interval);
      const latestStr = latestMs
        ? new Date(latestMs).toISOString().slice(0, 16)
        : "none";
      console.log(
        backfillRange
          ? `[fetch-klines] Backfilling ${symbol} (${new Date(fromMs!).toISOString().slice(0, 10)} -> ${new Date(toMs!).toISOString().slice(0, 10)}, latest stored: ${latestStr})`
          : `[fetch-klines] Fetching ${symbol} (latest stored: ${latestStr})`
      );

      const candles = await fetchAllKlines(symbol, interval, years, latestMs, {
        fromMs,
        toMs,
        backfillRange,
      });

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
