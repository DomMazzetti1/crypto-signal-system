"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

export default function DashboardAutoRefresh({
  intervalMs,
}: {
  intervalMs: number;
}) {
  const router = useRouter();

  useEffect(() => {
    const interval = window.setInterval(() => {
      if (document.visibilityState === "visible") {
        router.refresh();
      }
    }, intervalMs);

    return () => window.clearInterval(interval);
  }, [intervalMs, router]);

  return null;
}
