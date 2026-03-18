export const dynamic = "force-dynamic";

interface Stats {
  eligible_symbols: number;
  last_universe_build: string | null;
  signals_today: number;
}

async function getStats(): Promise<Stats | null> {
  const base = process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : "http://localhost:3000";
  try {
    const res = await fetch(`${base}/api/status`, { cache: "no-store" });
    if (!res.ok) return null;
    return res.json();
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
            value={stats ? String(stats.eligible_symbols) : "--"}
          />
          <Row
            label="Signals today"
            value={stats ? String(stats.signals_today) : "--"}
          />
          <Row
            label="Last universe build"
            value={
              stats?.last_universe_build
                ? new Date(stats.last_universe_build).toUTCString()
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
