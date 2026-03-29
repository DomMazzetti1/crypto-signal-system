import { NextResponse } from "next/server";
import { gradeBatch } from "@/lib/grading";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * GET /api/shadow/grade-production
 *
 * Grades a single batch of eligible production trades (>48h old).
 * For multi-batch processing, use /api/cron/grade instead.
 */
export async function GET() {
  try {
    const result = await gradeBatch(50);

    if (result.checked === 0) {
      return NextResponse.json({ status: "idle", graded: 0, message: "No eligible decisions found" });
    }
    if (result.graded === 0 && result.skipped > 0) {
      return NextResponse.json({ status: "idle", graded: 0, message: "All eligible decisions already graded" });
    }

    return NextResponse.json({ status: "completed", ...result });
  } catch (err) {
    return NextResponse.json(
      { error: "Grading failed", detail: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
