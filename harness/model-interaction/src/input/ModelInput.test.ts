import { describe, expect, it } from "vitest";
import { modelInputFromSections } from "./ModelInput.js";

describe("Model Input semantic projection", () => {
  it("keeps instructions separate and merges adjacent user sections", () => {
    const projected = modelInputFromSections([
      section("instruction-1", "instruction", "System A"),
      section("instruction-2", "instruction", "System B"),
      section("task", "user", "Task"),
      section("context", "user", "Context"),
    ]);

    expect(projected.instructions.content).toEqual([
      { kind: "text", text: "System A" },
      { kind: "text", text: "System B" },
    ]);
    expect(projected.messages).toEqual([{
      role: "user",
      content: [
        { kind: "text", text: "Task" },
        { kind: "text", text: "Context" },
      ],
    }]);
  });

  it("preserves assistant boundaries between user contributions", () => {
    const projected = modelInputFromSections([
      section("instruction", "instruction", "Rules"),
      section("user-1", "user", "Question"),
      section("assistant", "assistant", "Working"),
      section("user-2", "user", "Observation"),
    ]);

    expect(projected.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "user",
    ]);
  });

  it("rejects instructions after conversation input", () => {
    expect(() => modelInputFromSections([
      section("task", "user", "Task"),
      section("instruction", "instruction", "Late instruction"),
    ])).toThrow("must precede conversation sections");
  });
});

function section(
  id: string,
  role: "instruction" | "user" | "assistant",
  text: string,
) {
  return {
    id,
    source: { owner: "test", kind: "section", id, revision: "1" },
    kind: role === "instruction" ? "agent_instruction" : "conversation",
    role,
    necessity: "mandatory" as const,
    content: { kind: "text" as const, text },
  };
}
