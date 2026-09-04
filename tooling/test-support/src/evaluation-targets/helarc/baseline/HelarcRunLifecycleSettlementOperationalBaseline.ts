import type {
  HelarcOperationalConformanceReport,
} from "../operational-evaluation/HelarcOperationalConformanceExecution.js";
import {
  HELARC_RUN_STOP_OPERATIONAL_ACCEPTED_BASELINE,
} from "./HelarcRunStopOperationalBaseline.js";

const REVISION = "helarc-operational-conformance-v3";
const EVALUATION_REVISION = "helarc-operational-evaluation-v3";
const REPORT_DIGEST = "404b309a7f62d13634dc2a0ab2fa7f1eb3152db5bf2360c70e69bfdcb7cee18d";
const REPORT_REF = Object.freeze({
  id: "helarc.operational.harness-conformance.report",
  revision: EVALUATION_REVISION,
});
const ACCEPTANCE_REF = Object.freeze({
  id: "helarc.operational.harness-conformance.baseline-acceptance",
  revision: REVISION,
});
const TARGET_SNAPSHOT_REF = Object.freeze({
  id: "helarc.operational.harness-conformance.target",
  revision: REVISION,
});

export const HELARC_RUN_LIFECYCLE_SETTLEMENT_OPERATIONAL_ACCEPTED_BASELINE = deepFreeze({
  ...HELARC_RUN_STOP_OPERATIONAL_ACCEPTED_BASELINE,
  acceptanceRef: ACCEPTANCE_REF,
  reportRef: REPORT_REF,
  reportDigest: REPORT_DIGEST,
  targetSnapshotRefs: Object.freeze([TARGET_SNAPSHOT_REF]),
  objectiveRef: Object.freeze({
    id: "helarc.operational.harness-conformance.objective",
    revision: EVALUATION_REVISION,
  }),
  suiteRef: Object.freeze({
    id: "helarc.operational.harness-conformance.suite",
    revision: EVALUATION_REVISION,
  }),
  campaignRef: Object.freeze({
    id: "helarc.operational.harness-conformance.campaign",
    revision: EVALUATION_REVISION,
  }),
  protocolRevision: REVISION,
  acceptedAt: "2026-09-02T00:00:00.000Z",
});

export const HELARC_RUN_LIFECYCLE_SETTLEMENT_OPERATIONAL_BASELINE_ACCEPTANCE = deepFreeze({
  schemaVersion: 1 as const,
  kind: "helarc_run_lifecycle_settlement_operational_baseline_successor_acceptance" as const,
  acceptedAt: HELARC_RUN_LIFECYCLE_SETTLEMENT_OPERATIONAL_ACCEPTED_BASELINE.acceptedAt,
  predecessorAcceptanceRef: HELARC_RUN_STOP_OPERATIONAL_ACCEPTED_BASELINE.acceptanceRef,
  successorAcceptanceRef: ACCEPTANCE_REF,
  predecessorReportRef: HELARC_RUN_STOP_OPERATIONAL_ACCEPTED_BASELINE.reportRef,
  successorReportRef: REPORT_REF,
  comparison: "intentionally_incomparable_exact_target" as const,
  semanticDifferences: Object.freeze([
    "Waiting and suspended remain nonterminal Run states; the deterministic Evaluation driver cancels a suspended Run it does not resume.",
    "Required Verification prevents unsupported completion without fabricating a blocked terminal Run outcome.",
    "Stop lifecycle hooks replace the former Run Stop Review protocol while the Runner remains the sole terminal settlement authority.",
    "Historical operational v1 and v2 evidence remains immutable and separately addressable.",
  ]),
  outcomeQuality: "passed" as const,
  safety: "passed" as const,
  reliability: "deterministic_candidate" as const,
  exclusions: Object.freeze([] as string[]),
  missingData: Object.freeze([] as string[]),
  limitations: HELARC_RUN_LIFECYCLE_SETTLEMENT_OPERATIONAL_ACCEPTED_BASELINE.limitations,
});

export function verifyHelarcRunLifecycleSettlementOperationalAcceptedBaseline(
  candidate: HelarcOperationalConformanceReport,
): typeof HELARC_RUN_LIFECYCLE_SETTLEMENT_OPERATIONAL_ACCEPTED_BASELINE {
  if (
    candidate.status !== HELARC_RUN_LIFECYCLE_SETTLEMENT_OPERATIONAL_ACCEPTED_BASELINE.status ||
    candidate.digest !== REPORT_DIGEST ||
    candidate.report.ref.id !== REPORT_REF.id ||
    candidate.report.ref.revision !== REPORT_REF.revision ||
    candidate.trials.length !== HELARC_RUN_LIFECYCLE_SETTLEMENT_OPERATIONAL_ACCEPTED_BASELINE.trialCount ||
    candidate.metrics.length !== HELARC_RUN_LIFECYCLE_SETTLEMENT_OPERATIONAL_ACCEPTED_BASELINE.metricCount ||
    candidate.report.gateOutcomes.length !== HELARC_RUN_LIFECYCLE_SETTLEMENT_OPERATIONAL_ACCEPTED_BASELINE.gateCount ||
    candidate.report.gateOutcomes.some(({ status }) => status !== "passed") ||
    candidate.report.failures.length > 0 ||
    candidate.report.exclusions.length > 0 ||
    candidate.report.missingData.length > 0
  ) {
    throw new TypeError("Run lifecycle settlement operational candidate does not match the accepted Baseline.");
  }
  return HELARC_RUN_LIFECYCLE_SETTLEMENT_OPERATIONAL_ACCEPTED_BASELINE;
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}
