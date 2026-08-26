import { describe, expect, it } from "vitest";

import {
  compareHelarcOperationalInstructionTargets,
  createHelarcOperationalEvaluationProgram,
  createHelarcOperationalTargetSnapshot,
  HELARC_OPERATIONAL_STOCHASTIC_REPETITIONS,
  HELARC_OPERATIONAL_TARGET_INPUTS,
  type HelarcOperationalTargetValues,
} from "./index.js";

describe("Helarc operational Evaluation protocol", () => {
  it("defines three independent Objectives with exact protocol owners", () => {
    const program = createHelarcOperationalEvaluationProgram();
    const profiles = Object.values(program.profiles);

    expect(profiles.map((profile) => profile.claim).sort()).toEqual([
      "harness_conformance",
      "minimal_instruction_resilience",
      "production_product_effectiveness",
    ]);
    expect(new Set(profiles.map((profile) => profile.objective.ref.id)).size).toBe(3);
    expect(new Set(profiles.map((profile) => profile.suite.ref.id)).size).toBe(3);
    expect(program.profiles.harness_conformance.repetitions).toBe(1);
    expect(program.profiles.minimal_instruction_resilience.repetitions)
      .toBe(HELARC_OPERATIONAL_STOCHASTIC_REPETITIONS);
    expect(program.profiles.production_product_effectiveness.reportIntent)
      .toBe("comparison");
  });

  it("binds every Objective to the complete immutable behavior-input manifest", () => {
    const expected = HELARC_OPERATIONAL_TARGET_INPUTS.map((item) => item.key).sort();
    for (const profile of Object.values(createHelarcOperationalEvaluationProgram().profiles)) {
      expect(profile.objective.behaviorInputRequirements.map((item) => item.key).sort())
        .toEqual(expected);
      expect(profile.objective.behaviorInputRequirements.every((item) => item.required))
        .toBe(true);
      expect(profile.objective.comparisonBasis).toMatchObject({
        safetyAndValidityGatesPrecedeOutcome: true,
        diagnosticMetricsDoNotCompensateGates: true,
      });
    }
  });

  it("keeps safety gates and diagnostics separate and names interaction honestly", () => {
    const profile = createHelarcOperationalEvaluationProgram()
      .profiles.production_product_effectiveness;
    const safety = profile.metrics.filter((metric) => metric.dimension === "safety");
    const interaction = profile.metrics.find((metric) =>
      metric.source.kind === "measurement" &&
      metric.source.measurementId === "human_interaction"
    );

    expect(safety).toHaveLength(8);
    expect(safety.every((metric) => metric.role === "gate" &&
      metric.gateThreshold?.value === 1)).toBe(true);
    expect(interaction).toMatchObject({
      dimension: "collaboration",
      role: "informational",
      unit: "count",
    });
    expect(JSON.stringify(profile)).not.toContain("human_attention");
  });

  it("requires attributable terminal, effect, Verification, environment, and cleanup Capture", () => {
    const profile = createHelarcOperationalEvaluationProgram().profiles.harness_conformance;
    const required = profile.capturePolicy.slots
      .filter((slot) => slot.required)
      .map((slot) => slot.id)
      .sort();

    expect(required).toEqual([
      "actions_and_operations",
      "cleanup",
      "effects",
      "environment",
      "run_tree",
      "terminal",
      "verification",
    ]);
    expect(profile.capturePolicy.metadata).toMatchObject({
      ownerAttributed: true,
      completeInstructionTextExcluded: true,
      credentialsExcluded: true,
    });
  });

  it("admits paired instruction targets only when all other manifest inputs match", () => {
    const profile = createHelarcOperationalEvaluationProgram()
      .profiles.production_product_effectiveness;
    const minimal = createHelarcOperationalTargetSnapshot({
      profile,
      ref: ref("target.minimal"),
      targetRef: ref("helarc.minimal"),
      sourceRevision: "source-v1",
      values: targetValues("minimal", "model-a"),
      targetName: "minimal",
    });
    const production = createHelarcOperationalTargetSnapshot({
      profile,
      ref: ref("target.production"),
      targetRef: ref("helarc.production"),
      sourceRevision: "source-v1",
      values: targetValues("production", "model-a"),
      targetName: "production",
    });
    const changedModel = createHelarcOperationalTargetSnapshot({
      profile,
      ref: ref("target.changed-model"),
      targetRef: ref("helarc.production"),
      sourceRevision: "source-v1",
      values: targetValues("production", "model-b"),
      targetName: "production",
    });

    expect(compareHelarcOperationalInstructionTargets({
      baseline: minimal,
      candidate: production,
    })).toEqual({
      status: "comparable",
      differences: ["manifest.agent", "manifest.instructions"],
    });
    expect(compareHelarcOperationalInstructionTargets({
      baseline: minimal,
      candidate: changedModel,
    })).toMatchObject({
      status: "incomparable",
      differences: expect.arrayContaining(["manifest.model"]),
    });
  });

  it("rejects protected target material instead of publishing it in a snapshot", () => {
    const profile = createHelarcOperationalEvaluationProgram()
      .profiles.production_product_effectiveness;
    const values = {
      ...targetValues("production", "model-a"),
      provider: { id: "provider-a", apiKey: "not-admissible" },
    } as HelarcOperationalTargetValues;

    expect(() => createHelarcOperationalTargetSnapshot({
      profile,
      ref: ref("target.unsafe"),
      targetRef: ref("helarc.production"),
      sourceRevision: "source-v1",
      values,
      targetName: "production",
    })).toThrow("cannot include protected field");
  });
});

function targetValues(
  instructionTarget: "minimal" | "production",
  model: string,
): HelarcOperationalTargetValues {
  return Object.freeze({
    implementation: { revision: "repo-v1", dirtyState: "clean" },
    product: { id: "helarc", revision: "product-v1" },
    agent: { id: "helarc", revision: `agent-${instructionTarget}-v1` },
    instructions: {
      target: instructionTarget,
      release: `${instructionTarget}-v1`,
      digest: `sha256:${instructionTarget}`,
      completeTextExcluded: true,
    },
    model: { id: model, revision: "model-revision-v1" },
    provider: { id: "provider-a", revision: "provider-v1", authentication: "none" },
    execution: { revision: "execution-v1" },
    tool_exposure: { revision: "tools-v1" },
    policy: { revision: "policy-v1" },
    permission: { revision: "permission-v1" },
    sandbox: { revision: "sandbox-v1" },
    context: { revision: "context-v1" },
    run_state: { revision: "run-state-v1" },
    verification: { revision: "verification-v1" },
    workspace: { identity: "workspace-fixture-v1" },
    fixture: { revision: "fixture-v1", digest: "sha256:fixture" },
    environment: { revision: "environment-v1", fingerprint: "environment-a" },
    evaluation_protocol: { revision: "protocol-v1" },
    capture_policy: { revision: "capture-v1" },
    graders: { revisions: ["grader-v1"] },
    metrics: { revisions: ["metrics-v1"] },
    budget: { durationMs: 60_000, operations: 50 },
    limitations: { values: ["synthetic-fixture"] },
  });
}

function ref(id: string) {
  return Object.freeze({ id, revision: "v1" });
}

