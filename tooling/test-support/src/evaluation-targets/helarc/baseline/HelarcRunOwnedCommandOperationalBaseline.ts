import type {HelarcOperationalConformanceReport} from "../operational-evaluation/HelarcOperationalConformanceExecution.js";

export const HELARC_RUN_OWNED_COMMAND_OPERATIONAL_ACCEPTED_BASELINE = deepFreeze({
  "schemaVersion": 1,
  "kind": "helarc_operational_conformance_baseline",
  "acceptanceRef": {
    "id": "helarc.operational.harness-conformance.baseline-acceptance",
    "revision": "helarc-operational-conformance-v6"
  },
  "reportRef": {
    "id": "helarc.operational.harness-conformance.report",
    "revision": "helarc-operational-evaluation-v6"
  },
  "reportDigest": "2a0a8b6e064fac5bf6de412a7b15fb2c046875dbc3b1a183e4f72b6292c474f1",
  "targetSnapshotRefs": [
    {
      "id": "helarc.operational.harness-conformance.target",
      "revision": "helarc-operational-conformance-v6"
    }
  ],
  "objectiveRef": {
    "id": "helarc.operational.harness-conformance.objective",
    "revision": "helarc-operational-evaluation-v6"
  },
  "suiteRef": {
    "id": "helarc.operational.harness-conformance.suite",
    "revision": "helarc-operational-evaluation-v6"
  },
  "campaignRef": {
    "id": "helarc.operational.harness-conformance.campaign",
    "revision": "helarc-operational-evaluation-v6"
  },
  "protocolRevision": "helarc-operational-conformance-v6",
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
  "acceptedAt": "2026-09-17T00:00:00Z",
  "acceptedBy": "agent-anything-evaluation-maintainers"
});
export const HELARC_RUN_OWNED_COMMAND_OPERATIONAL_BASELINE_ACCEPTANCE = deepFreeze({
  "predecessorAcceptanceRef": {
    "id": "helarc.operational.harness-conformance.baseline-acceptance",
    "revision": "helarc-operational-conformance-v5"
  },
  "successorAcceptanceRef": {
    "id": "helarc.operational.harness-conformance.baseline-acceptance",
    "revision": "helarc-operational-conformance-v6"
  },
  "predecessorReportRef": {
    "id": "helarc.operational.harness-conformance.report",
    "revision": "helarc-operational-evaluation-v5"
  },
  "successorReportRef": {
    "id": "helarc.operational.harness-conformance.report",
    "revision": "helarc-operational-evaluation-v6"
  },
  "comparison": "intentionally_incomparable_exact_target",
  "reliability": "two_independent_campaigns_equivalent",
  "acceptedAt": "2026-09-17T00:00:00Z"
});
export function verifyHelarcRunOwnedCommandOperationalAcceptedBaseline(candidate: HelarcOperationalConformanceReport) {
  const accepted = HELARC_RUN_OWNED_COMMAND_OPERATIONAL_ACCEPTED_BASELINE;
  if (candidate.status !== accepted.status || candidate.digest !== accepted.reportDigest ||
      candidate.report.ref.id !== accepted.reportRef.id || candidate.report.ref.revision !== accepted.reportRef.revision ||
      candidate.report.gateOutcomes.some((gate) => gate.status !== "passed")) {
    throw new TypeError("Run-owned-command operational candidate does not match the accepted Baseline.");
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
