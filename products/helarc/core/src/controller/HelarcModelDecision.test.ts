import { describe, expect, it } from "vitest";

import {
  HelarcModelDecisionError,
  parseHelarcModelDecision,
} from "./HelarcModelDecision.js";

describe("HelarcModelDecision", () => {
  it("accepts and freezes the four exact model decision variants", () => {
    const decisions = [
      parseHelarcModelDecision({
        kind: "tool_call",
        toolName: "Read",
        input: { file_path: "src/index.ts", offset: 1 },
        reason: "Inspect the entry point.",
      }),
      parseHelarcModelDecision({
        kind: "plan_update",
        plan: [
          { step: "Inspect the code", status: "in_progress" },
          { step: "Apply the change", status: "pending" },
        ],
      }),
      parseHelarcModelDecision({ kind: "completion", summary: "Done." }),
      parseHelarcModelDecision({ kind: "stop", reason: "No safe continuation." }),
    ];

    expect(decisions.map((decision) => decision.kind)).toEqual([
      "tool_call",
      "plan_update",
      "completion",
      "stop",
    ]);
    expect(decisions.every(Object.isFrozen)).toBe(true);
    expect(Object.isFrozen(decisions[0]!.kind === "tool_call" && decisions[0].input)).toBe(true);
  });

  it("rejects removed model decisions and unsupported fields", () => {
    for (const input of [
      { kind: "propose", summary: "Change it." },
      { kind: "request_permissions", reason: "Need more access." },
      { kind: "completion", summary: "Done.", change: {} },
    ]) {
      expect(() => parseHelarcModelDecision(input)).toThrow(HelarcModelDecisionError);
    }
  });

  it("rejects invalid Plan and non-JSON Tool input", () => {
    expect(() => parseHelarcModelDecision({
      kind: "plan_update",
      plan: [
        { step: "One", status: "in_progress" },
        { step: "Two", status: "in_progress" },
      ],
    })).toThrowError(expect.objectContaining({ code: "model_decision_plan_invalid" }));

    expect(() => parseHelarcModelDecision({
      kind: "tool_call",
      toolName: "Read",
      input: { value: undefined },
    })).toThrowError(expect.objectContaining({
      code: "model_decision_tool_input_invalid",
    }));
  });
});
