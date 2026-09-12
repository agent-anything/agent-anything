import type { HelarcOperationalConformanceReport } from "../operational-evaluation/HelarcOperationalConformanceExecution.js";

export const HELARC_NORMAL_COMPLETION_OPERATIONAL_ACCEPTED_BASELINE = deepFreeze({
  "schemaVersion": 1,
  "kind": "helarc_operational_conformance_baseline",
  "acceptanceRef": {
    "id": "helarc.operational.harness-conformance.baseline-acceptance",
    "revision": "helarc-operational-conformance-v5"
  },
  "reportRef": {
    "id": "helarc.operational.harness-conformance.report",
    "revision": "helarc-operational-evaluation-v5"
  },
  "reportDigest": "50e4632cc38f620ecdcb95f79b3715cf4f3af712ea178b6811381245c50be64a",
  "targetSnapshotRefs": [
    {
      "id": "helarc.operational.harness-conformance.target",
      "revision": "helarc-operational-conformance-v5"
    }
  ],
  "objectiveRef": {
    "id": "helarc.operational.harness-conformance.objective",
    "revision": "helarc-operational-evaluation-v5"
  },
  "suiteRef": {
    "id": "helarc.operational.harness-conformance.suite",
    "revision": "helarc-operational-evaluation-v5"
  },
  "campaignRef": {
    "id": "helarc.operational.harness-conformance.campaign",
    "revision": "helarc-operational-evaluation-v5"
  },
  "protocolRevision": "helarc-operational-conformance-v5",
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
  "acceptedAt": "2026-09-13T00:00:00.000Z",
  "acceptedBy": "agent-anything-evaluation-maintainers"
});
export const HELARC_NORMAL_COMPLETION_OPERATIONAL_BASELINE_ACCEPTANCE = deepFreeze({
  "predecessorAcceptanceRef": {
    "id": "helarc.operational.harness-conformance.baseline-acceptance",
    "revision": "helarc-operational-conformance-v4"
  },
  "successorAcceptanceRef": {
    "id": "helarc.operational.harness-conformance.baseline-acceptance",
    "revision": "helarc-operational-conformance-v5"
  },
  "predecessorReportRef": {
    "id": "helarc.operational.harness-conformance.report",
    "revision": "helarc-operational-evaluation-v4"
  },
  "successorReportRef": {
    "id": "helarc.operational.harness-conformance.report",
    "revision": "helarc-operational-evaluation-v5"
  },
  "comparison": "intentionally_incomparable_exact_target",
  "acceptedAt": "2026-09-13T00:00:00.000Z",
  "reliability": "two_independent_campaigns_equivalent",
  "semanticDifferences": [
    "Normal completion preserves execution facts without in-Run Verification or fabricated task success.",
    "External Evaluation checks observed files, permissions, resource accounting and terminal truth."
  ]
});

export function verifyHelarcNormalCompletionOperationalAcceptedBaseline(candidate: HelarcOperationalConformanceReport): typeof HELARC_NORMAL_COMPLETION_OPERATIONAL_ACCEPTED_BASELINE {
  const accepted = HELARC_NORMAL_COMPLETION_OPERATIONAL_ACCEPTED_BASELINE;
  if (candidate.status !== accepted.status || candidate.digest !== accepted.reportDigest || candidate.report.ref.id !== accepted.reportRef.id || candidate.report.ref.revision !== accepted.reportRef.revision || candidate.trials.length !== accepted.trialCount || candidate.metrics.length !== accepted.metricCount || candidate.report.gateOutcomes.length !== accepted.gateCount || candidate.report.gateOutcomes.some(gate => gate.status !== "passed") || candidate.report.failures.length || candidate.report.exclusions.length || candidate.report.missingData.length) throw new TypeError("Normal-completion operational candidate does not match the accepted Baseline.");
  return accepted;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
