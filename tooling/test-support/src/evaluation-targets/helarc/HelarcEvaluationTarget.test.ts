import { describe, expect, it } from "vitest";
import {
  HELARC_EVALUATION_TIME,
  adaptHelarcExternalBenchmarkManifest,
  createHelarcEvaluationCorpus,
} from "./HelarcEvaluationCorpus.js";
import {
  compareHelarcEvaluationBaseline,
  runHelarcEvaluationBaselineCandidate,
  type HelarcEvaluationBaselineArtifact,
} from "./HelarcEvaluationExecution.js";

let sharedCandidate: Promise<HelarcEvaluationBaselineArtifact> | null = null;

function candidate(): Promise<HelarcEvaluationBaselineArtifact> {
  sharedCandidate ??= runHelarcEvaluationBaselineCandidate();
  return sharedCandidate;
}

describe("Helarc Phase26 Evaluation target", () => {
  it("declares five deterministic Cases and adapts external manifests without bundled data", () => {
    const corpus = createHelarcEvaluationCorpus();
    expect(corpus.cases.map((item) => item.scenario)).toEqual([
      "controlled_patch",
      "denied_command",
      "inspect_and_complete",
      "malformed_output_retry",
      "search",
    ]);
    const external = adaptHelarcExternalBenchmarkManifest({
      benchmarkRef: { id: "benchmark.reference", revision: "r1" },
      source: "https://benchmark.invalid/manifest",
      sourceRevision: "dataset-r1",
      license: "Apache-2.0",
      cases: [{
        caseId: "case-a",
        name: "External Case A",
        taskText: "Inspect the supplied external fixture.",
        fixtureRef: { id: "external.fixture.a", revision: "r1" },
        expectedClaimRef: { id: "external.claim.a", revision: "r1" },
        pairingKey: "external-pair-a",
        visibility: "public",
        validFrom: HELARC_EVALUATION_TIME,
        validUntil: null,
      }],
    });

    expect(external).toHaveLength(1);
    expect(external[0]).toMatchObject({
      partition: { purpose: "benchmark", visibility: "public" },
      provenance: { metadata: { bundledThirdPartyData: false } },
    });
    expect(() => adaptHelarcExternalBenchmarkManifest({
      benchmarkRef: { id: "empty", revision: "r1" },
      source: "source",
      sourceRevision: "r1",
      license: null,
      cases: [],
    })).toThrow(/at least one Case/);
  });

  it("runs the real Helarc Product and Harness path twice for every Case", async () => {
    const baselineCandidate = await candidate();
    const denied = baselineCandidate.cases.filter((item) => item.caseRef.id.endsWith("denied-command"));
    const malformed = baselineCandidate.cases.filter((item) => item.caseRef.id.endsWith("malformed-output-retry"));

    expect(baselineCandidate.cases).toHaveLength(10);
    expect(baselineCandidate.cases.filter((item) =>
      item.trialStatus !== "completed" ||
      item.captureStatus !== "complete" ||
      !item.outcomeGradePassed ||
      !item.safetyGradePassed)).toEqual([]);
    expect(denied).toHaveLength(2);
    expect(denied.every((item) => item.targetOutcomeStatus === "blocked")).toBe(true);
    expect(malformed).toHaveLength(2);
    expect(malformed.every((item) => item.targetOutcomeStatus === "succeeded")).toBe(true);
    expect(baselineCandidate.report.gateOutcomes.map((gate) => gate.status)).toEqual([
      "passed",
      "passed",
    ]);
    expect(baselineCandidate.metrics.every((metric) => metric.samples.length === 10)).toBe(true);

    const serialized = JSON.stringify(baselineCandidate);
    expect(serialized).not.toContain("agent-anything-helarc-eval-");
    expect(serialized).not.toContain("rootPath");
    expect(serialized).not.toContain("rootRef");
  }, 120_000);

  it("repeats to an equivalent semantic baseline despite fresh temporary Workspaces", async () => {
    const first = await candidate();
    const second = await runHelarcEvaluationBaselineCandidate();

    expect(compareHelarcEvaluationBaseline(first, second)).toMatchObject({
      status: "equivalent",
    });
  }, 120_000);

  it("rejects non-equivalent targets before interpreting regression", async () => {
    const baselineCandidate = await candidate();
    const changed = Object.freeze({
      ...baselineCandidate,
      targetSnapshotRef: Object.freeze({
        ...baselineCandidate.targetSnapshotRef,
        revision: `${baselineCandidate.targetSnapshotRef.revision}-changed`,
      }),
    }) as HelarcEvaluationBaselineArtifact;

    expect(compareHelarcEvaluationBaseline(baselineCandidate, changed)).toEqual({
      status: "incomparable",
      differences: ["target_snapshot_ref"],
      pairedComparisons: [],
    });
  }, 120_000);
});
