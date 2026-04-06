import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const DEPRECATION_PAYLOAD = {
  error: "This endpoint is deprecated because it still reflects legacy ladder assumptions and can misstate live strategy performance.",
  replacement_api: "/api/backtest/pipeline-replay",
  replacement_script: "scripts/strategy-tester.ts",
  note: "Use pipeline-replay for the closest API replay of the live signal stack, or strategy-tester for configurable research on the current 0.5/1.0/2.5 ladder.",
};

export async function GET() {
  return NextResponse.json(DEPRECATION_PAYLOAD, { status: 410 });
}
