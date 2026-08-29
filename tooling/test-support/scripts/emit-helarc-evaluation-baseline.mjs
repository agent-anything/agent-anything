import {
  HELARC_RUN_PROGRESS_ACCEPTED_BASELINE,
  HELARC_RUN_TREE_CONTROL_ACCEPTED_BASELINE,
  compareHelarcEvaluationBaseline,
  projectHelarcEvaluationBaselineSignature,
  runHelarcEvaluationBaselineCandidate,
} from "../dist/evaluation-targets/helarc/index.js";
import {
  runContextContinuityEvaluationCandidate,
} from "../dist/context-continuity-evaluation/index.js";
import {
  runRunStopReviewDeterministicEvaluation,
} from "../dist/run-stop-review-evaluation/index.js";

const systemCandidate = await runHelarcEvaluationBaselineCandidate();
const signature = projectHelarcEvaluationBaselineSignature(systemCandidate);
const contextContinuity = await runContextContinuityEvaluationCandidate();
const runStopReview = await runRunStopReviewDeterministicEvaluation();
const comparison = compareHelarcEvaluationBaseline(
  HELARC_RUN_TREE_CONTROL_ACCEPTED_BASELINE,
  systemCandidate,
);
const acceptedComparison = compareHelarcEvaluationBaseline(
  HELARC_RUN_PROGRESS_ACCEPTED_BASELINE,
  systemCandidate,
);

process.stdout.write(`${JSON.stringify({
  schemaVersion: 1,
  kind: "context_continuity_and_helarc_evaluation_candidate",
  predecessor: {
    reportRef: HELARC_RUN_TREE_CONTROL_ACCEPTED_BASELINE.reportRef,
    acceptanceRef: HELARC_RUN_TREE_CONTROL_ACCEPTED_BASELINE.acceptanceRef,
  },
  acceptedSuccessor: {
    reportRef: HELARC_RUN_PROGRESS_ACCEPTED_BASELINE.reportRef,
    acceptanceRef: HELARC_RUN_PROGRESS_ACCEPTED_BASELINE.acceptanceRef,
  },
  systemCandidate: projectSystemCandidate(signature),
  predecessorComparison: projectPredecessorComparison(comparison),
  acceptedSuccessorComparison: projectPredecessorComparison(acceptedComparison),
  contextContinuity: projectContextContinuityCandidate(contextContinuity),
  runStopReview,
  limitations: [
    "The deterministic candidate does not claim general model intelligence.",
    "Context-specific metrics have no fabricated predecessor samples.",
  ],
}, null, 2)}\n`);

function projectContextContinuityCandidate(candidate) {
  const exclusionCounts = {};
  for (const exclusion of candidate.exclusions) {
    exclusionCounts[exclusion.code] = (exclusionCounts[exclusion.code] ?? 0) + 1;
  }
  return {
    revision: candidate.revision,
    target: candidate.target,
    fixtureCount: candidate.fixtures.length,
    fixtures: candidate.fixtures.map((fixture) => ({
      id: fixture.fixtureId,
      attribution: fixture.attribution,
      failureCode: fixture.failureCode,
      projectionOutcome: fixture.projection?.outcome ?? "not_exercised",
      continuationOutcome: fixture.continuation?.outcome ?? "not_exercised",
      providerSupport: fixture.continuation?.providerSupport ?? "not_applicable",
      downstreamOutcome: fixture.downstreamOutcome,
    })),
    metricSummaries: candidate.metrics.map((metric) => ({
      metricRef: metric.ref,
      distribution: metric.distribution,
      uncertainty: metric.uncertainty,
      exclusionCount: metric.exclusions.length,
    })),
    gateOutcomes: candidate.gateOutcomes,
    exclusionCounts,
    limitations: candidate.limitations,
  };
}

function projectSystemCandidate(candidate) {
  return {
    schemaVersion: candidate.schemaVersion,
    kind: candidate.kind,
    corpusRevision: candidate.corpusRevision,
    targetSnapshotRef: candidate.targetSnapshotRef,
    targetManifestDigest: candidate.targetManifestDigest,
    campaignRef: candidate.campaignRef,
    reportRef: candidate.reportRef,
    acceptanceRef: candidate.acceptanceRef,
    publication: candidate.publication,
    metricSummaries: candidate.metrics.map((metric) => ({
      ref: metric.ref,
      definitionRef: metric.definitionRef,
      distribution: metric.distribution,
      uncertainty: metric.uncertainty,
      exclusionCount: metric.exclusions.length,
    })),
    cases: candidate.cases.map((item) => ({
      caseRef: item.caseRef,
      repetitionOrdinal: item.repetitionOrdinal,
      semanticDigest: item.semanticDigest,
      traceIssueCodes: item.traceIssueCodes,
    })),
    limitations: candidate.limitations,
  };
}

function projectPredecessorComparison(comparison) {
  return {
    status: comparison.status,
    differences: comparison.status === "equivalent" ? [] : comparison.differences,
    pairedMetrics: comparison.pairedComparisons.map((item) => ({
      baselineTargetRef: item.baselineTargetRef,
      candidateTargetRef: item.candidateTargetRef,
      pairCount: item.pairs.length,
      exclusionCount: item.exclusions.length,
    })),
  };
}
