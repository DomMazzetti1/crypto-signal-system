import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

const EXEC_URL = process.env.EXEC_ENGINE_URL ?? "http://45.77.33.123:3001";

export async function GET() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);

  try {
    const res = await fetch(`${EXEC_URL}/dashboard/account`, {
      headers: {
        "x-webhook-secret": process.env.EXEC_WEBHOOK_SECRET ?? "",
      },
      cache: "no-store",
      signal: controller.signal,
    });

    if (!res.ok) {
      const detail = await res.text();
      return NextResponse.json(
        {
          status: "error",
          error: detail || `HTTP ${res.status}`,
        },
        { status: 502 }
      );
    }

    const data = await res.json();
    return NextResponse.json(data);
  } catch (err) {
    return NextResponse.json(
      {
        status: "down",
        error: err instanceof Error ? err.message : "unreachable",
      },
      { status: 502 }
    );
  } finally {
    clearTimeout(timeout);
  }
}
