import { describe, expect, it } from "vitest";

import { FakeProvider } from "../../FakeProvider.js";
import { captureHelarcProductEffectiveness } from "./HelarcProductEffectivenessCapture.js";
import { createHelarcProductEffectivenessDefinition } from "./HelarcProductEffectivenessDefinition.js";
import { createHelarcProductEffectivenessTargetSnapshot } from "./HelarcProductEffectivenessProtocol.js";
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
      values: {
        product: { id: "helarc", version: "test" },
        agent: { id: "helarc-code-agent", revision: "test" },
        prompt: { revision: "test-prompt" },
        model: { id: "test-model" },
        provider: { id: "test-provider" },
        tool_catalog: { revision: "test-catalog" },
        environment: { id: "isolated-test" },
        settings: { revision: "test-settings" },
        permission: { profile: "full_access" },
        budget: { maximumDurationMs: 300_000, maximumOperations: 100 },
        limitations: { items: ["Test fixture only."] },
      },
      createdAt: HELARC_PRODUCT_EFFECTIVENESS_TIME,
    });

    const bundle = await captureHelarcProductEffectiveness({
      objective: definition.objective,
      suite,
      targetSnapshot,
      providerFactory: () => new FakeProvider({
        results: [{
          kind: "succeeded",
          response: {
            output: { kind: "completion", summary: "The timeout is 4500 ms." },
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
