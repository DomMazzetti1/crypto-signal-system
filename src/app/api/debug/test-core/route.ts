import { NextResponse } from "next/server";
import { computeR, GradeResult } from "@/lib/grade-signal";
import { computeSpreadBps, parseBybitResponse } from "@/lib/bybit";
import { checkProductionLimits, MAX_SYMBOLS_VERCEL } from "@/lib/backtest-utils";
import { latestATR } from "@/lib/ta";
import { Kline } from "@/lib/bybit";

export const dynamic = "force-dynamic";

/**
 * GET /api/debug/test-core
 *
 * Runs correctness tests against core helpers.
 * Returns pass/fail for each test case.
 * No side effects — safe to call in any environment.
 */
export async function GET() {
  const results: { name: string; passed: boolean; detail?: string }[] = [];

  async function test(name: string, fn: () => void | Promise<void>) {
    try {
      await fn();
      results.push({ name, passed: true });
    } catch (err) {
      results.push({ name, passed: false, detail: String(err) });
    }
  }

  function assert(condition: boolean, msg: string) {
    if (!condition) throw new Error(`Assertion failed: ${msg}`);
  }

  function assertClose(actual: number, expected: number, tolerance: number, msg: string) {
    if (Math.abs(actual - expected) > tolerance) {
      throw new Error(`${msg}: expected ~${expected}, got ${actual}`);
    }
  }

  // ── computeR tests ─────────────────────────────────────

  const baseGrade: GradeResult = {
    entry_price: 100, stop_loss: 95, tp1: 107.5, tp2: 112.5, tp3: 120,
    hit_tp1: false, hit_tp2: false, hit_tp3: false, hit_sl: false,
    bars_to_resolution: 48, max_favorable: 0, max_adverse: 0,
  };

  await test("computeR: no resolution returns 0", () => {
    assert(computeR(baseGrade) === 0, "should be 0");
  });

  await test("computeR: SL hit returns -1", () => {
    assert(computeR({ ...baseGrade, hit_sl: true }) === -1, "should be -1");
  });

  await test("computeR: TP1 hit returns positive R", () => {
    const r = computeR({ ...baseGrade, hit_tp1: true });
    assert(r > 0, `should be positive, got ${r}`);
    assertClose(r, 1.5, 0.01, "TP1 R");
  });

  await test("computeR: TP3 hit takes precedence over TP1", () => {
    const r = computeR({ ...baseGrade, hit_tp1: true, hit_tp3: true });
    assert(r > 2, `TP3 R should be > 2, got ${r}`);
  });

  await test("computeR: zero risk returns 0", () => {
    assert(computeR({ ...baseGrade, stop_loss: 100 }) === 0, "should be 0");
  });

  await test("computeR: NaN entry returns 0", () => {
    assert(computeR({ ...baseGrade, entry_price: NaN }) === 0, "should be 0 for NaN");
  });

  await test("computeR: NaN stop_loss returns 0", () => {
    assert(computeR({ ...baseGrade, stop_loss: NaN }) === 0, "should be 0 for NaN");
  });

  await test("computeR: Infinity entry returns 0", () => {
    assert(computeR({ ...baseGrade, entry_price: Infinity }) === 0, "should be 0 for Infinity");
  });

  // ── computeSpreadBps tests ─────────────────────────────

  await test("computeSpreadBps: normal spread", () => {
    const bps = computeSpreadBps("100.00", "100.10");
    assertClose(bps, 10, 0.1, "10 bps spread");
  });

  await test("computeSpreadBps: zero bid returns 0", () => {
    assert(computeSpreadBps("0", "100") === 0, "should be 0");
  });

  await test("computeSpreadBps: NaN bid returns 0", () => {
    assert(computeSpreadBps("not_a_number", "100") === 0, "should be 0 for NaN");
  });

  await test("computeSpreadBps: NaN ask returns 0", () => {
    assert(computeSpreadBps("100", "abc") === 0, "should be 0 for NaN");
  });

  await test("computeSpreadBps: empty string returns 0", () => {
    assert(computeSpreadBps("", "") === 0, "should be 0 for empty");
  });

  await test("computeSpreadBps: identical bid/ask returns 0", () => {
    assert(computeSpreadBps("50000", "50000") === 0, "should be 0 for zero spread");
  });

  // ── checkProductionLimits tests (testable core) ─────────

  await test("checkProductionLimits: returns null when not in production", () => {
    const result = checkProductionLimits(["BTCUSDT"], false, false);
    assert(result === null, "should be null locally");
  });

  await test("checkProductionLimits: rejects cache_only=false in production", () => {
    const result = checkProductionLimits(["BTCUSDT"], false, true);
    assert(result !== null, "should return error object");
    assert(result!.error.includes("cache_only"), `error should mention cache_only, got: ${result!.error}`);
  });

  await test("checkProductionLimits: rejects >5 symbols in production", () => {
    const syms = Array.from({ length: MAX_SYMBOLS_VERCEL + 1 }, (_, i) => `SYM${i}USDT`);
    const result = checkProductionLimits(syms, true, true);
    assert(result !== null, "should return error object");
    assert(result!.error.includes("Too many symbols"), `error should mention symbols, got: ${result!.error}`);
  });

  await test("checkProductionLimits: allows 5 symbols with cache_only in production", () => {
    const syms = Array.from({ length: MAX_SYMBOLS_VERCEL }, (_, i) => `SYM${i}USDT`);
    const result = checkProductionLimits(syms, true, true);
    assert(result === null, "should allow exactly MAX_SYMBOLS_VERCEL");
  });

  await test("checkProductionLimits: allows 1 symbol with cache_only in production", () => {
    const result = checkProductionLimits(["BTCUSDT"], true, true);
    assert(result === null, "should allow small request");
  });

  await test("checkProductionLimits: cache_only check runs before symbol count check", () => {
    const syms = Array.from({ length: 50 }, (_, i) => `SYM${i}USDT`);
    const result = checkProductionLimits(syms, false, true);
    assert(result !== null, "should return error");
    assert(result!.error.includes("cache_only"), "should hit cache_only check first");
  });

  // ── parseBybitResponse tests ───────────────────────────

  await test("parseBybitResponse: rejects non-ok HTTP response", async () => {
    const res = new Response("Server Error", { status: 502 });
    let threw = false;
    try {
      await parseBybitResponse(res, "test");
    } catch (err) {
      threw = true;
      assert(String(err).includes("502"), `error should include status code: ${err}`);
    }
    assert(threw, "should throw on non-ok response");
  });

  await test("parseBybitResponse: rejects non-JSON content-type", async () => {
    const res = new Response("<html>geo-blocked</html>", {
      status: 200,
      headers: { "Content-Type": "text/html" },
    });
    let threw = false;
    try {
      await parseBybitResponse(res, "test");
    } catch (err) {
      threw = true;
      assert(String(err).includes("expected JSON"), `error should mention JSON: ${err}`);
      assert(String(err).includes("text/html"), `error should include actual content-type: ${err}`);
    }
    assert(threw, "should throw on non-JSON content-type");
  });

  await test("parseBybitResponse: accepts valid JSON response", async () => {
    const body = JSON.stringify({ retCode: 0, retMsg: "OK", result: { list: [] } });
    const res = new Response(body, {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
    const data = await parseBybitResponse(res, "test");
    assert(data.retCode === 0, `retCode should be 0, got ${data.retCode}`);
    assert(data.retMsg === "OK", `retMsg should be OK, got ${data.retMsg}`);
  });

  await test("parseBybitResponse: rejects malformed JSON body", async () => {
    const res = new Response("{not valid json", {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
    let threw = false;
    try {
      await parseBybitResponse(res, "test");
    } catch (err) {
      threw = true;
      assert(String(err).includes("invalid JSON"), `error should mention invalid JSON: ${err}`);
    }
    assert(threw, "should throw on malformed JSON");
  });

  // ── latestATR tests ────────────────────────────────────

  await test("latestATR: empty array returns 0", () => {
    const result = latestATR([], 14);
    assert(result === 0, `should be 0, got ${result}`);
  });

  await test("latestATR: too few candles returns 0", () => {
    const fewCandles: Kline[] = Array.from({ length: 5 }, (_, i) => ({
      startTime: i * 3600000,
      open: 100, high: 105, low: 95, close: 100, volume: 1000,
    }));
    const result = latestATR(fewCandles, 14);
    assert(result === 0, `should be 0 with only 5 candles, got ${result}`);
  });

  await test("latestATR: sufficient candles returns positive number", () => {
    const candles: Kline[] = Array.from({ length: 30 }, (_, i) => ({
      startTime: i * 3600000,
      open: 100 + Math.sin(i) * 5,
      high: 105 + Math.sin(i) * 5,
      low: 95 + Math.sin(i) * 5,
      close: 100 + Math.sin(i + 1) * 5,
      volume: 1000,
    }));
    const result = latestATR(candles, 14);
    assert(Number.isFinite(result), `should be finite, got ${result}`);
    assert(result > 0, `should be positive, got ${result}`);
  });

  // ── Summary ────────────────────────────────────────────

  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;

  return NextResponse.json({
    total: results.length,
    passed,
    failed,
    all_passed: failed === 0,
    results,
  });
}
