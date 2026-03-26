/**
 * Single source of truth for shadow experiment definitions.
 * Prevents parameter drift across scanner, status endpoints, and reports.
 */

import { SignalParams, DEFAULT_SIGNAL_PARAMS } from "@/lib/signals";

export interface ExperimentDef {
  name: string;
  setup_type: string;
  description: string;
  baseline_params: SignalParams;
  candidate_params: SignalParams;
  status_endpoint: string;
  deployed_commit?: string;
}

export const EXPERIMENTS: ExperimentDef[] = [
  {
    name: "ADX threshold",
    setup_type: "SQ_SHORT_ADX_SHADOW",
    description: "Strict ADX < 15 vs production ADX < 30",
    baseline_params: DEFAULT_SIGNAL_PARAMS,
    candidate_params: { ...DEFAULT_SIGNAL_PARAMS, sq_adx_1h_max: 15 },
    status_endpoint: "/api/shadow/sq-status",
    deployed_commit: "868221a",
  },
  {
    name: "Trigger mode",
    setup_type: "SQ_SHORT_TRIGGER_SHADOW",
    description: "State trigger vs production event trigger (both 1.5x vol)",
    baseline_params: DEFAULT_SIGNAL_PARAMS,
    candidate_params: { ...DEFAULT_SIGNAL_PARAMS, sq_trigger_mode: "state" },
    status_endpoint: "/api/shadow/sq-trigger-status",
    deployed_commit: "014bbb1",
  },
  {
    name: "Hybrid candidate",
    setup_type: "SQ_SHORT_HYBRID_SHADOW",
    description: "State trigger + records 4H distance metadata for bucketing",
    baseline_params: DEFAULT_SIGNAL_PARAMS,
    candidate_params: { ...DEFAULT_SIGNAL_PARAMS, sq_trigger_mode: "state", sq_4h_distance_pct: 0 },
    status_endpoint: "/api/shadow/sq-hybrid-status",
    deployed_commit: "a4d8d90",
  },
];

export function getExperiment(setupType: string): ExperimentDef | undefined {
  return EXPERIMENTS.find(e => e.setup_type === setupType);
}

// ── Sample-size guardrails ──────────────────────────────

export const DECISION_THRESHOLDS = {
  /** Minimum total graded rows before any verdict */
  min_graded_total: 10,
  /** Minimum candidate-pass graded rows */
  min_candidate_graded: 5,
  /** Minimum baseline-only graded rows for comparison */
  min_baseline_graded: 3,
} as const;
