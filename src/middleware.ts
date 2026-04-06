import { NextRequest, NextResponse } from "next/server";

function configuredSecrets(): string[] {
  return [
    process.env.CRON_SECRET,
    process.env.WEBHOOK_SECRET,
    process.env.EXEC_WEBHOOK_SECRET,
  ]
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value));
}

function providedSecret(request: NextRequest): string | null {
  const authHeader = request.headers.get("authorization");
  const bearer = authHeader?.startsWith("Bearer ")
    ? authHeader.slice("Bearer ".length).trim()
    : null;

  return (
    request.headers.get("x-admin-secret")?.trim() ??
    request.headers.get("x-webhook-secret")?.trim() ??
    bearer ??
    request.nextUrl.searchParams.get("secret")?.trim() ??
    null
  );
}

export function middleware(request: NextRequest) {
  const secrets = configuredSecrets();
  if (secrets.length === 0) {
    console.error(
      `[middleware] Admin route ${request.nextUrl.pathname} blocked: no admin secret configured`
    );
    return NextResponse.json(
      { error: "Admin routes unavailable: no secret configured" },
      { status: 503 }
    );
  }

  const provided = providedSecret(request);
  if (!provided || !secrets.includes(provided)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    "/api/backtest/:path*",
    "/api/debug/backfill-regime",
    "/api/debug/missed-signals",
    "/api/debug/production-health",
    "/api/debug/signals",
    "/api/debug/test-core",
    "/api/scanner/near-misses",
    "/api/shadow/grade",
    "/api/shadow/grade-production",
    "/api/shadow/morning-report",
    "/api/shadow/sq-daily-rollup",
    "/api/universe/build",
    "/api/worker/process",
  ],
};
