import { NextResponse } from "next/server";
import { computeR, GradeResult } from "@/lib/grade-signal";
import { computeSpreadBps } from "@/lib/bybit";
import { enforceProductionLimits } from "@/lib/backtest-utils";

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

  function test(name: string, fn: () => void) {
    try {
      fn();
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

  test("computeR: no resolution returns 0", () => {
    assert(computeR(baseGrade) === 0, "should be 0");
  });

  test("computeR: SL hit returns -1", () => {
    assert(computeR({ ...baseGrade, hit_sl: true }) === -1, "should be -1");
  });

  test("computeR: TP1 hit returns positive R", () => {
    const r = computeR({ ...baseGrade, hit_tp1: true });
    assert(r > 0, `should be positive, got ${r}`);
    assertClose(r, 1.5, 0.01, "TP1 R");
  });

  test("computeR: TP3 hit takes precedence over TP1", () => {
    const r = computeR({ ...baseGrade, hit_tp1: true, hit_tp3: true });
    assert(r > 2, `TP3 R should be > 2, got ${r}`);
  });

  test("computeR: zero risk returns 0", () => {
    assert(computeR({ ...baseGrade, stop_loss: 100 }) === 0, "should be 0");
  });

  test("computeR: NaN entry returns 0", () => {
    assert(computeR({ ...baseGrade, entry_price: NaN }) === 0, "should be 0 for NaN");
  });

  test("computeR: NaN stop_loss returns 0", () => {
    assert(computeR({ ...baseGrade, stop_loss: NaN }) === 0, "should be 0 for NaN");
  });

  test("computeR: Infinity entry returns 0", () => {
    assert(computeR({ ...baseGrade, entry_price: Infinity }) === 0, "should be 0 for Infinity");
  });

  // ── computeSpreadBps tests ─────────────────────────────

  test("computeSpreadBps: normal spread", () => {
    const bps = computeSpreadBps("100.00", "100.10");
    assertClose(bps, 10, 0.1, "10 bps spread");
  });

  test("computeSpreadBps: zero bid returns 0", () => {
    assert(computeSpreadBps("0", "100") === 0, "should be 0");
  });

  test("computeSpreadBps: NaN bid returns 0", () => {
    assert(computeSpreadBps("not_a_number", "100") === 0, "should be 0 for NaN");
  });

  test("computeSpreadBps: NaN ask returns 0", () => {
    assert(computeSpreadBps("100", "abc") === 0, "should be 0 for NaN");
  });

  test("computeSpreadBps: empty string returns 0", () => {
    assert(computeSpreadBps("", "") === 0, "should be 0 for empty");
  });

  test("computeSpreadBps: identical bid/ask returns 0", () => {
    assert(computeSpreadBps("50000", "50000") === 0, "should be 0 for zero spread");
  });

  // ── enforceProductionLimits tests ──────────────────────
  // These test the function directly. On non-Vercel (local),
  // all calls return null (no limits). On Vercel, limits apply.
  // We test the local behavior here since tests run locally.

  test("enforceProductionLimits: returns null locally (no limits)", () => {
    const result = enforceProductionLimits(["BTCUSDT", "ETHUSDT"], true);
    assert(result === null, "should be null locally");
  });

  test("enforceProductionLimits: returns null locally even without cache_only", () => {
    const result = enforceProductionLimits(["BTCUSDT"], false);
    assert(result === null, "should be null locally regardless of cache_only");
  });

  test("enforceProductionLimits: returns null locally even with 50 symbols", () => {
    const syms = Array.from({ length: 50 }, (_, i) => `SYM${i}USDT`);
    const result = enforceProductionLimits(syms, true);
    assert(result === null, "should be null locally regardless of count");
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
