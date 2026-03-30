import { NextRequest, NextResponse } from "next/server";
import { resetKillSwitch } from "@/lib/kill-switch";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const secret = process.env.WEBHOOK_SECRET;
  if (secret) {
    const provided =
      request.headers.get("x-webhook-secret") ??
      request.nextUrl.searchParams.get("secret");
    if (provided !== secret) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  try {
    await resetKillSwitch();
    return NextResponse.json({ status: "reset", message: "Kill switch deactivated. Signal generation resumed." });
  } catch (err) {
    return NextResponse.json(
      { error: "Reset failed", detail: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
