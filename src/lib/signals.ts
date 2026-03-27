import { Kline } from "./bybit";
import { RSI, BollingerBands, EMA, ATR, ADX, SMA } from "trading-signals";

// ── Indicator result ────────────────────────────────────

export interface SymbolIndicators {
  // 1H
  close: number;
  high: number;
  low: number;
  volume: number;
  prev_close: number;
  prev_rsi: number;
  rsi: number;
  bb_upper: number;
  bb_lower: number;
  bb_basis: number;
  prev_bb_basis: number;
  bb_width_ratio: number;
  bb_stdev: number;
  ema20: number;
  atr_1h: number;
  adx_1h: number;
  sma20_volume: number;
  z_score: number;
  close_off_low: number;
  close_off_high: number;
  bb_width_near_min: boolean;
  candle_range: number;
  // 4H
  close_4h: number;
  ema50_4h: number;
  adx_4h: number;
  // 1D
  ema50_1d: number | null;
  atr_1d: number;
  // metadata
  candle_start_time: number;
}

// ── Signal result ───────────────────────────────────────

export interface Signal {
  type: string;
  symbol: string;
  indicators: SymbolIndicators;
}

// ── Indicator computation ───────────────────────────────

export function computeIndicators(
  candles1h: Kline[],
  candles4h: Kline[],
  candles1d: Kline[]
): SymbolIndicators | null {
  if (candles1h.length < 30 || candles4h.length < 14 || candles1d.length < 14) {
    return null;
  }

  // ── 1H indicators ──
  const rsi = new RSI(14);
  const bb = new BollingerBands(20, 2.2);
  const ema20 = new EMA(20);
  const atr1h = new ATR(14);
  const adx1h = new ADX(14);
  const smaVol = new SMA(20);

  const bbWidths: number[] = [];

  for (const c of candles1h) {
    rsi.update(c.close, false);
    bb.update(c.close, false);
    ema20.update(c.close, false);
    atr1h.update({ high: c.high, low: c.low, close: c.close }, false);
    adx1h.update({ high: c.high, low: c.low, close: c.close }, false);
    smaVol.update(c.volume, false);

    if (bb.isStable) {
      const r = bb.getResult();
      if (r) {
        const basis = Number(r.middle);
        const width = basis > 0 ? (Number(r.upper) - Number(r.lower)) / basis : 0;
        bbWidths.push(width);
      }
    }
  }

  if (!rsi.isStable || !bb.isStable || !atr1h.isStable || !adx1h.isStable) {
    return null;
  }

  // Get second-to-last RSI and BB basis for crossover detection
  const tempRsi = new RSI(14);
  const tempBb = new BollingerBands(20, 2.2);
  for (let i = 0; i < candles1h.length - 1; i++) {
    tempRsi.update(candles1h[i].close, false);
    tempBb.update(candles1h[i].close, false);
  }
  let prevRsi = 50;
  if (tempRsi.isStable) {
    prevRsi = Number(tempRsi.getResult() ?? 50);
  }
  const prevClose = candles1h[candles1h.length - 2].close;

  const lastCandle = candles1h[candles1h.length - 1];
  const bbResult = bb.getResult()!;
  const bbUpper = Number(bbResult.upper);
  const bbLower = Number(bbResult.lower);
  const bbBasis = Number(bbResult.middle);
  const bbWidthRatio = bbBasis > 0 ? (bbUpper - bbLower) / bbBasis : 0;

  // Previous BB basis for crossover detection
  let prevBbBasis = bbBasis;
  if (tempBb.isStable) {
    const prevBbResult = tempBb.getResult();
    if (prevBbResult) prevBbBasis = Number(prevBbResult.middle);
  }

  // BB stdev from width
  const bbStdev = (bbUpper - bbBasis) / 2.2;

  // BB width percentile (near minimum of last 120)
  const recentWidths = bbWidths.slice(-120);
  const minWidth = Math.min(...recentWidths);
  const bbWidthNearMin = minWidth > 0
    ? bbWidthRatio <= minWidth * 1.15
    : false;

  const closeVal = lastCandle.close;
  const highVal = lastCandle.high;
  const lowVal = lastCandle.low;
  const range = highVal - lowVal;

  // ── 4H indicators ──
  const ema504h = new EMA(50);
  const adx4h = new ADX(14);
  for (const c of candles4h) {
    ema504h.update(c.close, false);
    adx4h.update({ high: c.high, low: c.low, close: c.close }, false);
  }

  if (!ema504h.isStable || !adx4h.isStable) return null;

  // ── 1D indicators ──
  const ema501d = new EMA(50);
  const atr1d = new ATR(14);
  for (const c of candles1d) {
    ema501d.update(c.close, false);
    atr1d.update({ high: c.high, low: c.low, close: c.close }, false);
  }

  const ema50_1d_val = ema501d.isStable ? Number(ema501d.getResult()!) : null;
  const atr_1d_val = atr1d.isStable ? Number(atr1d.getResult()!) : Number(atr1h.getResult()!) * 4;

  return {
    close: closeVal,
    high: highVal,
    low: lowVal,
    volume: lastCandle.volume,
    prev_close: prevClose,
    prev_rsi: prevRsi,
    rsi: Number(rsi.getResult()!),
    bb_upper: bbUpper,
    bb_lower: bbLower,
    bb_basis: bbBasis,
    prev_bb_basis: prevBbBasis,
    bb_width_ratio: bbWidthRatio,
    bb_stdev: bbStdev,
    ema20: Number(ema20.getResult()!),
    atr_1h: Number(atr1h.getResult()!),
    adx_1h: Number(adx1h.getResult()!),
    sma20_volume: Number(smaVol.getResult()!),
    z_score: bbStdev > 0 ? (closeVal - bbBasis) / bbStdev : 0,
    close_off_low: range > 0 ? (closeVal - lowVal) / range : 0,
    close_off_high: range > 0 ? (highVal - closeVal) / range : 0,
    bb_width_near_min: bbWidthNearMin,
    candle_range: range,
    close_4h: candles4h[candles4h.length - 1].close,
    ema50_4h: Number(ema504h.getResult()!),
    adx_4h: Number(adx4h.getResult()!),
    ema50_1d: ema50_1d_val,
    atr_1d: atr_1d_val,
    candle_start_time: lastCandle.startTime,
  };
}

// ── Signal params (backtest-tunable) ────────────────────

export interface SignalParams {
  mr_adx_1h_max: number;
  mr_adx_4h_max: number;
  sq_adx_1h_max: number;
  /** "event" = production crossover logic, "state" = relaxed state-based logic */
  sq_trigger_mode: "event" | "state";
  /** SQ volume multiplier vs SMA20. Production = 1.5 */
  sq_volume_mult: number;
  /** Minimum % below EMA50 on 4H for SQ_SHORT. 0 = any amount below (production). 2 = at least 2% below. */
  sq_4h_distance_pct: number;
}

export const DEFAULT_SIGNAL_PARAMS: SignalParams = {
  mr_adx_1h_max: 18,
  mr_adx_4h_max: 22,
  sq_adx_1h_max: 30,
  sq_trigger_mode: "state",  // promoted from "event" — increases SQ signal throughput
  sq_volume_mult: 1.0,      // loosened from 1.5 for data collection (no real capital at risk)
  sq_4h_distance_pct: 0,
};

// ── Tiered signal types ─────────────────────────────────

export type SignalTier = "STRICT_PROD" | "RELAXED_PROD" | "DATA_ONLY";

export interface TieredSignal extends Signal {
  tier: SignalTier;
  pass_count: number;
  total_conditions: number;
  failed_conditions: string[];
  priority: boolean;
}

// ── Signal conditions ───────────────────────────────────

/**
 * Production detector — uses hardcoded default thresholds.
 * Called by the live scanner. Do NOT modify thresholds here.
 */
export function detectSignals(symbol: string, ind: SymbolIndicators): Signal[] {
  return detectSignalsWithParams(symbol, ind, DEFAULT_SIGNAL_PARAMS);
}

/**
 * Tiered detector for data-collection mode.
 * Evaluates all conditions individually, assigns tiers by pass_count.
 * - STRICT_PROD: all conditions pass (full rule set)
 * - RELAXED_PROD: pass_count >= threshold (default 6)
 * - DATA_ONLY: pass_count >= threshold (default 5)
 */
export function detectSignalsTiered(
  symbol: string,
  ind: SymbolIndicators,
  params: SignalParams,
  opts: { relaxed_min?: number; data_min?: number; low_flow?: boolean } = {}
): TieredSignal[] {
  const relaxedMin = opts.low_flow ? 5 : (opts.relaxed_min ?? 6);
  const dataMin = opts.data_min ?? 5;
  const results: TieredSignal[] = [];

  // ── SQ_SHORT condition evaluation ──────────────────
  const sqBasis = params.sq_trigger_mode === "event"
    ? (ind.prev_close >= ind.prev_bb_basis && ind.close < ind.bb_basis)
    : (ind.close < ind.bb_basis);
  const sqRsi = params.sq_trigger_mode === "event"
    ? (ind.prev_rsi >= 48 && ind.rsi < 48)
    : (ind.rsi < 48);
  const sqVolMult = opts.low_flow ? 0.8 : params.sq_volume_mult;
  const sqBbWidth = opts.low_flow ? 0.15 : 0.12;

  const sqConditions: { name: string; passed: boolean }[] = [
    { name: "bb_width", passed: ind.bb_width_ratio < sqBbWidth },
    { name: "basis_trigger", passed: sqBasis },
    { name: "close_lt_ema20", passed: ind.close < ind.ema20 },
    { name: "rsi_trigger", passed: sqRsi },
    { name: "volume", passed: ind.volume > ind.sma20_volume * sqVolMult },
    { name: "adx_1h", passed: ind.adx_1h < params.sq_adx_1h_max },
    { name: "close_4h_lt_ema50", passed: ind.close_4h < ind.ema50_4h },
    { name: "range_vs_atr", passed: ind.candle_range < ind.atr_1h * 2.2 },
    { name: "close_near_ema20", passed: Math.abs(ind.close - ind.ema20) < ind.atr_1h * 1.5 },
  ];

  const sqPassed = sqConditions.filter(c => c.passed).length;
  const sqFailed = sqConditions.filter(c => !c.passed).map(c => c.name);
  const sqTotal = sqConditions.length;

  if (sqPassed >= dataMin) {
    let tier: SignalTier;
    let typeSuffix = "";
    if (sqPassed === sqTotal) {
      tier = "STRICT_PROD";
    } else if (sqPassed >= relaxedMin) {
      tier = "RELAXED_PROD";
      typeSuffix = "_RELAXED";
    } else {
      tier = "DATA_ONLY";
      typeSuffix = "_DATA";
    }

    results.push({
      type: `SQ_SHORT${typeSuffix}`,
      symbol,
      indicators: ind,
      tier,
      pass_count: sqPassed,
      total_conditions: sqTotal,
      failed_conditions: sqFailed,
      priority: sqPassed >= 7,
    });
  }

  // ── MR_LONG (strict only — no tiering for MR) ─────
  const strictSignals = detectSignalsWithParams(symbol, ind, params);
  for (const sig of strictSignals) {
    if (sig.type === "MR_LONG" || sig.type === "MR_SHORT") {
      results.push({
        ...sig,
        tier: "STRICT_PROD",
        pass_count: sig.type === "MR_LONG" ? 8 : 8,
        total_conditions: 8,
        failed_conditions: [],
        priority: true,
      });
    }
  }

  return results;
}

/**
 * Parameterized detector — for backtest use only.
 * Allows overriding MR ADX thresholds without touching production.
 */
export function detectSignalsWithParams(
  symbol: string,
  ind: SymbolIndicators,
  params: SignalParams
): Signal[] {
  const signals: Signal[] = [];

  // MR_LONG
  if (
    ind.close < ind.bb_lower &&
    ind.rsi < 29 &&
    ind.z_score < -2.0 &&
    ind.close_off_low >= 0.25 &&
    ind.volume > ind.sma20_volume * 1.2 &&
    ind.adx_1h < params.mr_adx_1h_max &&
    ind.adx_4h < params.mr_adx_4h_max &&
    (ind.ema50_1d === null || ind.close > ind.ema50_1d - 2.2 * ind.atr_1d)
  ) {
    signals.push({ type: "MR_LONG", symbol, indicators: ind });
  }

  // MR_SHORT
  if (
    ind.close > ind.bb_upper &&
    ind.rsi > 71 &&
    ind.z_score > 2.0 &&
    ind.close_off_high >= 0.25 &&
    ind.volume > ind.sma20_volume * 1.2 &&
    ind.adx_1h < params.mr_adx_1h_max &&
    ind.adx_4h < params.mr_adx_4h_max &&
    (ind.ema50_1d === null || ind.close < ind.ema50_1d + 2.2 * ind.atr_1d)
  ) {
    signals.push({ type: "MR_SHORT", symbol, indicators: ind });
  }

  // SQ_LONG — disabled: 20% win rate, -0.20R avg over 41-day backtest

  // SQ_SHORT
  // Event mode (production): requires candle-to-candle crossovers + strong volume
  // State mode (backtest candidate): requires current state below thresholds + moderate volume
  const sqBasis = params.sq_trigger_mode === "event"
    ? (ind.prev_close >= ind.prev_bb_basis && ind.close < ind.bb_basis)
    : (ind.close < ind.bb_basis);
  const sqRsi = params.sq_trigger_mode === "event"
    ? (ind.prev_rsi >= 48 && ind.rsi < 48)
    : (ind.rsi < 48);
  const sqVolume = ind.volume > ind.sma20_volume * params.sq_volume_mult;

  if (
    ind.bb_width_ratio < 0.12 &&  // loosened from 0.08 for data collection
    sqBasis &&
    ind.close < ind.ema20 &&
    sqRsi &&
    sqVolume &&
    ind.adx_1h < params.sq_adx_1h_max &&
    ind.close_4h < ind.ema50_4h &&
    (params.sq_4h_distance_pct === 0 || (ind.ema50_4h > 0 && (ind.ema50_4h - ind.close_4h) / ind.ema50_4h * 100 >= params.sq_4h_distance_pct)) &&
    ind.candle_range < ind.atr_1h * 2.2 &&
    Math.abs(ind.close - ind.ema20) < ind.atr_1h * 1.5
  ) {
    signals.push({ type: "SQ_SHORT", symbol, indicators: ind });
  }

  return signals;
}

// ── Near-miss condition evaluation ────────────────────

export interface ConditionResult {
  name: string;
  passed: boolean;
  actual: number;
  threshold: number;
  /** "lt" = actual must be < threshold, "gt" = actual must be > threshold, etc. */
  op: "lt" | "gt" | "gte" | "lte";
}

export interface NearMissResult {
  setup_type: string;
  conditions: ConditionResult[];
  passed_count: number;
  total_count: number;
  /** The first failing condition (most setups short-circuit, so this is the "blocking" one) */
  first_fail: string | null;
}

/**
 * Evaluates every individual condition for all enabled setups,
 * without short-circuiting. Returns per-condition pass/fail
 * with actual vs threshold values.
 *
 * Pure function — no side effects, no DB calls.
 */
export function evaluateNearMisses(ind: SymbolIndicators): NearMissResult[] {
  const results: NearMissResult[] = [];

  // ── MR_LONG ──
  const mrLongConds: ConditionResult[] = [
    { name: "close_below_bb_lower", passed: ind.close < ind.bb_lower, actual: ind.close, threshold: ind.bb_lower, op: "lt" },
    { name: "rsi_lt_29", passed: ind.rsi < 29, actual: ind.rsi, threshold: 29, op: "lt" },
    { name: "z_score_lt_neg2", passed: ind.z_score < -2.0, actual: ind.z_score, threshold: -2.0, op: "lt" },
    { name: "close_off_low_gte_0.25", passed: ind.close_off_low >= 0.25, actual: ind.close_off_low, threshold: 0.25, op: "gte" },
    { name: "volume_gt_1.2x_sma", passed: ind.volume > ind.sma20_volume * 1.2, actual: ind.sma20_volume > 0 ? ind.volume / ind.sma20_volume : 0, threshold: 1.2, op: "gt" },
    { name: "adx_1h_lt_18", passed: ind.adx_1h < 18, actual: ind.adx_1h, threshold: 18, op: "lt" },
    { name: "adx_4h_lt_22", passed: ind.adx_4h < 22, actual: ind.adx_4h, threshold: 22, op: "lt" },
    { name: "above_1d_floor", passed: ind.ema50_1d === null || ind.close > ind.ema50_1d - 2.2 * ind.atr_1d, actual: ind.close, threshold: ind.ema50_1d !== null ? ind.ema50_1d - 2.2 * ind.atr_1d : 0, op: "gt" },
  ];
  const mrLongPassed = mrLongConds.filter(c => c.passed).length;
  results.push({
    setup_type: "MR_LONG",
    conditions: mrLongConds,
    passed_count: mrLongPassed,
    total_count: mrLongConds.length,
    first_fail: mrLongConds.find(c => !c.passed)?.name ?? null,
  });

  // ── MR_SHORT ──
  const mrShortConds: ConditionResult[] = [
    { name: "close_above_bb_upper", passed: ind.close > ind.bb_upper, actual: ind.close, threshold: ind.bb_upper, op: "gt" },
    { name: "rsi_gt_71", passed: ind.rsi > 71, actual: ind.rsi, threshold: 71, op: "gt" },
    { name: "z_score_gt_2", passed: ind.z_score > 2.0, actual: ind.z_score, threshold: 2.0, op: "gt" },
    { name: "close_off_high_gte_0.25", passed: ind.close_off_high >= 0.25, actual: ind.close_off_high, threshold: 0.25, op: "gte" },
    { name: "volume_gt_1.2x_sma", passed: ind.volume > ind.sma20_volume * 1.2, actual: ind.sma20_volume > 0 ? ind.volume / ind.sma20_volume : 0, threshold: 1.2, op: "gt" },
    { name: "adx_1h_lt_18", passed: ind.adx_1h < 18, actual: ind.adx_1h, threshold: 18, op: "lt" },
    { name: "adx_4h_lt_22", passed: ind.adx_4h < 22, actual: ind.adx_4h, threshold: 22, op: "lt" },
    { name: "below_1d_ceiling", passed: ind.ema50_1d === null || ind.close < ind.ema50_1d + 2.2 * ind.atr_1d, actual: ind.close, threshold: ind.ema50_1d !== null ? ind.ema50_1d + 2.2 * ind.atr_1d : Infinity, op: "lt" },
  ];
  const mrShortPassed = mrShortConds.filter(c => c.passed).length;
  results.push({
    setup_type: "MR_SHORT",
    conditions: mrShortConds,
    passed_count: mrShortPassed,
    total_count: mrShortConds.length,
    first_fail: mrShortConds.find(c => !c.passed)?.name ?? null,
  });

  // ── SQ_SHORT ──
  const crossedBelowBasis = ind.prev_close >= ind.prev_bb_basis && ind.close < ind.bb_basis;
  const rsiCrossedBelow48 = ind.prev_rsi >= 48 && ind.rsi < 48;
  const sqShortConds: ConditionResult[] = [
    { name: "bb_width_lt_0.12", passed: ind.bb_width_ratio < 0.12, actual: ind.bb_width_ratio, threshold: 0.12, op: "lt" },
    { name: "crossed_below_basis", passed: crossedBelowBasis, actual: ind.close - ind.bb_basis, threshold: 0, op: "lt" },
    { name: "close_lt_ema20", passed: ind.close < ind.ema20, actual: ind.close, threshold: ind.ema20, op: "lt" },
    { name: "rsi_crossed_below_48", passed: rsiCrossedBelow48, actual: ind.rsi, threshold: 48, op: "lt" },
    { name: "volume_gt_1.5x_sma", passed: ind.volume > ind.sma20_volume * 1.5, actual: ind.sma20_volume > 0 ? ind.volume / ind.sma20_volume : 0, threshold: 1.5, op: "gt" },
    { name: `adx_1h_lt_${DEFAULT_SIGNAL_PARAMS.sq_adx_1h_max}`, passed: ind.adx_1h < DEFAULT_SIGNAL_PARAMS.sq_adx_1h_max, actual: ind.adx_1h, threshold: DEFAULT_SIGNAL_PARAMS.sq_adx_1h_max, op: "lt" },
    { name: "close_4h_lt_ema50_4h", passed: ind.close_4h < ind.ema50_4h, actual: ind.close_4h, threshold: ind.ema50_4h, op: "lt" },
    { name: "range_lt_2.2x_atr", passed: ind.candle_range < ind.atr_1h * 2.2, actual: ind.atr_1h > 0 ? ind.candle_range / ind.atr_1h : 0, threshold: 2.2, op: "lt" },
    { name: "close_near_ema20", passed: Math.abs(ind.close - ind.ema20) < ind.atr_1h * 1.5, actual: ind.atr_1h > 0 ? Math.abs(ind.close - ind.ema20) / ind.atr_1h : 0, threshold: 1.5, op: "lt" },
  ];
  const sqShortPassed = sqShortConds.filter(c => c.passed).length;
  results.push({
    setup_type: "SQ_SHORT",
    conditions: sqShortConds,
    passed_count: sqShortPassed,
    total_count: sqShortConds.length,
    first_fail: sqShortConds.find(c => !c.passed)?.name ?? null,
  });

  return results;
}
