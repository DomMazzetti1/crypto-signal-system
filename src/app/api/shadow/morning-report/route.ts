import { NextResponse } from "next/server";
import {
  computeShadowSummary,
  computeProductionGradeSummary,
  computeClaudeStats,
  ShadowSummary,
  ProductionGradeSummary,
  ClaudeReviewerStats,
} from "@/lib/shadow-summary";
import { EXPERIMENTS, DECISION_THRESHOLDS } from "@/lib/experiment-registry";

export const dynamic = "force-dynamic";

type SectionStatus = "ok" | "error" | "no_table";

interface ShadowSection {
  status: SectionStatus;
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
  let hasError = false;

  // ── Shadow experiments ─────────────────────────────────

  const shadowSections: Record<string, ShadowSection> = {};

  for (const exp of EXPERIMENTS) {
    try {
      const summary = await computeShadowSummary(exp.setup_type);
      shadowSections[exp.setup_type] = { status: "ok", label: exp.name, summary };
    } catch (err) {
      hasError = true;
      shadowSections[exp.setup_type] = { status: "error", label: exp.name, message: String(err).slice(0, 200) };
    }
  }

  // ── Production graded performance ──────────────────────

  let productionSection: { status: SectionStatus; summary?: ProductionGradeSummary; message?: string };
  try {
    const prodSummary = await computeProductionGradeSummary();
    productionSection = { status: "ok", summary: prodSummary };
  } catch (err) {
    hasError = true;
    const msg = String(err);
    productionSection = {
      status: msg.includes("Could not find") ? "no_table" : "error",
      message: msg.includes("Could not find")
        ? "production_signal_grades table not yet created. Run migration 012."
        : msg.slice(0, 200),
    };
  }

  // ── Claude reviewer stats ──────────────────────────────

  let claudeSection: { status: SectionStatus; stats?: ClaudeReviewerStats; message?: string };
  try {
    const stats = await computeClaudeStats();
    claudeSection = { status: "ok", stats };
  } catch (err) {
    hasError = true;
    claudeSection = { status: "error", message: String(err).slice(0, 200) };
  }

  // ── Build verdicts and bottom line ─────────────────────

  const verdicts: Record<string, string> = {};
  for (const exp of EXPERIMENTS) {
    const section = shadowSections[exp.setup_type];
    verdicts[exp.setup_type] = section.status === "ok" && section.summary
      ? decisionToVerdict(section.summary.decision)
      : "insufficient data";
  }

  const allInsufficient = Object.values(verdicts).every(v => v === "insufficient data");
  const anyWorse = Object.values(verdicts).some(v => v === "worse");
  const anyImproving = Object.values(verdicts).some(v => v === "improving");

  // Hybrid is the promotion candidate
  const hybridSection = shadowSections["SQ_SHORT_HYBRID_SHADOW"];
  const hybridSummary = hybridSection?.status === "ok" ? hybridSection.summary : null;
  const hybridVerdict = verdicts["SQ_SHORT_HYBRID_SHADOW"] ?? "insufficient data";

  // Production comparison for promotion readiness
  const prodGraded = productionSection.status === "ok" && productionSection.summary
    ? productionSection.summary.graded : 0;
  const prodAvgR = productionSection.status === "ok" && productionSection.summary
    ? productionSection.summary.avg_r : 0;

  let promotionReady = false;
  let note: string;

  if (allInsufficient) {
    note = "All experiments need more graded data before drawing conclusions.";
  } else if (anyWorse) {
    note = "At least one experiment shows degradation vs baseline — hold on promotion.";
  } else if (anyImproving && hybridVerdict === "improving" && hybridSummary) {
    const candidateR = hybridSummary.relaxed_pass.avg_r;
    const meetsMinSample = hybridSummary.graded_rows >= DECISION_THRESHOLDS.min_graded_total;
    const notWorseThanProd = prodGraded === 0 || candidateR >= prodAvgR - 0.2;

    if (meetsMinSample && notWorseThanProd) {
      promotionReady = true;
      note = "Hybrid candidate showing improvement with sufficient data — consider promoting.";
    } else if (!meetsMinSample) {
      note = "Hybrid looks promising but needs more graded samples.";
    } else {
      note = "Hybrid improving vs shadow baseline but underperforms production — hold.";
    }
  } else if (anyImproving) {
    note = "Positive signals in experiments but hybrid not yet proven.";
  } else {
    note = "Results are roughly equal across experiments — no clear winner yet.";
  }

  if (prodGraded > 0) {
    note += ` Production: ${prodGraded} graded trade(s), avg_r=${prodAvgR}.`;
  }

  // ── Assemble response ──────────────────────────────────

  return NextResponse.json({
    status: hasError ? "partial" : "ok",
    generated_at: new Date().toISOString(),
    sample_thresholds: DECISION_THRESHOLDS,

    experiments: Object.fromEntries(
      EXPERIMENTS.map(exp => [exp.setup_type, {
        ...shadowSections[exp.setup_type],
        description: exp.description,
      }])
    ),

    production: {
      status: productionSection.status,
      label: "Production accepted trades (graded)",
      message: productionSection.message,
      summary: productionSection.summary,
    },

    claude_reviewer: {
      status: claudeSection.status,
      label: "Claude reviewer behavior",
      message: claudeSection.message,
      stats: claudeSection.stats,
    },

    bottom_line: {
      verdicts,
      promotion_ready: promotionReady,
      note,
    },
  });
}
