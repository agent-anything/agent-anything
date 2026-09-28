import type { HelarcOperationalConformanceReport } from "../operational-evaluation/HelarcOperationalConformanceExecution.js";

export const HELARC_EXPLICIT_FINAL_RESULT_OPERATIONAL_ACCEPTED_BASELINE = deepFreeze({
  "schemaVersion": 1,
  "kind": "helarc_operational_conformance_baseline",
  "acceptanceRef": {
    "id": "helarc.operational.harness-conformance.baseline-acceptance",
    "revision": "helarc-operational-conformance-v7"
  },
  "reportRef": {
    "id": "helarc.operational.harness-conformance.report",
    "revision": "helarc-operational-evaluation-v7"
  },
  "reportDigest": "98ea58e8e807e0445c59a86e674cd21de02e07d330fa571742b7d0c9cf5c0a61",
  "targetSnapshotRefs": [
    {
      "id": "helarc.operational.harness-conformance.target",
      "revision": "helarc-operational-conformance-v7"
    }
  ],
  "objectiveRef": {
    "id": "helarc.operational.harness-conformance.objective",
    "revision": "helarc-operational-evaluation-v7"
  },
  "suiteRef": {
    "id": "helarc.operational.harness-conformance.suite",
    "revision": "helarc-operational-evaluation-v7"
  },
  "campaignRef": {
    "id": "helarc.operational.harness-conformance.campaign",
    "revision": "helarc-operational-evaluation-v7"
  },
  "protocolRevision": "helarc-operational-conformance-v7",
  "status": "passed",
  "trialCount": 7,
  "completedTrialCount": 7,
  "metricCount": 19,
  "gateCount": 10,
  "passedGateCount": 10,
  "failureCodes": [],
  "exclusionCodes": [],
  "missingDataCodes": [],
  "limitations": [
    "Scripted deterministic evidence proves Harness conformance, not real-model or Product effectiveness.",
    "Cleanup truth is read from the terminal Evaluation Trial snapshot after Capture settlement."
  ],
  "acceptedAt": "2026-09-29T00:00:00Z",
  "acceptedBy": "agent-anything-evaluation-maintainers"
});
export const HELARC_EXPLICIT_FINAL_RESULT_OPERATIONAL_BASELINE_ACCEPTANCE = deepFreeze({
  "predecessorAcceptanceRef": {
    "id": "helarc.operational.harness-conformance.baseline-acceptance",
    "revision": "helarc-operational-conformance-v6"
  },
  "successorAcceptanceRef": {
    "id": "helarc.operational.harness-conformance.baseline-acceptance",
    "revision": "helarc-operational-conformance-v7"
  },
  "predecessorReportRef": {
    "id": "helarc.operational.harness-conformance.report",
    "revision": "helarc-operational-evaluation-v6"
  },
  "successorReportRef": {
    "id": "helarc.operational.harness-conformance.report",
    "revision": "helarc-operational-evaluation-v7"
  },
  "comparison": "intentionally_incomparable_exact_target",
  "reliability": "two_independent_campaigns_equivalent",
  "acceptedAt": "2026-09-29T00:00:00Z"
});
export function verifyHelarcExplicitFinalResultOperationalAcceptedBaseline(candidate: HelarcOperationalConformanceReport) {
  const accepted = HELARC_EXPLICIT_FINAL_RESULT_OPERATIONAL_ACCEPTED_BASELINE;
  if (candidate.status !== accepted.status || candidate.digest !== accepted.reportDigest ||
      candidate.report.ref.id !== accepted.reportRef.id || candidate.report.ref.revision !== accepted.reportRef.revision ||
      candidate.report.gateOutcomes.some((gate) => gate.status !== "passed")) {
    throw new TypeError("Explicit-final-result operational candidate does not match the accepted Baseline.");
  }
  return accepted;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
