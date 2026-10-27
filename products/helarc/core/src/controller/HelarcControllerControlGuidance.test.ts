import { describe, expect, it } from "vitest";
import {
  createHelarcControllerControlDefinitions,
  HELARC_CONTROLLER_CONTROL_GUIDANCE,
} from "./HelarcControllerControlGuidance.js";
import {
  createHelarcEndingSignalFeedback,
  HELARC_FINAL_REPLY_CONTENT_GUIDANCE,
  HELARC_FINAL_REPLY_RECIPIENT_GUIDANCE,
} from "./HelarcFinalReply.js";

describe("Helarc Controller Control Guidance", () => {
  it("defines the complete non-Tool controls", () => {
    const definitions = createHelarcControllerControlDefinitions(
      HELARC_CONTROLLER_CONTROL_GUIDANCE,
      { maxSteps: 24, maxStepLength: 500, maxExplanationLength: 2_000 },
      false,
    );

    expect(definitions.map(({ name }) => name)).toEqual(["final_result", "update_plan"]);
    expect(definitions.find(({name}) => name === "final_result")?.inputSchema).toMatchObject({
      properties: {response: {type: "string"}}, required: [], additionalProperties: false,
    });
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
      false,
    );
    const second = createHelarcControllerControlDefinitions(
      HELARC_CONTROLLER_CONTROL_GUIDANCE,
      { maxSteps: 16, maxStepLength: 500, maxExplanationLength: 2_000 },
      false,
    );

    expect(first).not.toEqual(second);
    expect(HELARC_CONTROLLER_CONTROL_GUIDANCE.revision)
      .toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(Object.isFrozen(HELARC_CONTROLLER_CONTROL_GUIDANCE.entries)).toBe(true);
  });

  it("explains reply replacement and caller visibility consistently in the callable and feedback", () => {
    const [definition] = createHelarcControllerControlDefinitions(
      HELARC_CONTROLLER_CONTROL_GUIDANCE,
      { maxSteps: 24, maxStepLength: 500, maxExplanationLength: 2_000 },
      false,
    );
    expect(HELARC_FINAL_REPLY_CONTENT_GUIDANCE).toContain("replaces, not appends to, earlier assistant text");
    expect(HELARC_FINAL_REPLY_CONTENT_GUIDANCE).toContain("To return an already-written report, omit response");
    expect(HELARC_FINAL_REPLY_RECIPIENT_GUIDANCE).toContain("not the Child's conversation history");
    expect(HELARC_FINAL_REPLY_RECIPIENT_GUIDANCE).toContain("Do not assume the Parent has read earlier Child messages");
    expect(HELARC_FINAL_REPLY_RECIPIENT_GUIDANCE).not.toContain("self-contained");
    expect(definition!.description).toContain(HELARC_FINAL_REPLY_CONTENT_GUIDANCE);
    expect(definition!.description).toContain(HELARC_FINAL_REPLY_RECIPIENT_GUIDANCE);
    expect(definition!.inputSchema.properties?.response?.description).toBe(HELARC_FINAL_REPLY_CONTENT_GUIDANCE);
    expect(definition!.inputSchema.required).toEqual([]);
  });

  it.each([false, true].flatMap(hasText => [false, true].map(hasPlan => ({hasText, hasPlan}))))(
    "gives protocol-state-specific feedback without classifying text: %j", input => {
      const feedback = createHelarcEndingSignalFeedback(input);
      expect(feedback).toContain("native final_result call");
      expect(feedback).toContain("not your private conversation history");
      expect(feedback).toContain("If further work is needed");
      expect(feedback.includes("text from this turn is retained")).toBe(input.hasText);
      expect(feedback.includes("arguments {}")).toBe(!input.hasPlan);
      expect(feedback.includes("complete final snapshot")).toBe(input.hasPlan);
      expect(feedback).not.toContain("task is complete");
    });

  it("requires a final snapshot only when a Plan exists", () => {
    const limits = { maxSteps: 24, maxStepLength: 500, maxExplanationLength: 2_000 };
    const absent = createHelarcControllerControlDefinitions(HELARC_CONTROLLER_CONTROL_GUIDANCE, limits, false);
    const present = createHelarcControllerControlDefinitions(HELARC_CONTROLLER_CONTROL_GUIDANCE, limits, true);
    expect(absent[0]?.inputSchema.required).toEqual([]);
    expect(present[0]?.inputSchema.required).toEqual(["plan"]);
    expect(present[0]?.inputSchema.properties?.plan).toEqual(present[1]?.inputSchema.properties?.plan);
    expect(absent[1]).toEqual(present[1]);
  });

  it("guides timely updates and an explicit final snapshot without requiring successful steps", () => {
    const definitions = createHelarcControllerControlDefinitions(
      HELARC_CONTROLLER_CONTROL_GUIDANCE,
      { maxSteps: 24, maxStepLength: 500, maxExplanationLength: 2_000 },
      true,
    );

    const definition = definitions.find(item => item.name === "update_plan");
    expect(definition?.description).toContain("after a step's outcome is established");
    expect(definition?.description).toContain("when work moves to another step");
    expect(definition?.description).toContain("when the scope or approach changes");
    expect(definition?.description).toContain("complete final Plan snapshot inside final_result");
    expect(definition?.description).toContain("Keep still-relevant unfinished work visible");
    expect(definition?.description).toContain("Never mark unfinished steps completed merely because the Run is ending");
    expect(definition?.description).toContain("Do not create a Plan solely to close the Run or repeat an unchanged update");
  });
});
