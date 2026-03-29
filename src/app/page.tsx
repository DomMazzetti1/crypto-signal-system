import { getSupabase } from "@/lib/supabase";

export const dynamic = "force-dynamic";

async function getStats() {
  try {
    const supabase = getSupabase();

    const [universeRes, lastBuildRes, decisionsRes, lastScanRes] = await Promise.all([
      supabase
        .from("universe")
        .select("symbol", { count: "exact", head: true })
        .eq("is_eligible", true),
      supabase
        .from("universe")
        .select("updated_at")
        .order("updated_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
      supabase
        .from("decisions")
        .select("id", { count: "exact", head: true })
        .in("decision", ["LONG", "SHORT"])
        .gte("created_at", new Date().toISOString().slice(0, 10)),
      supabase
        .from("scanner_runs")
        .select("completed_at")
        .order("completed_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
    ]);

    return {
      eligibleSymbols: universeRes.count ?? 0,
      lastUniverseBuild: lastBuildRes.data?.updated_at ?? null,
      signalsToday: decisionsRes.count ?? 0,
      lastScanAt: lastScanRes.data?.completed_at ?? null,
    };
  } catch {
    return null;
  }
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
            label="Last universe build"
            value={
              stats?.lastUniverseBuild
                ? new Date(stats.lastUniverseBuild).toUTCString()
                : "--"
            }
          />
          <Row
            label="Last scanner run"
            value={
              stats?.lastScanAt
                ? new Date(stats.lastScanAt).toUTCString()
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
