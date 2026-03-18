import { NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { getRedis, ALERTS_QUEUE_KEY } from "@/lib/redis";
import { fetchKlines, Kline } from "@/lib/bybit";
import { runPipeline, AlertPayload } from "@/lib/pipeline";
import { computeIndicators, detectSignals } from "@/lib/signals";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const LOCK_KEY = "scanner:lock";
const LOCK_TTL = 300;
const MAX_CONCURRENT = 8;

// ── Bucket helpers ──────────────────────────────────────

function currentHourBucket(): number {
  const now = new Date();
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), now.getUTCHours());
}

function current4hBucket(): number {
  const now = new Date();
  const h = Math.floor(now.getUTCHours() / 4) * 4;
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), h));
  return d.getTime();
}

function currentDayBucket(): number {
  const now = new Date();
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
}

function filterConfirmed(candles: Kline[], bucketStart: number): Kline[] {
  return candles.filter((c) => c.startTime < bucketStart);
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

// ── Fetch with retry ────────────────────────────────────

async function fetchKlinesRetry(
  symbol: string,
  interval: string,
  limit: number
): Promise<Kline[]> {
  try {
    return await fetchKlines(symbol, interval, limit);
  } catch {
    await new Promise((r) => setTimeout(r, 500));
    return fetchKlines(symbol, interval, limit);
  }
}

// ── Main handler ────────────────────────────────────────

export async function GET() {
  const startTime = Date.now();
  const redis = getRedis();
  const supabase = getSupabase();

  // 1. Acquire distributed lock
  const lockAcquired = await redis.set(LOCK_KEY, Date.now(), { nx: true, ex: LOCK_TTL });
  if (!lockAcquired) {
    return NextResponse.json({ status: "skipped_overlap" });
  }

  try {
    // 2. Read eligible symbols
    const { data: universeRows, error: uniError } = await supabase
      .from("universe")
      .select("symbol")
      .eq("is_eligible", true)
      .order("symbol");

    if (uniError || !universeRows) {
      return NextResponse.json({ error: "Failed to read universe" }, { status: 500 });
    }

    const symbols = universeRows.map((r) => r.symbol);
    const symbolErrors: { symbol: string; error: string }[] = [];
    let candidatesFound = 0;
    let candidatesQueued = 0;
    let skippedCooldown = 0;
    let skippedIdempotency = 0;

    const hourBucket = currentHourBucket();
    const fourHBucket = current4hBucket();
    const dayBucket = currentDayBucket();

    // 3-7. Process symbols with concurrency limit
    await runWithConcurrency(symbols, MAX_CONCURRENT, async (symbol) => {
      let candles1h: Kline[], candles4h: Kline[], candles1d: Kline[];
      try {
        [candles1h, candles4h, candles1d] = await Promise.all([
          fetchKlinesRetry(symbol, "60", 150),
          fetchKlinesRetry(symbol, "240", 50),
          fetchKlinesRetry(symbol, "D", 60),
        ]);
      } catch (err) {
        symbolErrors.push({ symbol, error: String(err) });
        return;
      }

      // 4. Filter to confirmed closed candles only
      candles1h = filterConfirmed(candles1h, hourBucket);
      candles4h = filterConfirmed(candles4h, fourHBucket);
      candles1d = filterConfirmed(candles1d, dayBucket);

      if (candles1h.length < 30) return;

      // 5. Calculate indicators
      const indicators = computeIndicators(candles1h, candles4h, candles1d);
      if (!indicators) return;

      // 6. Detect signals
      const signals = detectSignals(symbol, indicators);
      if (signals.length === 0) return;

      candidatesFound += signals.length;

      for (const sig of signals) {
        // 7a. Cooldown check
        const cooldownKey = `cooldown:${symbol}:${sig.type}`;
        const cooldownExists = await redis.get(cooldownKey);
        if (cooldownExists) {
          skippedCooldown++;
          continue;
        }

        // 7b. Idempotency check
        const candleTime = new Date(indicators.candle_start_time).toISOString();
        const { data: existing } = await supabase
          .from("candle_signals")
          .select("id")
          .eq("symbol", symbol)
          .eq("setup_type", sig.type)
          .eq("candle_start_time", candleTime)
          .limit(1)
          .single();

        if (existing) {
          skippedIdempotency++;
          continue;
        }

        // Build alert payload
        const alertPayload: AlertPayload = {
          type: sig.type,
          symbol,
          tf: "1H",
          price: indicators.close,
          rsi: indicators.rsi,
          adx1h: indicators.adx_1h,
          adx4h: indicators.adx_4h,
          bb_width: indicators.bb_width_ratio,
          volume: indicators.volume,
          sma20_volume: indicators.sma20_volume,
        };

        // Store in alerts_raw
        const { data: rawRow } = await supabase
          .from("alerts_raw")
          .insert({ payload: alertPayload })
          .select("id")
          .single();

        // Push to Redis queue
        await redis.lpush(ALERTS_QUEUE_KEY, JSON.stringify(alertPayload));

        // Run pipeline inline
        const alertId = rawRow?.id ?? null;
        try {
          const result = await runPipeline(alertPayload, alertId);
          // Only set cooldown and record idempotency on tradable decision
          if (result.decision === "LONG" || result.decision === "SHORT") {
            await redis.set(cooldownKey, Date.now(), { ex: 8 * 60 * 60 });
            await supabase.from("candle_signals").insert({
              symbol,
              setup_type: sig.type,
              candle_start_time: candleTime,
            });
            candidatesQueued++;
            console.log(`[scanner] Queued: ${symbol} ${sig.type} close=${indicators.close}`);
          }
        } catch (err) {
          console.error(`[scanner] Pipeline error for ${symbol} ${sig.type}:`, err);
        }
      }
    });

    const runtimeMs = Date.now() - startTime;

    // 9. Store scanner run
    await supabase.from("scanner_runs").insert({
      completed_at: new Date().toISOString(),
      symbols_scanned: symbols.length,
      candidates_found: candidatesFound,
      candidates_queued: candidatesQueued,
      symbol_errors: symbolErrors,
      runtime_ms: runtimeMs,
      status: "completed",
    });

    const summary = {
      scanned: symbols.length,
      candidates_found: candidatesFound,
      candidates_queued: candidatesQueued,
      skipped_cooldown: skippedCooldown,
      skipped_idempotency: skippedIdempotency,
      symbol_errors: symbolErrors,
      runtime_ms: runtimeMs,
    };

    console.log("[scanner] Complete:", JSON.stringify(summary));
    return NextResponse.json(summary);
  } finally {
    // 8. Release lock
    await redis.del(LOCK_KEY);
  }
}
