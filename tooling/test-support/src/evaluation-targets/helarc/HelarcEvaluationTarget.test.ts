import { describe, expect, it } from "vitest";
import { createEvaluationTrial } from "@agent-anything/evaluation/trial";
import {
  HELARC_EVALUATION_TIME,
  adaptHelarcExternalBenchmarkManifest,
  createHelarcEvaluationCorpus,
  type HelarcEvaluationCaseDefinition,
  type HelarcEvaluationCorpus,
  type HelarcEvaluationScenario,
} from "./HelarcEvaluationCorpus.js";
import {
  compareHelarcEvaluationBaseline,
  runHelarcEvaluationBaselineCandidate,
  type HelarcEvaluationBaselineArtifact,
} from "./HelarcEvaluationExecution.js";
import { createHelarcEvaluationTargetAdapter } from "./HelarcEvaluationTarget.js";

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

  it("retains typed Product, Permission, and Provider outcome owners", async () => {
    const corpus = createHelarcEvaluationCorpus();
    const completed = await invokeCase(corpus, requireCase(corpus, "inspect_and_complete"));
    const denied = await invokeCase(corpus, requireCase(corpus, "denied_command"));
    const secret = "phase26-provider-secret-must-not-escape";
    const providerFailureSource = requireCase(corpus, "inspect_and_complete");
    const providerFailureCase: HelarcEvaluationCaseDefinition = Object.freeze({
      ...providerFailureSource,
      script: Object.freeze({
        ...providerFailureSource.script,
        ref: Object.freeze({
          id: `${providerFailureSource.script.ref.id}.provider-failure`,
          revision: providerFailureSource.script.ref.revision,
        }),
        responses: Object.freeze([{
          kind: "failed" as const,
          failure: Object.freeze({
            category: "authentication",
            code: "provider_authentication_failed",
            message: `The scripted Provider rejected ${secret}.`,
            metadata: Object.freeze({}),
          }),
        }]),
      }),
    });
    const providerFailure = await invokeCase(corpus, providerFailureCase);

    expect(completed.observation.outcome).toMatchObject({
      status: "succeeded",
      owner: "helarc.product",
    });
    expect(denied.observation.outcome).toMatchObject({
      status: "blocked",
      owner: "permission",
    });
    expect(providerFailure.observation.outcome).toMatchObject({
      status: "failed",
      owner: "provider",
      code: "provider_request_failed",
    });
    const serialized = JSON.stringify(providerFailure);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("agent-anything-helarc-eval-");
  }, 120_000);

  it("rejects invalid fixtures and mismatched leases without publishing target behavior", async () => {
    const corpus = createHelarcEvaluationCorpus();
    const source = requireCase(corpus, "inspect_and_complete");
    const firstFile = source.fixture.files[0];
    if (firstFile === undefined) throw new TypeError("The fixture requires one source file.");
    const invalidFixtureCase: HelarcEvaluationCaseDefinition = Object.freeze({
      ...source,
      fixture: Object.freeze({
        ...source.fixture,
        files: Object.freeze([{ ...firstFile, path: "../escape.txt" }]),
      }),
    });
    const invalidAdapter = createHelarcEvaluationTargetAdapter(Object.freeze({
      ...corpus,
      cases: Object.freeze([invalidFixtureCase]),
    }));
    const invalidTrial = createTrial(corpus, invalidFixtureCase, "invalid-fixture");
    const signal = new AbortController().signal;
    const preparation = await invalidAdapter.environment.prepare({
      trial: invalidTrial,
      signal,
      deadlineAt: null,
    });

    expect(preparation).toMatchObject({
      status: "failed",
      failure: {
        code: "evaluation_environment_failed",
        stage: "environment",
        causeOwner: "evaluation.environment",
      },
    });

    const adapter = createHelarcEvaluationTargetAdapter(corpus);
    const trial = createTrial(corpus, source, "mismatched-lease");
    const prepared = await adapter.environment.prepare({ trial, signal, deadlineAt: null });
    if (prepared.status !== "prepared") throw new TypeError("Expected a prepared fixture.");
    try {
      const invocation = await adapter.target.invoke({
        trial,
        leaseRef: { ...prepared.lease.ref, id: `${prepared.lease.ref.id}.unknown` },
        signal,
        deadlineAt: null,
      });
      expect(invocation).toMatchObject({
        status: "failed",
        failure: {
          code: "evaluation_invocation_failed",
          stage: "invocation",
          causeOwner: "evaluation.target.helarc",
        },
      });
    } finally {
      await adapter.environment.cleanup({ trial, lease: prepared.lease, signal });
    }
  }, 120_000);
});

function requireCase(
  corpus: HelarcEvaluationCorpus,
  scenario: HelarcEvaluationScenario,
): HelarcEvaluationCaseDefinition {
  const result = corpus.cases.find((item) => item.scenario === scenario);
  if (result === undefined) throw new TypeError(`Missing Helarc Evaluation Case '${scenario}'.`);
  return result;
}

function createTrial(
  corpus: HelarcEvaluationCorpus,
  caseDefinition: HelarcEvaluationCaseDefinition,
  suffix: string,
) {
  return createEvaluationTrial({
    ref: {
      id: `${caseDefinition.definition.ref.id}.${suffix}.trial`,
      revision: caseDefinition.definition.ref.revision,
    },
    campaignRef: corpus.campaign.ref,
    targetSnapshotRef: corpus.targetSnapshot.ref,
    caseRef: caseDefinition.definition.ref,
    repetitionOrdinal: 1,
    seed: `phase26-${suffix}-seed`,
    pairingKey: caseDefinition.definition.pairingKey,
    environmentProtocolRef: corpus.campaign.environmentProtocolRef,
    createdAt: HELARC_EVALUATION_TIME,
    metadata: {},
  });
}

async function invokeCase(
  corpus: HelarcEvaluationCorpus,
  caseDefinition: HelarcEvaluationCaseDefinition,
) {
  const scopedCorpus: HelarcEvaluationCorpus = Object.freeze({
    ...corpus,
    cases: Object.freeze([caseDefinition]),
  });
  const adapter = createHelarcEvaluationTargetAdapter(scopedCorpus);
  const trial = createTrial(corpus, caseDefinition, caseDefinition.scenario);
  const signal = new AbortController().signal;
  const preparation = await adapter.environment.prepare({ trial, signal, deadlineAt: null });
  if (preparation.status !== "prepared") throw new TypeError("Expected a prepared fixture.");
  try {
    const invocation = await adapter.target.invoke({
      trial,
      leaseRef: preparation.lease.ref,
      signal,
      deadlineAt: null,
    });
    if (invocation.status !== "observed") throw new TypeError("Expected observed target behavior.");
    const capture = await adapter.capture.capture({
      captureRef: {
        id: `${trial.ref.id}.capture`,
        revision: trial.ref.revision,
      },
      trialRef: trial.ref,
      targetSnapshotRef: trial.targetSnapshotRef,
      caseRef: trial.caseRef,
      policyRef: corpus.capturePolicy.ref,
      environmentRef: preparation.lease.ref,
      targetObservationRef: invocation.observation.ref,
      signal,
      deadlineAt: null,
    });
    return Object.freeze({ observation: invocation.observation, capture });
  } finally {
    await adapter.environment.cleanup({ trial, lease: preparation.lease, signal });
  }
}
