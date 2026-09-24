import {
  createModelCallRef,
  snapshotModelCallableDefinitions,
  type ModelToolCall,
} from "@agent-anything/model-interaction";
import { describe, expect, it } from "vitest";
import { createHelarcUnknownCallableRejection } from "./HelarcModelCallFeedback.js";

function call(name: string): ModelToolCall {
  return {
    name,
    modelCallRef: createModelCallRef({
      providerRequestId: "request-1",
      controllerRequestId: "controller-1",
      turnId: "turn-1",
      contentBlockOrdinal: 0,
      branchId: "run-1:main",
    }),
    providerCallRef: { providerId: "test", id: "call-1" },
    input: { prompt: "private task content must not be repeated in feedback" },
    ordinal: 0,
  };
}

function catalog(names: readonly string[]) {
  return {
    definitions: snapshotModelCallableDefinitions(names.map((name) => ({
      name,
      description: "Test function.",
      inputSchema: { type: "object", properties: {} },
    }))),
  };
}

describe("Helarc model-call feedback", () => {
  it("uses request-time function names and preserves rejection identity without guessing an alias", () => {
    const rejectedCall = call("Agent");
    const current = catalog(["Agent_6e06f4afa928", "Read_123456abcdef", "update_plan"]);
    const feedback = createHelarcUnknownCallableRejection(rejectedCall, current);

    expect(feedback).toMatchObject({
      kind: "model_call_rejection",
      name: "Agent",
      code: "model_callable_unknown",
      modelCallRef: rejectedCall.modelCallRef,
    });
    expect(feedback.message).toContain('Unknown function name "Agent"');
    expect(feedback.message).toContain("This call was not executed.");
    expect(feedback.message).toContain(JSON.stringify(current.definitions.map(({ name }) => name)));
    expect(feedback.message).toContain("function definitions supplied with your current request");
    expect(feedback.message).toContain("including any suffix");
    expect(feedback.message).toContain("input schema");
    expect(feedback.message).toContain("this rejection does not require repeating them");
    expect(feedback.message).not.toContain("active catalog");
    expect(feedback.message).not.toContain(rejectedCall.input.prompt);
    expect(Object.isFrozen(feedback)).toBe(true);
  });

  it("quotes model-supplied names and bounds only their displayed text", () => {
    const unusual = call('unknown"\nfunction');
    expect(createHelarcUnknownCallableRejection(unusual, catalog(["update_plan"])).message)
      .toContain(JSON.stringify(unusual.name));
    const oversized = call("x".repeat(200_000));
    const feedback = createHelarcUnknownCallableRejection(oversized, catalog(["update_plan"]));
    expect(feedback.name).toBe(oversized.name);
    expect(feedback.modelCallRef).toBe(oversized.modelCallRef);
    expect(feedback.message).toContain("name truncated for display");
    expect(feedback.message.length).toBeLessThan(1_024);
  });

  it("retains every admitted function name within the Tool Result content bound", () => {
    const names = Array.from({ length: 128 }, (_, index) => `tool_${index}_`.padEnd(64, "x"));
    const feedback = createHelarcUnknownCallableRejection(call("unknown"), catalog(names));
    for (const name of names) expect(feedback.message).toContain(JSON.stringify(name));
    expect(new TextEncoder().encode(JSON.stringify(feedback.message)).byteLength).toBeLessThan(16_384);
  });

  it("does not invent a recovery function when none is available", () => {
    const feedback = createHelarcUnknownCallableRejection(call("Agent"), { definitions: [] });
    expect(feedback.message).toContain("Available function names for this request: [].");
    expect(feedback.message).toContain("No functions were available");
  });
});
