import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const EXEC_URL = process.env.EXEC_ENGINE_URL ?? "http://45.77.33.123:3001";

export async function GET() {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    const res = await fetch(`${EXEC_URL}/health`, {
      signal: controller.signal,
      cache: "no-store",
    });
    clearTimeout(timeout);

    if (!res.ok) {
      return NextResponse.json({ status: "error", error: `HTTP ${res.status}` }, { status: 502 });
    }

    const data = await res.json();
    return NextResponse.json(data);
  } catch (err) {
    return NextResponse.json(
      { status: "down", error: err instanceof Error ? err.message : "unreachable" },
      { status: 502 }
    );
  }
}
