import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const DEPRECATION_PAYLOAD = {
  error: "This endpoint is deprecated because it still reflects legacy ladder assumptions and can misstate live strategy performance.",
  replacement_api: "/api/backtest/pipeline-replay",
  replacement_script: "scripts/strategy-tester.ts",
  note: "Use pipeline-replay for the closest API replay of the live signal stack, or strategy-tester for configurable research on the current 0.5/1.0/2.5 ladder.",
};

export async function GET(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const auth = request.headers.get("authorization");
    if (auth !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  return NextResponse.json(DEPRECATION_PAYLOAD, { status: 410 });
}
