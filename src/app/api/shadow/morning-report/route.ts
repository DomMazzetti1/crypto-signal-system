import { NextResponse } from "next/server";
import { computeShadowSummary, ShadowSummary } from "@/lib/shadow-summary";

export const dynamic = "force-dynamic";

const EXPERIMENTS = [
  { key: "adx_shadow", setupType: "SQ_SHORT_ADX_SHADOW", label: "ADX threshold (strict=15 vs prod=30)" },
  { key: "trigger_shadow", setupType: "SQ_SHORT_TRIGGER_SHADOW", label: "Trigger mode (state vs event)" },
  { key: "hybrid_shadow", setupType: "SQ_SHORT_HYBRID_SHADOW", label: "Hybrid (state trigger, records 4H distance)" },
] as const;

type ExperimentKey = typeof EXPERIMENTS[number]["key"];

interface SectionResult {
  status: "ok" | "error";
  label: string;
  message?: string;
  summary?: ShadowSummary;
}

function decisionToVerdict(decision: string): "improving" | "neutral" | "worse" | "insufficient data" {
  if (decision === "insufficient data") return "insufficient data";
  if (decision.includes("candidate better") || decision.includes("strict better") || decision.includes("state better")) return "improving";
  if (decision.includes("baseline better") || decision.includes("event better")) return "worse";
  return "neutral";
}

export async function GET() {
  const sections: Record<string, SectionResult> = {};
  let hasError = false;

  for (const exp of EXPERIMENTS) {
    try {
      const summary = await computeShadowSummary(exp.setupType);
      sections[exp.key] = { status: "ok", label: exp.label, summary };
    } catch (err) {
      hasError = true;
      sections[exp.key] = {
        status: "error",
        label: exp.label,
        message: String(err).slice(0, 200),
      };
    }
  }

  // Build bottom line
  const verdicts: Record<ExperimentKey, string> = {
    adx_shadow: "insufficient data",
    trigger_shadow: "insufficient data",
    hybrid_shadow: "insufficient data",
  };

  for (const exp of EXPERIMENTS) {
    const section = sections[exp.key];
    if (section.status === "ok" && section.summary) {
      verdicts[exp.key] = decisionToVerdict(section.summary.decision);
    }
  }

  const allInsufficient = Object.values(verdicts).every(v => v === "insufficient data");
  const anyWorse = Object.values(verdicts).some(v => v === "worse");
  const anyImproving = Object.values(verdicts).some(v => v === "improving");

  let promotionReady = false;
  let note: string;

  if (allInsufficient) {
    note = "All experiments need more graded data before drawing conclusions.";
  } else if (anyWorse) {
    note = "At least one experiment shows degradation vs baseline — hold on promotion.";
  } else if (anyImproving) {
    // Check if hybrid (the candidate for promotion) is improving with enough data
    const hybrid = sections.hybrid_shadow;
    if (hybrid.status === "ok" && hybrid.summary && hybrid.summary.graded_rows >= 10 && verdicts.hybrid_shadow === "improving") {
      promotionReady = true;
      note = "Hybrid candidate showing improvement with sufficient data — consider promoting.";
    } else {
      note = "Positive signals in experiments but hybrid needs more graded data.";
    }
  } else {
    note = "Results are roughly equal across experiments — no clear winner yet.";
  }

  const allOk = !hasError;

  return NextResponse.json({
    status: allOk ? "ok" : "partial",
    generated_at: new Date().toISOString(),
    adx_shadow: sections.adx_shadow,
    trigger_shadow: sections.trigger_shadow,
    hybrid_shadow: sections.hybrid_shadow,
    bottom_line: {
      adx_shadow: verdicts.adx_shadow,
      trigger_shadow: verdicts.trigger_shadow,
      hybrid_shadow: verdicts.hybrid_shadow,
      promotion_ready: promotionReady,
      note,
    },
  });
}
