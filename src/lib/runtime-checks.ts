import type { ExecSignalPayload } from "@/lib/exec-webhook";

const CURRENT_SIGNAL_LADDER_R = {
  tp1: 0.5,
  tp2: 1.0,
  tp3: 2.5,
} as const;

const LEGACY_SIGNAL_LADDER_R = {
  tp0: 0.5,
  tp1: 1.0,
  tp2: 2.5,
  tp3: 2.5,
} as const;

const RATIO_TOLERANCE = 0.15;

let configWarned = false;
const payloadWarnings = new Set<string>();

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function ratio(entry: number, level: number, risk: number): number {
  return risk > 0 ? Math.abs(level - entry) / risk : 0;
}

export function warnSignalRuntimeConfigOnce(): void {
  if (configWarned) return;
  configWarned = true;

  const warnings: string[] = [];

  if (!process.env.WEBHOOK_SECRET) {
    warnings.push("WEBHOOK_SECRET is not set; /api/alert relies on route-level auth config");
  }

  if (!process.env.CRON_SECRET) {
    warnings.push("CRON_SECRET is not set; scheduled/admin routes may be harder to protect consistently");
  }

  if (process.env.EXEC_WEBHOOK_URL && !process.env.EXEC_WEBHOOK_SECRET) {
    warnings.push("EXEC_WEBHOOK_URL is set without EXEC_WEBHOOK_SECRET; signal-to-exec auth is weaker than expected");
  }

  if (
    !process.env.CRON_SECRET &&
    !process.env.WEBHOOK_SECRET &&
    !process.env.EXEC_WEBHOOK_SECRET
  ) {
    warnings.push("no admin secret is configured; middleware-protected admin routes will return 503");
  }

  for (const warning of warnings) {
    console.warn(`[runtime-checks] ${warning}`);
  }
}

export function warnExecPayloadConsistency(payload: ExecSignalPayload): void {
  const key = `${payload.decision_id}:${payload.symbol}`;
  if (payloadWarnings.has(key)) return;
  payloadWarnings.add(key);

  const risk = Math.abs(payload.entry_price - payload.stop_price);
  if (!Number.isFinite(risk) || risk <= 0) {
    console.warn(
      `[runtime-checks] ${payload.symbol} invalid payload risk: entry=${payload.entry_price} stop=${payload.stop_price}`
    );
    return;
  }

  const legacyTp0Payload =
    typeof payload.tp0_price === "number" &&
    Number.isFinite(payload.tp0_price) &&
    payload.tp0_price > 0 &&
    Math.abs(payload.tp0_price - payload.tp1_price) > 1e-9;
  const tp0R = legacyTp0Payload && payload.tp0_price != null
    ? round3(ratio(payload.entry_price, payload.tp0_price, risk))
    : null;
  const tp1R = round3(ratio(payload.entry_price, payload.tp1_price, risk));
  const tp2R = round3(ratio(payload.entry_price, payload.tp2_price, risk));
  const tp3R = round3(ratio(payload.entry_price, payload.tp3_price, risk));

  const expected = legacyTp0Payload ? LEGACY_SIGNAL_LADDER_R : CURRENT_SIGNAL_LADDER_R;
  const isLong = payload.direction === "LONG";
  const monotonic =
    legacyTp0Payload
      ? isLong
        ? payload.tp0_price! > payload.stop_price &&
          payload.tp0_price! > 0 &&
          payload.tp0_price! <= payload.tp1_price &&
          payload.tp1_price <= payload.tp2_price &&
          payload.tp2_price <= payload.tp3_price
        : payload.tp0_price! < payload.stop_price &&
          payload.tp3_price <= payload.tp2_price &&
          payload.tp2_price <= payload.tp1_price &&
          payload.tp1_price <= payload.tp0_price!
      : isLong
        ? payload.tp1_price > payload.stop_price &&
          payload.tp1_price > 0 &&
          payload.tp1_price <= payload.tp2_price &&
          payload.tp2_price <= payload.tp3_price
        : payload.tp1_price < payload.stop_price &&
          payload.tp3_price <= payload.tp2_price &&
          payload.tp2_price <= payload.tp1_price;

  if (!monotonic) {
    console.warn(
      `[runtime-checks] ${payload.symbol} non-monotonic exec payload levels: ${JSON.stringify({
        entry: payload.entry_price,
        stop: payload.stop_price,
        tp0: payload.tp0_price ?? null,
        tp1: payload.tp1_price,
        tp2: payload.tp2_price,
        tp3: payload.tp3_price,
      })}`
    );
  }

  const mismatches = [
    legacyTp0Payload && tp0R != null && Math.abs(tp0R - LEGACY_SIGNAL_LADDER_R.tp0) > RATIO_TOLERANCE ? `tp0=${tp0R}R` : null,
    Math.abs(tp1R - expected.tp1) > RATIO_TOLERANCE ? `tp1=${tp1R}R` : null,
    Math.abs(tp2R - expected.tp2) > RATIO_TOLERANCE ? `tp2=${tp2R}R` : null,
    Math.abs(tp3R - expected.tp3) > RATIO_TOLERANCE ? `tp3=${tp3R}R` : null,
  ].filter((value): value is string => value !== null);

  if (mismatches.length > 0) {
    console.warn(
      `[runtime-checks] ${payload.symbol} exec payload ladder drift detected (${mismatches.join(
        ", "
      )}) relative to current signal ladder ${JSON.stringify(expected)}`
    );
  }
}
