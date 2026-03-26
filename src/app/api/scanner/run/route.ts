import { NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { getRedis, ALERTS_QUEUE_KEY } from "@/lib/redis";
import { fetchKlines, Kline } from "@/lib/bybit";
import { runPipeline, AlertPayload } from "@/lib/pipeline";
import { computeIndicators, detectSignals, detectSignalsWithParams, evaluateNearMisses, NearMissResult, DEFAULT_SIGNAL_PARAMS } from "@/lib/signals";
import { runGateBRelaxed, isShadowCooldownActive, setShadowCooldown } from "@/lib/shadow-relaxed";
import { runGateB } from "@/lib/gate-b";
import { computeHTFTrend } from "@/lib/ta";
import { classifyRegime } from "@/lib/regime";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const LOCK_KEY = "scanner:lock";
const LOCK_TTL = 600; // 10 minutes — prevents overlap for hourly cron
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
    let symbolsEvaluated = 0;

    // ── Near-miss aggregation (in-memory, one write at end) ──
    const passCountHist: Record<string, Record<string, number>> = {};
    const condFailCounts: Record<string, Record<string, number>> = {};
    const condPassCounts: Record<string, Record<string, number>> = {};
    const firstFailCounts: Record<string, Record<string, number>> = {};
    const metricSamples: Record<string, number[]> = {
      adx_1h: [], adx_4h: [], rsi: [], z_score: [],
      volume_sma_ratio: [], bb_width_ratio: [],
    };
    // Track best near-miss per setup (highest pass_count < total)
    const bestNearMiss: Record<string, { symbol: string; passed: number; total: number; first_fail: string | null; metrics: Record<string, number> }> = {};

    const accumulateNearMiss = (symbol: string, nm: NearMissResult, ind: { rsi: number; adx_1h: number; adx_4h: number; z_score: number; volume: number; sma20_volume: number; bb_width_ratio: number }) => {
      const st = nm.setup_type;
      // Pass count histogram
      if (!passCountHist[st]) passCountHist[st] = {};
      const key = String(nm.passed_count);
      passCountHist[st][key] = (passCountHist[st][key] || 0) + 1;

      // Per-condition fail/pass counts
      if (!condFailCounts[st]) condFailCounts[st] = {};
      if (!condPassCounts[st]) condPassCounts[st] = {};
      for (const c of nm.conditions) {
        if (c.passed) {
          condPassCounts[st][c.name] = (condPassCounts[st][c.name] || 0) + 1;
        } else {
          condFailCounts[st][c.name] = (condFailCounts[st][c.name] || 0) + 1;
        }
      }

      // First-fail counts
      if (nm.first_fail) {
        if (!firstFailCounts[st]) firstFailCounts[st] = {};
        firstFailCounts[st][nm.first_fail] = (firstFailCounts[st][nm.first_fail] || 0) + 1;
      }

      // Best near-miss tracking
      if (nm.passed_count < nm.total_count) {
        if (!bestNearMiss[st] || nm.passed_count > bestNearMiss[st].passed) {
          bestNearMiss[st] = {
            symbol,
            passed: nm.passed_count,
            total: nm.total_count,
            first_fail: nm.first_fail,
            metrics: {
              rsi: round2(ind.rsi),
              adx_1h: round2(ind.adx_1h),
              adx_4h: round2(ind.adx_4h),
              z_score: round2(ind.z_score),
              volume_sma_ratio: round2(ind.sma20_volume > 0 ? ind.volume / ind.sma20_volume : 0),
              bb_width_ratio: round4(ind.bb_width_ratio),
            },
          };
        }
      }
    };

    const round2 = (n: number): number => Math.round(n * 100) / 100;
    const round4 = (n: number): number => Math.round(n * 10000) / 10000;

    const hourBucket = currentHourBucket();
    const fourHBucket = current4hBucket();
    const dayBucket = currentDayBucket();

    console.log(`[scanner] Started at ${new Date().toISOString()} | 1H bucket=${new Date(hourBucket).toISOString()} | symbols=${symbols.length}`);

    // 3-7. Process symbols with concurrency limit
    await runWithConcurrency(symbols, MAX_CONCURRENT, async (symbol) => {
      let candles1h: Kline[], candles4h: Kline[], candles1d: Kline[];
      try {
        [candles1h, candles4h, candles1d] = await Promise.all([
          fetchKlinesRetry(symbol, "60", 150),
          fetchKlinesRetry(symbol, "240", 60),
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

      // 5b. Near-miss evaluation (pure computation, no I/O)
      symbolsEvaluated++;
      const nearMisses = evaluateNearMisses(indicators);
      for (const nm of nearMisses) {
        accumulateNearMiss(symbol, nm, indicators);
      }
      // Collect metric samples (once per symbol, not per setup)
      metricSamples.adx_1h.push(indicators.adx_1h);
      metricSamples.adx_4h.push(indicators.adx_4h);
      metricSamples.rsi.push(indicators.rsi);
      metricSamples.z_score.push(indicators.z_score);
      metricSamples.volume_sma_ratio.push(indicators.sma20_volume > 0 ? indicators.volume / indicators.sma20_volume : 0);
      metricSamples.bb_width_ratio.push(indicators.bb_width_ratio);

      // 5c. SQ shadow comparisons
      // Run all shadow variants from the same indicators, before production detection.
      const candleTimeIso = new Date(indicators.candle_start_time).toISOString();
      const baselineSigs = detectSignals(symbol, indicators);

      // Shadow 1: ADX threshold (strict=15 vs production=30)
      const sqAdxStrictParams = { ...DEFAULT_SIGNAL_PARAMS, sq_adx_1h_max: 15 };
      const adxStrictSigs = detectSignalsWithParams(symbol, indicators, sqAdxStrictParams);
      const baselineSQ_adx = baselineSigs.some(s => s.type === "SQ_SHORT");
      const strictSQ_adx = adxStrictSigs.some(s => s.type === "SQ_SHORT");

      if (baselineSQ_adx || strictSQ_adx) {
        const { error: sqAdxErr } = await supabase.from("shadow_signals").upsert({
          symbol, setup_type: "SQ_SHORT_ADX_SHADOW", candle_time: candleTimeIso,
          regime: "n/a", trend_4h: "n/a",
          rsi: indicators.rsi, adx_1h: indicators.adx_1h,
          volume: indicators.volume, sma20_volume: indicators.sma20_volume,
          close_price: indicators.close, atr_1h: indicators.atr_1h,
          baseline_pass: baselineSQ_adx,
          baseline_block_reason: baselineSQ_adx ? null : `adx_1h=${round2(indicators.adx_1h)} (prod threshold 30)`,
          relaxed_pass: strictSQ_adx,
          relaxed_block_reason: strictSQ_adx ? null : `adx_1h=${round2(indicators.adx_1h)} >= 15 (strict threshold)`,
          shadow_only: baselineSQ_adx && !strictSQ_adx,
          baseline_decision: null,
        }, { onConflict: "symbol,setup_type,candle_time" });
        if (sqAdxErr) console.error(`[scanner] SQ ADX shadow upsert failed for ${symbol}:`, sqAdxErr);
      }

      // Shadow 2: Trigger mode (event vs state, both with 1.5x volume)
      const sqStateParams = { ...DEFAULT_SIGNAL_PARAMS, sq_trigger_mode: "state" as const };
      const stateSigs = detectSignalsWithParams(symbol, indicators, sqStateParams);
      const eventSQ = baselineSigs.some(s => s.type === "SQ_SHORT");
      const stateSQ = stateSigs.some(s => s.type === "SQ_SHORT");

      if (eventSQ || stateSQ) {
        const volRatio = indicators.sma20_volume > 0 ? round2(indicators.volume / indicators.sma20_volume) : 0;
        const { error: sqTrigErr } = await supabase.from("shadow_signals").upsert({
          symbol, setup_type: "SQ_SHORT_TRIGGER_SHADOW", candle_time: candleTimeIso,
          regime: "n/a", trend_4h: "n/a",
          rsi: indicators.rsi, adx_1h: indicators.adx_1h,
          volume: indicators.volume, sma20_volume: indicators.sma20_volume,
          close_price: indicators.close, atr_1h: indicators.atr_1h,
          baseline_pass: eventSQ,
          baseline_block_reason: eventSQ ? null : "event trigger not met",
          relaxed_pass: stateSQ,
          relaxed_block_reason: stateSQ ? null : `state trigger not met (rsi=${round2(indicators.rsi)}, vol_ratio=${volRatio})`,
          shadow_only: stateSQ && !eventSQ,
          baseline_decision: null,
        }, { onConflict: "symbol,setup_type,candle_time" });
        if (sqTrigErr) console.error(`[scanner] SQ trigger shadow upsert failed for ${symbol}:`, sqTrigErr);
      }

      // Shadow 3: Hybrid candidate (state trigger + 1.5x vol, no distance filter at detection)
      // Records 4H distance as metadata so the status endpoint can bucket by distance threshold.
      // Uses state trigger with 0% distance to maximize signal capture, then filters in analysis.
      const sqHybridParams = { ...DEFAULT_SIGNAL_PARAMS, sq_trigger_mode: "state" as const, sq_4h_distance_pct: 0 };
      const hybridSigs = detectSignalsWithParams(symbol, indicators, sqHybridParams);
      const prodSQ = baselineSigs.some(s => s.type === "SQ_SHORT");
      const hybridSQ = hybridSigs.some(s => s.type === "SQ_SHORT");

      if (prodSQ || hybridSQ) {
        const dist4hPct = indicators.ema50_4h > 0
          ? round2((indicators.ema50_4h - indicators.close_4h) / indicators.ema50_4h * 100)
          : 0;
        const volRatio = indicators.sma20_volume > 0 ? round2(indicators.volume / indicators.sma20_volume) : 0;
        const { error: sqHybridErr } = await supabase.from("shadow_signals").upsert({
          symbol, setup_type: "SQ_SHORT_HYBRID_SHADOW", candle_time: candleTimeIso,
          regime: `dist4h=${dist4hPct}%`, trend_4h: "n/a",
          rsi: indicators.rsi, adx_1h: indicators.adx_1h,
          volume: indicators.volume, sma20_volume: indicators.sma20_volume,
          close_price: indicators.close, atr_1h: indicators.atr_1h,
          baseline_pass: prodSQ,
          baseline_block_reason: prodSQ ? null : "event trigger not met",
          relaxed_pass: hybridSQ,
          relaxed_block_reason: hybridSQ ? null : `state trigger not met (rsi=${round2(indicators.rsi)}, vol_ratio=${volRatio}, dist4h=${dist4hPct}%)`,
          shadow_only: hybridSQ && !prodSQ,
          baseline_decision: null,
        }, { onConflict: "symbol,setup_type,candle_time" });
        if (sqHybridErr) console.error(`[scanner] SQ hybrid shadow upsert failed for ${symbol}:`, sqHybridErr);
      }

      // 6. Detect signals (production path — unchanged)
      const signals = baselineSigs;
      if (signals.length === 0) return;

      candidatesFound += signals.length;

      // ── Shadow evaluation: compute once per symbol ──────
      // Get HTF trend and regime for shadow Gate B evaluation.
      // These are the same values the pipeline will compute
      // independently — we compute them here to avoid an extra
      // fetch, and to evaluate shadow BEFORE baseline cooldown
      // filters (which may skip signals the relaxed path accepts).
      let shadowTrend4h = "neutral";
      let shadowRegime = "sideways";
      const shadowMarkPrice = indicators.close;
      let shadowAtr1h = 0;
      const shadowRrTp1 = 1.5;
      try {
        const trend4hResult = computeHTFTrend(candles4h);
        shadowTrend4h = trend4hResult.trend;
        shadowAtr1h = indicators.atr_1h;
        const regimeResult = await classifyRegime();
        shadowRegime = regimeResult.btc_regime;
      } catch {
        // If HTF/regime fetch fails, shadow uses defaults (sideways/neutral)
        // Baseline pipeline handles its own errors independently
      }

      for (const sig of signals) {
        // ── Shadow: evaluate relaxed variant for EVERY signal ─
        // This runs before baseline cooldown/idempotency checks.
        // Shadow never affects production behavior.
        const candleTime = new Date(indicators.candle_start_time).toISOString();

        // Shadow baseline Gate B (same as production, for comparison logging)
        const shadowBaselineGateB = runGateB({
          alertType: sig.type,
          trend4h: shadowTrend4h as "bullish" | "bearish" | "neutral",
          btcRegime: shadowRegime as "bull" | "bear" | "sideways",
          atr1h: shadowAtr1h,
          markPrice: shadowMarkPrice,
          rrTp1: shadowRrTp1,
          rsi: indicators.rsi,
          adx1h: indicators.adx_1h,
          volume: indicators.volume,
          sma20Volume: indicators.sma20_volume,
        });

        // Shadow baseline cooldown check (reads production cooldown keys)
        const baselineCooldownActive = await redis.get(`cooldown:${symbol}:${sig.type}`) !== null;
        const baselinePass = shadowBaselineGateB.passed && !baselineCooldownActive;
        const baselineBlockReason = !shadowBaselineGateB.passed
          ? shadowBaselineGateB.reason
          : baselineCooldownActive
            ? "Cooldown active (8h)"
            : null;

        // Shadow relaxed Gate B
        const shadowRelaxedGateB = runGateBRelaxed({
          alertType: sig.type,
          trend4h: shadowTrend4h as "bullish" | "bearish" | "neutral",
          btcRegime: shadowRegime as "bull" | "bear" | "sideways",
          atr1h: shadowAtr1h,
          markPrice: shadowMarkPrice,
          rrTp1: shadowRrTp1,
          rsi: indicators.rsi,
          adx1h: indicators.adx_1h,
          volume: indicators.volume,
          sma20Volume: indicators.sma20_volume,
        });

        // Shadow relaxed cooldown (separate Redis namespace, 4h TTL)
        const relaxedCooldownActive = await isShadowCooldownActive(symbol, sig.type);
        const relaxedPass = shadowRelaxedGateB.passed && !relaxedCooldownActive;
        const relaxedBlockReason = !shadowRelaxedGateB.passed
          ? shadowRelaxedGateB.reason
          : relaxedCooldownActive
            ? "Shadow cooldown active (4h)"
            : null;

        // Set shadow cooldown if relaxed passes (does NOT affect production)
        if (relaxedPass) {
          await setShadowCooldown(symbol, sig.type);
        }

        // Store shadow comparison row
        const { error: shadowUpsertError } = await supabase.from("shadow_signals").upsert({
          symbol,
          setup_type: sig.type,
          candle_time: candleTime,
          regime: shadowRegime,
          trend_4h: shadowTrend4h,
          rsi: indicators.rsi,
          adx_1h: indicators.adx_1h,
          volume: indicators.volume,
          sma20_volume: indicators.sma20_volume,
          close_price: indicators.close,
          atr_1h: indicators.atr_1h,
          baseline_pass: baselinePass,
          baseline_block_reason: baselineBlockReason,
          relaxed_pass: relaxedPass,
          relaxed_block_reason: relaxedBlockReason,
          shadow_only: relaxedPass && !baselinePass,
        }, { onConflict: "symbol,setup_type,candle_time" });
        if (shadowUpsertError) {
          console.error(`[scanner] shadow_signals upsert failed for ${symbol} ${sig.type}:`, shadowUpsertError);
        }

        // 7a. Cooldown check (PRODUCTION — unchanged)
        const cooldownKey = `cooldown:${symbol}:${sig.type}`;
        const cooldownExists = await redis.get(cooldownKey);
        if (cooldownExists) {
          skippedCooldown++;
          continue;
        }

        // 7b. Idempotency check: have we already processed this candle?
        // Uses SELECT first. The actual idempotency insert happens AFTER
        // a successful pipeline trade decision, to avoid consuming the
        // signal if the pipeline fails or Claude blocks it.
        const { data: existing } = await supabase
          .from("candle_signals")
          .select("id")
          .eq("symbol", symbol)
          .eq("setup_type", sig.type)
          .eq("candle_start_time", candleTime)
          .limit(1)
          .maybeSingle();

        if (existing) {
          skippedIdempotency++;
          continue;
        }

        // Build alert payload (PRODUCTION — unchanged)
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
        const { data: rawRow, error: rawInsertError } = await supabase
          .from("alerts_raw")
          .insert({ payload: alertPayload })
          .select("id")
          .single();
        if (rawInsertError) {
          console.error(`[scanner] alerts_raw insert failed for ${symbol} ${sig.type}:`, rawInsertError);
        }

        // Push to Redis queue
        await redis.lpush(ALERTS_QUEUE_KEY, JSON.stringify(alertPayload));

        // Run pipeline inline (PRODUCTION — unchanged)
        const alertId = rawRow?.id ?? null;
        try {
          const result = await runPipeline(alertPayload, alertId);
          // Only set cooldown + record idempotency on tradable decision
          if (result.decision === "LONG" || result.decision === "SHORT") {
            await redis.set(cooldownKey, Date.now(), { ex: 8 * 60 * 60 });
            // Atomic idempotency insert (ON CONFLICT = already recorded by a parallel run)
            await supabase.from("candle_signals").upsert({
              symbol,
              setup_type: sig.type,
              candle_start_time: candleTime,
            }, { onConflict: "symbol,setup_type,candle_start_time", ignoreDuplicates: true });
            candidatesQueued++;
            console.log(`[scanner] Queued: ${symbol} ${sig.type} close=${indicators.close}`);
          }
          // Update shadow row with baseline final decision (includes Claude override)
          const { error: shadowUpdateError } = await supabase.from("shadow_signals")
            .update({ baseline_decision: result.decision })
            .eq("symbol", symbol)
            .eq("setup_type", sig.type)
            .eq("candle_time", candleTime);
          if (shadowUpdateError) {
            console.error(`[scanner] shadow_signals decision update failed for ${symbol} ${sig.type}:`, shadowUpdateError);
          }
        } catch (err) {
          console.error(`[scanner] Pipeline error for ${symbol} ${sig.type}:`, err);
        }
      }
    });

    const runtimeMs = Date.now() - startTime;

    // 9. Store scanner run
    const { error: runInsertError } = await supabase.from("scanner_runs").insert({
      completed_at: new Date().toISOString(),
      symbols_scanned: symbols.length,
      candidates_found: candidatesFound,
      candidates_queued: candidatesQueued,
      symbol_errors: symbolErrors,
      runtime_ms: runtimeMs,
      status: "completed",
    });
    if (runInsertError) {
      console.error("[scanner] scanner_runs insert failed:", runInsertError);
    }

    // 9b. Store near-miss diagnostics (one compact row per run)
    const percentiles = (arr: number[]): Record<string, number> => {
      if (arr.length === 0) return {};
      const sorted = [...arr].sort((a, b) => a - b);
      const p = (pct: number) => {
        const idx = Math.floor(pct / 100 * (sorted.length - 1));
        return round2(sorted[idx]);
      };
      return { min: round2(sorted[0]), p10: p(10), p25: p(25), p50: p(50), p75: p(75), p90: p(90), max: round2(sorted[sorted.length - 1]) };
    };

    const metricDist: Record<string, Record<string, number>> = {};
    for (const [metric, samples] of Object.entries(metricSamples)) {
      metricDist[metric] = percentiles(samples);
    }

    const bestNearMissArray = Object.entries(bestNearMiss).map(([setup_type, data]) => ({
      setup_type, ...data,
    }));

    if (symbolsEvaluated > 0) {
      const { error: nmInsertError } = await supabase.from("near_miss_scans").insert({
        candle_bucket: new Date(hourBucket).toISOString(),
        symbols_evaluated: symbolsEvaluated,
        pass_count_histograms: passCountHist,
        condition_fail_counts: condFailCounts,
        condition_pass_counts: condPassCounts,
        first_fail_counts: firstFailCounts,
        metric_distributions: metricDist,
        best_near_misses: bestNearMissArray,
      });
      if (nmInsertError) {
        console.error("[scanner] near_miss_scans insert failed:", nmInsertError);
      }
    }

    const summary = {
      started_at: new Date(startTime).toISOString(),
      completed_at: new Date().toISOString(),
      candle_bucket: new Date(hourBucket).toISOString(),
      scanned: symbols.length,
      candidates_found: candidatesFound,
      candidates_queued: candidatesQueued,
      skipped_cooldown: skippedCooldown,
      skipped_idempotency: skippedIdempotency,
      symbol_errors: symbolErrors.length > 0 ? symbolErrors : undefined,
      runtime_ms: runtimeMs,
    };

    console.log(`[scanner] Complete: ${candidatesQueued} queued, ${candidatesFound} found, ${symbols.length} scanned, ${runtimeMs}ms`);
    return NextResponse.json(summary);
  } finally {
    // 8. Release lock
    await redis.del(LOCK_KEY);
  }
}
