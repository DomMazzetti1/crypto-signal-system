import { NextRequest, NextResponse } from "next/server";
import { gradeBatch } from "@/lib/grading";
import { finalizeExpiredClusters } from "@/lib/cluster";
import { updateAccountState } from "@/lib/kill-switch";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Max batches per cron invocation (5 × 50 = 250 rows) */
const MAX_ITERATIONS = 5;
const BATCH_SIZE = 50;

/**
 * GET /api/cron/grade
 *
 * Scheduled grading endpoint. Loops through multiple batches until
 * no eligible rows remain or the safety cap is reached.
 *
 * Called by Vercel cron every 15 minutes.
 */
export async function GET(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const auth = request.headers.get("authorization");
    if (auth !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  // Finalize any expired cluster windows so off-hours signals get selection decisions
  // without requiring a dashboard read to trigger them.
  try {
    const finalized = await finalizeExpiredClusters();
    if (finalized > 0) {
      console.log(`[cron/grade] finalized ${finalized} expired cluster(s)`);
    }
  } catch (err) {
    console.warn("[cron/grade] cluster finalization failed (non-blocking):", err);
  }

  let totalGraded = 0;
  let totalFailed = 0;
  let totalSkipped = 0;
  let iterations = 0;

  try {
    for (let i = 0; i < MAX_ITERATIONS; i++) {
      iterations++;
      const batch = await gradeBatch(BATCH_SIZE);

      totalGraded += batch.graded;
      totalFailed += batch.failed;
      totalSkipped += batch.skipped;

      // Stop if nothing left to grade
      if (batch.checked === 0 || (batch.graded === 0 && batch.failed === 0)) {
        break;
      }
    }

    // Update account state for kill switch after grading
    try {
      await updateAccountState();
    } catch (err) {
      console.error("[cron/grade] Kill switch state update failed (non-blocking):", err);
    }

    console.log(
      `[cron/grade] ${iterations} iteration(s): graded=${totalGraded} failed=${totalFailed} skipped=${totalSkipped}`
    );

    return NextResponse.json({
      status: totalGraded > 0 ? "completed" : "idle",
      iterations,
      graded: totalGraded,
      failed: totalFailed,
      skipped: totalSkipped,
    });
  } catch (err) {
    console.error("[cron/grade] Error:", err);
    return NextResponse.json(
      {
        status: "error",
        iterations,
        graded: totalGraded,
        failed: totalFailed,
        error: err instanceof Error ? err.message : String(err),
      },
      { status: 500 }
    );
  }
}
