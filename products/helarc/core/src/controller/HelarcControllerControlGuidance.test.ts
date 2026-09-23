import { describe, expect, it } from "vitest";
import {
  createHelarcControllerControlDefinitions,
  HELARC_CONTROLLER_CONTROL_GUIDANCE,
} from "./HelarcControllerControlGuidance.js";

describe("Helarc Controller Control Guidance", () => {
  it("defines the complete non-Tool update_plan callable", () => {
    const definitions = createHelarcControllerControlDefinitions(
      HELARC_CONTROLLER_CONTROL_GUIDANCE,
      { maxSteps: 24, maxStepLength: 500, maxExplanationLength: 2_000 },
    );

    expect(definitions.map(({ name }) => name)).toEqual(["update_plan"]);
    expect(definitions.every(({ description }) => description.length > 300)).toBe(true);
    expect(definitions.find(({ name }) => name === "update_plan")?.inputSchema)
      .toMatchObject({
        properties: {
          explanation: { maxLength: 2_000 },
          plan: {
            maxItems: 24,
            items: {
              properties: {
                step: { maxLength: 500 },
                status: { enum: ["pending", "in_progress", "completed"] },
              },
            },
          },
        },
      });
  });

  it("changes final definitions when exact Run Plan limits change", () => {
    const first = createHelarcControllerControlDefinitions(
      HELARC_CONTROLLER_CONTROL_GUIDANCE,
      { maxSteps: 8, maxStepLength: 500, maxExplanationLength: 2_000 },
    );
    const second = createHelarcControllerControlDefinitions(
      HELARC_CONTROLLER_CONTROL_GUIDANCE,
      { maxSteps: 16, maxStepLength: 500, maxExplanationLength: 2_000 },
    );

    expect(first).not.toEqual(second);
    expect(HELARC_CONTROLLER_CONTROL_GUIDANCE.revision)
      .toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(Object.isFrozen(HELARC_CONTROLLER_CONTROL_GUIDANCE.entries)).toBe(true);
  });

  it("guides timely and truthful Plan updates without requiring closure bookkeeping", () => {
    const [definition] = createHelarcControllerControlDefinitions(
      HELARC_CONTROLLER_CONTROL_GUIDANCE,
      { maxSteps: 24, maxStepLength: 500, maxExplanationLength: 2_000 },
    );

    expect(definition?.description).toContain("after a step's outcome is established");
    expect(definition?.description).toContain("when work moves to another step");
    expect(definition?.description).toContain("when the scope or approach changes");
    expect(definition?.description).toContain("Before your final response");
    expect(definition?.description).toContain("call update_plan if it is stale");
    expect(definition?.description).toContain("Keep still-relevant unfinished work visible");
    expect(definition?.description).toContain("Never mark unfinished steps completed merely because the Run is ending");
    expect(definition?.description).toContain("Do not create a Plan solely to close the Run or repeat an unchanged update");
  });
});
