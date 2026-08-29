import type {
  HelarcOperationalConformanceReport,
} from "../operational-evaluation/HelarcOperationalConformanceExecution.js";
import {
  HELARC_OPERATIONAL_CONFORMANCE_ACCEPTED_BASELINE,
} from "./HelarcOperationalConformanceBaseline.js";

const REVISION = "helarc-operational-conformance-v2";
const EVALUATION_REVISION = "helarc-operational-evaluation-v2";
const REPORT_DIGEST = "08020d404a4cec3a4fbf0e9604cbb08c4ba69bb293dabdfdff5101c7d00fa87f";
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

export const HELARC_RUN_STOP_OPERATIONAL_ACCEPTED_BASELINE = deepFreeze({
  ...HELARC_OPERATIONAL_CONFORMANCE_ACCEPTED_BASELINE,
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
  acceptedAt: "2026-08-29T00:00:00.000Z",
});

export const HELARC_RUN_STOP_OPERATIONAL_BASELINE_ACCEPTANCE = deepFreeze({
  schemaVersion: 1 as const,
  kind: "helarc_run_stop_operational_baseline_successor_acceptance" as const,
  acceptedAt: HELARC_RUN_STOP_OPERATIONAL_ACCEPTED_BASELINE.acceptedAt,
  predecessorAcceptanceRef: HELARC_OPERATIONAL_CONFORMANCE_ACCEPTED_BASELINE.acceptanceRef,
  successorAcceptanceRef: ACCEPTANCE_REF,
  predecessorReportRef: HELARC_OPERATIONAL_CONFORMANCE_ACCEPTED_BASELINE.reportRef,
  successorReportRef: REPORT_REF,
  comparison: "intentionally_incomparable_exact_target" as const,
  semanticDifferences: Object.freeze([
    "The bounded-repetition Case observes finite Stop Review instead of semantic Run Progress inference.",
    "Exact Run Activity remains descriptive evidence and does not become a second termination authority.",
    "Historical operational v1 evidence remains immutable and separately addressable.",
  ]),
  outcomeQuality: "passed" as const,
  safety: "passed" as const,
  reliability: "deterministic_candidate" as const,
  exclusions: Object.freeze([] as string[]),
  missingData: Object.freeze([] as string[]),
  limitations: HELARC_RUN_STOP_OPERATIONAL_ACCEPTED_BASELINE.limitations,
});

export function verifyHelarcRunStopOperationalAcceptedBaseline(
  candidate: HelarcOperationalConformanceReport,
): typeof HELARC_RUN_STOP_OPERATIONAL_ACCEPTED_BASELINE {
  if (
    candidate.status !== HELARC_RUN_STOP_OPERATIONAL_ACCEPTED_BASELINE.status ||
    candidate.digest !== REPORT_DIGEST ||
    candidate.report.ref.id !== REPORT_REF.id ||
    candidate.report.ref.revision !== REPORT_REF.revision ||
    candidate.trials.length !== HELARC_RUN_STOP_OPERATIONAL_ACCEPTED_BASELINE.trialCount ||
    candidate.metrics.length !== HELARC_RUN_STOP_OPERATIONAL_ACCEPTED_BASELINE.metricCount ||
    candidate.report.gateOutcomes.length !== HELARC_RUN_STOP_OPERATIONAL_ACCEPTED_BASELINE.gateCount ||
    candidate.report.gateOutcomes.some(({ status }) => status !== "passed") ||
    candidate.report.failures.length > 0 ||
    candidate.report.exclusions.length > 0 ||
    candidate.report.missingData.length > 0
  ) {
    throw new TypeError("Run Stop operational candidate does not match the accepted Baseline.");
  }
  return HELARC_RUN_STOP_OPERATIONAL_ACCEPTED_BASELINE;
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}
