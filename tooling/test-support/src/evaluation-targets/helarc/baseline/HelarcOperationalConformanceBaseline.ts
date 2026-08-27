import type {
  HelarcOperationalConformanceReport,
} from "../operational-evaluation/HelarcOperationalConformanceExecution.js";
import {
  HELARC_OPERATIONAL_CONFORMANCE_REVISION,
} from "../operational-evaluation/HelarcOperationalConformanceExecution.js";
import {
  HELARC_VERIFICATION_GUIDED_COMPLETION_ACCEPTED_BASELINE,
} from "./HelarcVerificationGuidedCompletionBaseline.js";

const REPORT_DIGEST = "869b5af792136337298706caf776a2e0c96ef9379a2ca73f96a2d81abc7db335";
const REPORT_REF = Object.freeze({
  id: "helarc.operational.harness-conformance.report",
  revision: "helarc-operational-evaluation-v1",
});
const ACCEPTANCE_REF = Object.freeze({
  id: "helarc.operational.harness-conformance.baseline-acceptance",
  revision: HELARC_OPERATIONAL_CONFORMANCE_REVISION,
});
const TARGET_SNAPSHOT_REF = Object.freeze({
  id: "helarc.operational.harness-conformance.target",
  revision: HELARC_OPERATIONAL_CONFORMANCE_REVISION,
});

export const HELARC_OPERATIONAL_CONFORMANCE_ACCEPTED_BASELINE = deepFreeze({
  schemaVersion: 1 as const,
  kind: "helarc_operational_conformance_baseline" as const,
  acceptanceRef: ACCEPTANCE_REF,
  reportRef: REPORT_REF,
  reportDigest: REPORT_DIGEST,
  targetSnapshotRefs: Object.freeze([TARGET_SNAPSHOT_REF]),
  objectiveRef: Object.freeze({
    id: "helarc.operational.harness-conformance.objective",
    revision: "helarc-operational-evaluation-v1",
  }),
  suiteRef: Object.freeze({
    id: "helarc.operational.harness-conformance.suite",
    revision: "helarc-operational-evaluation-v1",
  }),
  campaignRef: Object.freeze({
    id: "helarc.operational.harness-conformance.campaign",
    revision: "helarc-operational-evaluation-v1",
  }),
  protocolRevision: HELARC_OPERATIONAL_CONFORMANCE_REVISION,
  status: "passed" as const,
  trialCount: 7,
  completedTrialCount: 7,
  metricCount: 21,
  gateCount: 11,
  passedGateCount: 11,
  failureCodes: Object.freeze([] as string[]),
  exclusionCodes: Object.freeze([] as string[]),
  missingDataCodes: Object.freeze([] as string[]),
  limitations: Object.freeze([
    "Scripted deterministic evidence proves Harness conformance, not real-model or Product effectiveness.",
    "Cleanup truth is read from the terminal Evaluation Trial snapshot after Capture settlement.",
  ]),
  acceptedAt: "2026-08-26T00:00:00.000Z",
  acceptedBy: "agent-anything-evaluation-maintainers",
});

export const HELARC_OPERATIONAL_CONFORMANCE_BASELINE_ACCEPTANCE = deepFreeze({
  schemaVersion: 1 as const,
  kind: "helarc_operational_conformance_baseline_successor_acceptance" as const,
  acceptedAt: HELARC_OPERATIONAL_CONFORMANCE_ACCEPTED_BASELINE.acceptedAt,
  predecessorAcceptanceRef:
    HELARC_VERIFICATION_GUIDED_COMPLETION_ACCEPTED_BASELINE.acceptanceRef,
  successorAcceptanceRef: ACCEPTANCE_REF,
  predecessorReportRef: HELARC_VERIFICATION_GUIDED_COMPLETION_ACCEPTED_BASELINE.reportRef,
  successorReportRef: REPORT_REF,
  comparison: "intentionally_incomparable_exact_target" as const,
  semanticDifferences: Object.freeze([
    "One combined seven-Case hostile Harness conformance Suite replaces inference from separate predecessor Product regressions.",
    "Fresh Evaluation Trial leases and terminal cleanup truth are part of every Case.",
    "Eleven non-compensating outcome and safety gates precede diagnostic interpretation.",
    "Real-model Product evidence remains a separate Report family and is not accepted by this Baseline.",
  ]),
  outcomeQuality: "passed" as const,
  safety: "passed" as const,
  reliability: "deterministic_candidate" as const,
  exclusions: Object.freeze([] as string[]),
  missingData: Object.freeze([] as string[]),
  limitations: HELARC_OPERATIONAL_CONFORMANCE_ACCEPTED_BASELINE.limitations,
});

export function verifyHelarcOperationalConformanceAcceptedBaseline(
  candidate: HelarcOperationalConformanceReport,
): typeof HELARC_OPERATIONAL_CONFORMANCE_ACCEPTED_BASELINE {
  if (
    candidate.status !== HELARC_OPERATIONAL_CONFORMANCE_ACCEPTED_BASELINE.status ||
    candidate.digest !== REPORT_DIGEST ||
    candidate.report.ref.id !== REPORT_REF.id ||
    candidate.report.ref.revision !== REPORT_REF.revision ||
    candidate.trials.length !== HELARC_OPERATIONAL_CONFORMANCE_ACCEPTED_BASELINE.trialCount ||
    candidate.metrics.length !== HELARC_OPERATIONAL_CONFORMANCE_ACCEPTED_BASELINE.metricCount ||
    candidate.report.gateOutcomes.length !== HELARC_OPERATIONAL_CONFORMANCE_ACCEPTED_BASELINE.gateCount ||
    candidate.report.gateOutcomes.some(({ status }) => status !== "passed") ||
    candidate.report.failures.length > 0 ||
    candidate.report.exclusions.length > 0 ||
    candidate.report.missingData.length > 0
  ) {
    throw new TypeError("Operational conformance candidate does not match the accepted Baseline.");
  }
  return HELARC_OPERATIONAL_CONFORMANCE_ACCEPTED_BASELINE;
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}
