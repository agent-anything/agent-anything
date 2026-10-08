import { describe, expect, it } from "vitest";
import { resolveModelThinkingSelection, snapshotModelThinkingCapability, snapshotModelThinkingSelection } from "./ModelThinking.js";
import { snapshotModelMessage, modelMessagesEqual } from "./ModelMessage.js";
import { snapshotModelReasoning } from "./ModelReasoning.js";

describe("thinking contracts", () => {
  const known = { status: "known" as const, source: "endpoint" as const, values: [false, true, "high", "max"], defaultValue: "high" };
  it("freezes known defaults without inventing effort levels", () => {
    expect(resolveModelThinkingSelection({ mode: "default" }, known)).toEqual({ mode: "enabled", effort: "high" });
    expect(resolveModelThinkingSelection({ mode: "enabled" }, known)).toEqual({ mode: "enabled", effort: "high" });
    expect(resolveModelThinkingSelection({ mode: "disabled" }, known)).toEqual({ mode: "disabled" });
    expect(() => resolveModelThinkingSelection({ mode: "enabled", effort: "medium" }, known)).toThrow();
    expect(() => snapshotModelThinkingSelection({ mode: "disabled", effort: "high" } as never)).toThrow();
  });
  it("distinguishes unknown from disabled-only and rejects contradictory facts", () => {
    const unknown = { status: "unknown" as const, source: "unknown" as const, values: [], defaultValue: null };
    expect(resolveModelThinkingSelection({ mode: "default" }, unknown)).toEqual({ mode: "default" });
    expect(() => resolveModelThinkingSelection({ mode: "disabled" }, unknown)).toThrow();
    expect(resolveModelThinkingSelection({ mode: "default" }, { ...known, values: [false], defaultValue: false })).toEqual({ mode: "disabled" });
    expect(() => snapshotModelThinkingCapability({ ...known, defaultValue: "unknown" })).toThrow();
  });
  it("preserves assistant reasoning separately from executable content", () => {
    const reasoning = { text: "consider the evidence", replay: { format: "format.v1", binding: "binding" } };
    const message = snapshotModelMessage({ role: "assistant", content: [{ kind: "text", text: "Answer" }], reasoning });
    expect(message).toMatchObject({ reasoning, content: [{ kind: "text", text: "Answer" }] });
    expect(modelMessagesEqual([message], [{ role: "assistant", content: [{ kind: "text", text: "Answer" }] }])).toBe(false);
    expect(Object.isFrozen(message)).toBe(true);
    expect(() => snapshotModelMessage({ role: "user", content: [], reasoning } as never)).toThrow();
    expect(() => snapshotModelReasoning({ ...reasoning, text: "x".repeat(131073) })).toThrow();
  });
});
