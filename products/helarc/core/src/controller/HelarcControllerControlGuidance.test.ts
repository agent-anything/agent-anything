import { describe, expect, it } from "vitest";
import {
  createHelarcControllerControlDefinitions,
  HELARC_CONTROLLER_CONTROL_GUIDANCE,
  HELARC_STOP_REASON_MAX_LENGTH,
} from "./HelarcControllerControlGuidance.js";

describe("Helarc Controller Control Guidance", () => {
  it("defines complete non-Tool update_plan and stop callables", () => {
    const definitions = createHelarcControllerControlDefinitions(
      HELARC_CONTROLLER_CONTROL_GUIDANCE,
      { maxSteps: 24, maxStepLength: 500, maxExplanationLength: 2_000 },
    );

    expect(definitions.map(({ name }) => name)).toEqual(["stop", "update_plan"]);
    expect(definitions.every(({ description }) => description.length > 300)).toBe(true);
    expect(definitions.find(({ name }) => name === "stop")?.inputSchema)
      .toMatchObject({
        properties: {
          reason: {
            maxLength: HELARC_STOP_REASON_MAX_LENGTH,
            description: expect.stringContaining("stop basis"),
          },
        },
      });
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
});
