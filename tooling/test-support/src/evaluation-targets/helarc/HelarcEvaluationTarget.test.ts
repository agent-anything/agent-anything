import { describe, expect, it } from "vitest";
import { createEvaluationTrial } from "@agent-anything/evaluation/trial";
import type { ProviderCallResult } from "@agent-anything/model-interaction";
import { FakeProvider } from "../../FakeProvider.js";
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
import {
  createHelarcEvaluationTargetAdapter,
  executeHelarcEvaluationCase,
} from "./HelarcEvaluationTarget.js";

let sharedCandidate: Promise<HelarcEvaluationBaselineArtifact> | null = null;

function candidate(): Promise<HelarcEvaluationBaselineArtifact> {
  sharedCandidate ??= runHelarcEvaluationBaselineCandidate();
  return sharedCandidate;
}

describe("Helarc deterministic Evaluation target", () => {
  it("declares the operational deterministic Cases and adapts external manifests without bundled data", () => {
    const corpus = createHelarcEvaluationCorpus();
    expect(corpus.cases.map((item) => item.scenario)).toEqual([
      "controlled_file_write",
      "denied_command",
      "failed_check_recovery",
      "inspect_and_complete",
      "malformed_output_retry",
      "multi_file_mutation",
      "ordinary_shell_verification",
      "premature_completion",
      "search",
      "stale_evidence",
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

    expect(baselineCandidate.cases).toHaveLength(20);
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
    expect(baselineCandidate.metrics.every((metric) => metric.samples.length === 20)).toBe(true);

    const serialized = JSON.stringify(baselineCandidate);
    expect(serialized).not.toContain("agent-anything-helarc-eval-");
    expect(serialized).not.toContain("rootPath");
    expect(serialized).not.toContain("rootRef");
  }, 120_000);

  it("repeats to an equivalent semantic baseline despite fresh temporary Workspaces", async () => {
    const first = await candidate();
    const second = await runHelarcEvaluationBaselineCandidate();
    const comparison = compareHelarcEvaluationBaseline(first, second);

    expect(comparison).toMatchObject({
      status: "equivalent",
    });
  }, 120_000);

  it("calibrates ordinary-operation Verification, recovery, freshness, and completion", async () => {
    const corpus = createHelarcEvaluationCorpus();
    const expectations = [
      ["ordinary_shell_verification", "succeeded", "satisfied", "completion_eligible"],
      ["failed_check_recovery", "succeeded", "satisfied", "completion_eligible"],
      ["multi_file_mutation", "succeeded", "satisfied", "completion_eligible"],
      ["stale_evidence", "blocked", "violated", "blocked_violated"],
      ["premature_completion", "blocked", "violated", "blocked_violated"],
    ] as const;

    const outcomes = await Promise.all(expectations.map(async ([scenario]) =>
      invokeCase(corpus, requireCase(corpus, scenario))));

    for (const [index, [, outcomeStatus, requirementState, gateStatus]] of expectations.entries()) {
      const outcome = outcomes[index];
      if (outcome === undefined) throw new TypeError("Missing Verification Evaluation outcome.");
      const verificationSummary = outcome.capture.capture.slots.find(
        (slot) => slot.slotId === "verification-summary",
      );
      expect(outcome.observation.outcome.status).toBe(outcomeStatus);
      expect(verificationSummary).toMatchObject({
        owner: "verification",
        required: true,
        status: "captured",
        content: {
          kind: "inline",
          value: {
            requirements: expect.arrayContaining([
              expect.objectContaining({ state: requirementState }),
            ]),
            attempts: expect.any(Array),
            results: expect.any(Array),
            assessments: expect.any(Array),
            gate: { status: gateStatus },
          },
        },
      });
    }
  }, 120_000);

  it("proves a recursive Helarc Agent chain through Runtime, Host, and Product projections", async () => {
    const corpus = createHelarcEvaluationCorpus();
    const source = requireCase(corpus, "inspect_and_complete");
    const recursiveCase: HelarcEvaluationCaseDefinition = Object.freeze({
      ...source,
      expectedClaim: Object.freeze({
        ...source.expectedClaim,
        agentSummary: "Root complete.",
      }),
    });
    const trial = createTrial(corpus, recursiveCase, "recursive-run-tree");
    const material = await executeHelarcEvaluationCase({
      trial,
      caseDefinition: recursiveCase,
      provider: new FakeProvider({
        descriptor: { id: "run-tree-conformance-provider" },
        results: [
          scriptedSuccess({
            kind: "tool_call",
            toolName: "Agent",
            reason: "Delegate bounded child work.",
            input: { prompt: "child-private-instruction", description: "Child work" },
          }, 1),
          scriptedSuccess({
            kind: "tool_call",
            toolName: "Agent",
            reason: "Delegate bounded grandchild work.",
            input: { prompt: "grandchild-private-instruction", description: "Grandchild work" },
          }, 2),
          scriptedSuccess({ kind: "completion", summary: "Grandchild complete." }, 3),
          scriptedSuccess({ kind: "completion", summary: "Child complete." }, 4),
          scriptedSuccess({ kind: "completion", summary: "Root complete." }, 5),
        ],
      }),
      signal: new AbortController().signal,
      runTreeLimits: {
        maxTotalDescendantRuns: 2,
        maxActiveDescendantRuns: 2,
        maxDescendantDepth: 2,
      },
    });

    expect(material.runResult.status, JSON.stringify(material.runResult, null, 2))
      .toBe("succeeded");
    expect(material.hostProjection.runTree).toMatchObject({
      totalDescendantRuns: 2,
      activeDescendantRuns: 0,
      nodes: [
        { depth: 0, status: "succeeded" },
        { depth: 1, status: "succeeded" },
        { depth: 2, status: "succeeded" },
      ],
    });

    const started = material.runtimeEvents.filter((event) => event.name === "run.started");
    expect(started.map((event) => [event.runId, event.lineage.kind, event.lineage.depth]))
      .toEqual([
        [`${trial.ref.id}.harness-run`, "root", 0],
        [`${trial.ref.id}.harness-run.2`, "descendant", 1],
        [`${trial.ref.id}.harness-run.3`, "descendant", 2],
      ]);
    for (const runId of new Set(material.runtimeEvents.map((event) => event.runId))) {
      const events = material.runtimeEvents.filter((event) => event.runId === runId);
      expect(events.map((event) => event.sequence))
        .toEqual(events.map((_, index) => index + 1));
    }

    const activity = material.productProjection.activity;
    expect(activity.map((item) => item.sequence))
      .toEqual(activity.map((_, index) => index + 1));
    expect(new Set(activity.map((item) => item.source.runId))).toEqual(new Set([
      `${trial.ref.id}.harness-run`,
      `${trial.ref.id}.harness-run.2`,
      `${trial.ref.id}.harness-run.3`,
    ]));
    const safeProjection = JSON.stringify({
      host: material.hostProjection,
      product: material.productProjection,
    });
    expect(safeProjection).not.toContain("child-private-instruction");
    expect(safeProjection).not.toContain("grandchild-private-instruction");
    expect(safeProjection).not.toContain("agent-anything-helarc-product-eval-");
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
    expect(
      denied.observation.outcome,
      JSON.stringify(denied.observation, null, 2),
    ).toMatchObject({
      status: "blocked",
      owner: "permission",
    });
    expect(providerFailure.observation.outcome).toMatchObject({
      status: "failed",
      owner: "provider",
      code: "provider_request_failed",
    });
    const verificationSummary = completed.capture.capture.slots.find(
      (slot) => slot.slotId === "verification-summary",
    );
    expect(verificationSummary).toMatchObject({
      owner: "verification",
      required: true,
      status: "captured",
      content: {
        kind: "inline",
        value: {
          requirements: expect.any(Array),
          attempts: expect.any(Array),
          results: expect.any(Array),
          assessments: expect.any(Array),
          gate: { status: "completion_eligible" },
        },
      },
    });
    const serializedVerification = JSON.stringify(verificationSummary);
    expect(serializedVerification).not.toContain("rootPath");
    expect(serializedVerification).not.toContain("rawEvidence");
    expect(serializedVerification).not.toContain("commandLine");
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

function scriptedSuccess(output: unknown, sequence: number): ProviderCallResult {
  return Object.freeze({
    kind: "succeeded" as const,
    response: Object.freeze({
      kind: "structured_generation" as const,
      output: output as never,
      responseId: null,
      continuation: null,
      usage: Object.freeze({
        inputTokens: 10 + sequence,
        outputTokens: 4 + sequence,
        totalTokens: 14 + (sequence * 2),
        metadata: Object.freeze({ source: "run-tree-conformance" }),
      }),
      metadata: Object.freeze({ scriptSequence: sequence }),
    }),
  });
}
