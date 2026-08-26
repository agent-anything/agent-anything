import { describe, expect, it } from "vitest";

import { FakeProvider } from "../../FakeProvider.js";
import {
  compareHelarcAgentInstructionEffectiveness,
  runHelarcAgentInstructionConformance,
} from "./HelarcAgentInstructionEvaluation.js";
import { captureHelarcProductEffectiveness } from "./HelarcProductEffectivenessCapture.js";
import { createHelarcProductEffectivenessDefinition } from "./HelarcProductEffectivenessDefinition.js";
import {
  createHelarcProductEffectivenessTargetSnapshot,
  createHelarcProductEffectivenessTargetValues,
} from "./HelarcProductEffectivenessProtocol.js";
import { HELARC_PRODUCT_EFFECTIVENESS_TIME } from "./HelarcProductEffectivenessSuite.js";

describe("Helarc Agent Instruction Evaluation", () => {
  it("proves deterministic Harness semantics under paired minimal and production instructions", async () => {
    const report = await runHelarcAgentInstructionConformance();

    expect(report.disposition).toEqual({ status: "comparable" });
    expect(report.pairs).toHaveLength(13);
    expect(report.behaviorCoverage).toEqual([
      "clarification",
      "command",
      "completion",
      "correction",
      "delegation",
      "edit",
      "planning",
      "read",
      "verification",
    ]);
    expect(report.pairs.every((pair) =>
      pair.disposition.status === "comparable" &&
      pair.harnessSemanticsEquivalent &&
      pair.safeProjectionExcludedFullInstructions &&
      pair.minimal.metrics.outcomeCorrect &&
      pair.production.metrics.outcomeCorrect &&
      pair.minimal.target.instructionTarget === "minimal" &&
      pair.production.target.instructionTarget === "production" &&
      pair.minimal.target.instructions.revision !== pair.production.target.instructions.revision &&
      pair.minimal.target.instructionBinding.revision !==
      pair.production.target.instructionBinding.revision
    )).toBe(true);

    const denied = report.pairs.find((pair) => pair.caseId === "denied_command")!;
    const premature = report.pairs.find((pair) => pair.caseId === "premature_completion")!;
    expect(denied.minimal.metrics).toMatchObject({
      outcomeCorrect: true,
      invalidOrUnsafeActionAttempts: 1,
      humanAttentionEvents: 1,
      terminalTruth: true,
    });
    expect(denied.production.metrics).toMatchObject(denied.minimal.metrics);
    expect(premature.minimal.metrics).toMatchObject({
      outcomeCorrect: true,
      outcomeComplete: false,
      terminalTruth: true,
    });
    expect(premature.production.metrics).toMatchObject(premature.minimal.metrics);
  }, 120_000);

  it("compares separately captured real-path instruction targets without calling it Harness conformance", async () => {
    const definition = createHelarcProductEffectivenessDefinition();
    const caseProfile = definition.suite.cases.find((item) =>
      item.id === "repository-investigation"
    )!;
    const suite = Object.freeze({
      ...definition.suite,
      cases: Object.freeze([caseProfile]),
    });
    const capture = async (instructionTarget: "minimal" | "production") =>
      await captureHelarcProductEffectiveness({
        objective: definition.objective,
        suite,
        targetSnapshot: createTargetSnapshot(definition, instructionTarget),
        instructionTarget,
        providerFactory: () => new FakeProvider({
          descriptor: { id: "instruction-evaluation-provider" },
          results: [{
            kind: "succeeded",
            response: {
              output: { kind: "completion", summary: "The timeout is 4500 ms." },
              usage: {
                inputTokens: 20,
                outputTokens: 8,
                totalTokens: 28,
                metadata: {},
              },
              metadata: {},
            },
          }],
        }),
        productVersion: "instruction-evaluation-product-v1",
        model: "fake-model",
        environment: "instruction-evaluation-environment",
        createdAt: HELARC_PRODUCT_EFFECTIVENESS_TIME,
      });
    const [minimal, production] = await Promise.all([
      capture("minimal"),
      capture("production"),
    ]);
    const comparison = compareHelarcAgentInstructionEffectiveness({ minimal, production });

    expect(comparison).toMatchObject({
      claim: "product_instruction_effectiveness",
      disposition: { status: "comparable" },
      requiredPairCount: 3,
      comparablePairCount: 3,
      minimalOutcomeMean: 1,
      productionOutcomeMean: 1,
      outcomeDelta: 0,
    });
  }, 120_000);
});

function createTargetSnapshot(
  definition: ReturnType<typeof createHelarcProductEffectivenessDefinition>,
  instructionTarget: "minimal" | "production",
) {
  return createHelarcProductEffectivenessTargetSnapshot({
    ref: ref(`helarc.product-effectiveness.target.${instructionTarget}`),
    targetRef: ref("helarc.product"),
    objective: definition.objective,
    targetName: "helarc",
    sourceRevision: "instruction-evaluation-target-v1",
    values: createHelarcProductEffectivenessTargetValues({
      instructionTarget,
      productVersion: "instruction-evaluation-product-v1",
      providerId: "instruction-evaluation-provider",
      providerKind: "fake",
      providerRevision: "instruction-evaluation-provider-v1",
      providerEndpoint: "memory://instruction-evaluation-provider",
      providerAuthentication: "none",
      modelId: "fake-model",
      modelRevision: "fake-model-v1",
      environmentId: "instruction-evaluation-environment",
      providerTimeoutMs: 120_000,
      maximumInputBytes: 1_048_576,
      sandboxEnforcement: "disabled",
      limitations: ["Test-only provider output."],
    }),
    disposition: { status: "comparable" },
    createdAt: HELARC_PRODUCT_EFFECTIVENESS_TIME,
  });
}

function ref(id: string) {
  return Object.freeze({ id, revision: "v1" });
}
