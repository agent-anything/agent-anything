import { describe, expect, it } from "vitest";

import { FakeProvider } from "../../FakeProvider.js";
import { captureHelarcProductEffectiveness } from "./HelarcProductEffectivenessCapture.js";
import { createHelarcProductEffectivenessDefinition } from "./HelarcProductEffectivenessDefinition.js";
import {
  createHelarcProductEffectivenessTargetSnapshot,
  createHelarcProductEffectivenessTargetValues,
} from "./HelarcProductEffectivenessProtocol.js";
import { HELARC_PRODUCT_EFFECTIVENESS_TIME } from "./HelarcProductEffectivenessSuite.js";

describe("Helarc Product-effectiveness capture", () => {
  it("captures externally graded evidence through the real Product and Harness path", async () => {
    const definition = createHelarcProductEffectivenessDefinition();
    const caseProfile = definition.suite.cases.find((item) =>
      item.id === "repository-investigation"
    )!;
    const suite = Object.freeze({
      ...definition.suite,
      cases: Object.freeze([caseProfile]),
    });
    const targetSnapshot = createHelarcProductEffectivenessTargetSnapshot({
      ref: ref("helarc.product-effectiveness.target.test"),
      targetRef: ref("helarc.product.test"),
      objective: definition.objective,
      targetName: "helarc",
      sourceRevision: "test-target-v1",
      values: createHelarcProductEffectivenessTargetValues({
        instructionTarget: "production",
        sourceRevision: "test-source-v1",
        sourceDirtyState: "clean",
        sourceTreeDigest: `sha256:${"a".repeat(64)}`,
        packageRevisions: { "@agent-anything/helarc": "test-product-v1" },
        productVersion: "test",
        providerId: "fake-provider",
        providerKind: "fake",
        providerRevision: "test-provider-v1",
        providerEndpoint: "memory://fake-provider",
        providerAuthentication: "none",
        modelId: "fake-model",
        modelRevision: "test-model-v1",
        environmentId: "isolated-test",
        providerTimeoutMs: 120_000,
        maximumInputBytes: 1_048_576,
        sandboxEnforcement: "disabled",
        limitations: ["Test fixture only."],
      }),
      disposition: { status: "comparable" },
      createdAt: HELARC_PRODUCT_EFFECTIVENESS_TIME,
    });

    const bundle = await captureHelarcProductEffectiveness({
      objective: definition.objective,
      suite,
      targetSnapshot,
      instructionTarget: "production",
      providerFactory: () => new FakeProvider({
        results: [{
          kind: "succeeded",
          response: {
            kind: "structured_generation",
            output: { kind: "completion", summary: "The timeout is 4500 ms." },
            responseId: null,
            continuation: null,
            usage: null,
            metadata: {},
          },
        }],
      }),
      productVersion: "test-product-v1",
      model: "test-model",
      environment: "isolated-test",
      createdAt: HELARC_PRODUCT_EFFECTIVENESS_TIME,
    });

    expect(bundle.trials).toHaveLength(3);
    expect(bundle.trials.every((trial) =>
      trial.status === "completed" &&
      trial.outcomeScore === 1 &&
      Object.values(trial.safety).every((value) => value === true) &&
      trial.provenance.scriptedProviderOutput === false
    )).toBe(true);
  });
});

function ref(id: string) {
  return Object.freeze({ id, revision: "v1" });
}
