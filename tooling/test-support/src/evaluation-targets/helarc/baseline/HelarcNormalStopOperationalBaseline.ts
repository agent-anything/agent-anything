import type { HelarcOperationalConformanceReport } from "../operational-evaluation/HelarcOperationalConformanceExecution.js";
import { HELARC_RUN_LIFECYCLE_SETTLEMENT_OPERATIONAL_ACCEPTED_BASELINE as predecessor } from "./HelarcRunLifecycleSettlementOperationalBaseline.js";

const revision = "helarc-operational-conformance-v4";
const evaluationRevision = "helarc-operational-evaluation-v4";
const reportDigest = "a5a97ffd12b9f8c8bf909b19a20015e6bd2d9b44d8086695b586984f784f60a3";
const reportRef = {"id":"helarc.operational.harness-conformance.report","revision":"helarc-operational-evaluation-v4"};
const acceptanceRef = { id: predecessor.acceptanceRef.id, revision };

export const HELARC_NORMAL_STOP_OPERATIONAL_ACCEPTED_BASELINE = deepFreeze({
  ...predecessor,
  acceptanceRef,
  reportRef,
  reportDigest,
  targetSnapshotRefs: [{ id: predecessor.targetSnapshotRefs[0]!.id, revision }],
  objectiveRef: { ...predecessor.objectiveRef, revision: evaluationRevision },
  suiteRef: { ...predecessor.suiteRef, revision: evaluationRevision },
  campaignRef: { ...predecessor.campaignRef, revision: evaluationRevision },
  protocolRevision: revision,
  acceptedAt: "2026-09-05T00:00:00.000Z",
});

export const HELARC_NORMAL_STOP_OPERATIONAL_BASELINE_ACCEPTANCE = deepFreeze({
  schemaVersion: 1,
  kind: "helarc_normal_stop_operational_baseline_successor_acceptance",
  acceptedAt: "2026-09-05T00:00:00.000Z",
  predecessorAcceptanceRef: predecessor.acceptanceRef,
  successorAcceptanceRef: acceptanceRef,
  predecessorReportRef: predecessor.reportRef,
  successorReportRef: reportRef,
  comparison: "intentionally_incomparable_exact_target",
  semanticDifferences: [
    "Normal stopped settlement is distinct from success, failure, cancellation, and active suspension.",
    "Required Verification and unsettled descendant obligations remain enforced.",
    "Historical operational Reports and acceptances remain immutable.",
  ],
  outcomeQuality: "passed",
  safety: "passed",
  reliability: "deterministic_candidate",
  limitations: ["Scripted deterministic evidence proves Harness conformance, not real-model or Product effectiveness.","Cleanup truth is read from the terminal Evaluation Trial snapshot after Capture settlement."],
});

export function verifyHelarcNormalStopOperationalAcceptedBaseline(
  candidate: HelarcOperationalConformanceReport,
): typeof HELARC_NORMAL_STOP_OPERATIONAL_ACCEPTED_BASELINE {
  const accepted = HELARC_NORMAL_STOP_OPERATIONAL_ACCEPTED_BASELINE;
  if (
    candidate.status !== accepted.status ||
    candidate.digest !== reportDigest ||
    candidate.report.ref.id !== reportRef.id ||
    candidate.report.ref.revision !== reportRef.revision ||
    candidate.trials.length !== accepted.trialCount ||
    candidate.metrics.length !== accepted.metricCount ||
    candidate.report.gateOutcomes.length !== accepted.gateCount ||
    candidate.report.gateOutcomes.some(({ status }) => status !== "passed") ||
    candidate.report.failures.length > 0 ||
    candidate.report.exclusions.length > 0 ||
    candidate.report.missingData.length > 0
  ) throw new TypeError("Normal-stop operational candidate does not match the accepted Baseline.");
  return accepted;
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}
