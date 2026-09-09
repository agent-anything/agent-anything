import { describe, expect, it } from "vitest";
import { modelInputFromSections, modelInputSectionLocations } from "./ModelInput.js";

describe("Model Input semantic projection", () => {
  it("locates each contribution in the same semantic projection without rewriting input", () => {
    const sections = [section("s", "instruction", "Rules"), section("u1", "user", "Task"),
      section("u2", "user", "Context"), section("a", "assistant", "Reply"), section("u3", "user", "More")];
    const before = modelInputFromSections(sections);
    expect(modelInputSectionLocations(sections)).toEqual([
      { sectionId: "s", jsonPointers: ["/instructions/content/0"] },
      { sectionId: "u1", jsonPointers: ["/messages/0/content/0"] },
      { sectionId: "u2", jsonPointers: ["/messages/0/content/1"] },
      { sectionId: "a", jsonPointers: ["/messages/1"] },
      { sectionId: "u3", jsonPointers: ["/messages/2/content/0"] },
    ]);
    expect(modelInputFromSections(sections)).toEqual(before);
  });
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
