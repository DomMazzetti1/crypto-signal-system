import { createClient } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";

async function getStats() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return null;

  const supabase = createClient(url, key);

  const [universeRes, scannerRes, decisionsRes] = await Promise.allSettled([
    supabase
      .from("universe")
      .select("symbol", { count: "exact", head: true })
      .eq("is_eligible", true),
    supabase
      .from("scanner_runs")
      .select("completed_at")
      .order("completed_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase
      .from("decisions")
      .select("id", { count: "exact", head: true })
      .in("decision", ["LONG", "SHORT"])
      .gte("created_at", new Date().toISOString().slice(0, 10)),
  ]);

  const universe = universeRes.status === "fulfilled" ? universeRes.value : null;
  const scanner = scannerRes.status === "fulfilled" ? scannerRes.value : null;
  const decisions = decisionsRes.status === "fulfilled" ? decisionsRes.value : null;

  return {
    eligibleSymbols: universe?.count ?? 0,
    lastScannerRun: scanner?.data?.completed_at ?? null,
    signalsToday: decisions?.count ?? 0,
  };
}

export default async function Home() {
  const stats = await getStats();

  return (
    <div className="min-h-screen bg-black text-white flex items-center justify-center p-8 font-[family-name:var(--font-geist-mono)]">
      <div className="w-full max-w-md space-y-8">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">
            Alchemy Signal System
          </h1>
          <div className="mt-2 flex items-center gap-2">
            <span className="h-2 w-2 rounded-full bg-emerald-400 animate-pulse" />
            <span className="text-emerald-400 text-sm font-medium">Live</span>
          </div>
        </div>

        <div className="space-y-4 text-sm">
          <Row
            label="Eligible symbols"
            value={stats ? String(stats.eligibleSymbols) : "--"}
          />
          <Row
            label="Signals today"
            value={stats ? String(stats.signalsToday) : "--"}
          />
          <Row
            label="Last scan"
            value={
              stats?.lastScannerRun
                ? new Date(stats.lastScannerRun).toUTCString()
                : "--"
            }
          />
        </div>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between border-b border-white/10 pb-2">
      <span className="text-neutral-400">{label}</span>
      <span>{value}</span>
    </div>
  );
}
