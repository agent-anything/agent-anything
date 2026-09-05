import { describe, expect, it } from "vitest";
import { createHelarcAgent, createHelarcDelegatedWorkerAgent } from "../agent/HelarcAgent.js";
import { createDefaultHelarcInstructionSettings, snapshotHelarcInstructionSettings } from "./HelarcInstructionSettings.js";

describe("Helarc Instruction settings", () => {
  it("keeps complete defaults and snapshots retained disabled text without mutation", () => {
    const draft = structuredClone(createDefaultHelarcInstructionSettings());
    expect(draft.agent).toHaveLength(9);
    expect(draft.protocol).toHaveLength(4);
    expect(draft.delegated).toHaveLength(1);
    expect(draft.stop).toHaveLength(1);
    const settings = snapshotHelarcInstructionSettings({ ...draft, agent: draft.agent.map((section) => ({ ...section, enabled: false })) });
    expect(settings.agent[0]?.content).toContain("You are Helarc");
    expect(Object.isFrozen(settings.agent[0])).toBe(true);
  });

  it("binds the exact selected text into root and descendant instruction identities", () => {
    const defaults = createDefaultHelarcInstructionSettings();
    const instructionSettings = {
      ...defaults,
      agent: defaults.agent.map((section, index) => ({ ...section, enabled: index === 0, content: "Custom role." })),
      delegated: defaults.delegated.map((section) => ({ ...section, content: "Custom delegation." })),
    };
    const input = { providerId: "test", modelId: "model", instructionSettings };
    const root = createHelarcAgent({ ...input, target: "production" });
    const child = createHelarcDelegatedWorkerAgent(input);
    expect(root.instructions.blocks.map(({ content }) => content)).toEqual(["Custom role."]);
    expect(child.instructions.blocks.map(({ content }) => content)).toEqual(["Custom role.", "Custom delegation."]);
    const changed = createHelarcAgent({ ...input, target: "production", instructionSettings: defaults });
    expect(root.revision).not.toBe(changed.revision);
    expect(root.instructions.release.revision).not.toBe(changed.instructions.release.revision);
  });

  it("allows all text to be disabled or empty without a fallback for either Agent", () => {
    const defaults = createDefaultHelarcInstructionSettings();
    const instructionSettings = {
      ...defaults,
      agent: defaults.agent.map((section) => ({ ...section, enabled: false })),
      delegated: defaults.delegated.map((section) => ({ ...section, content: "  " })),
      protocol: defaults.protocol.map((section) => ({ ...section, enabled: false })),
    };
    const input = { providerId: "test", modelId: "model", instructionSettings };
    expect(createHelarcAgent({ ...input, target: "production" }).instructions.blocks).toEqual([]);
    expect(createHelarcDelegatedWorkerAgent(input).instructions.blocks).toEqual([]);
  });

  it("rejects unknown, duplicate, missing, oversized, and malformed settings", () => {
    const defaults = createDefaultHelarcInstructionSettings();
    for (const invalid of [
      { ...defaults, extra: true },
      { agent: defaults.agent, delegated: defaults.delegated, protocol: defaults.protocol },
      { ...defaults, stop: [] },
      { ...defaults, stop: [{ ...defaults.stop[0], enabled: "false" }] },
      { ...defaults, agent: [] },
      { ...defaults, agent: defaults.agent.map(() => defaults.agent[0]) },
      { ...defaults, protocol: defaults.protocol.map((section) => ({ ...section, id: "unknown" })) },
      { ...defaults, protocol: defaults.protocol.map((section) => ({ ...section, enabled: "false" })) },
      { ...defaults, protocol: defaults.protocol.map((section) => ({ ...section, content: "x".repeat(32_769) })) },
      { ...defaults, protocol: defaults.protocol.map((section) => ({ ...section, content: "\0" })) },
    ]) expect(() => snapshotHelarcInstructionSettings(invalid)).toThrow();
  });

  it("preserves disabled Stop text independently from Agent and Protocol identities", () => {
    const defaults = createDefaultHelarcInstructionSettings();
    const draft = { ...defaults, stop: [{ ...defaults.stop[0]!, enabled: false, content: "My Stop text." }] };
    const snapshot = snapshotHelarcInstructionSettings(draft);
    draft.stop[0]!.content = "Edited later.";
    expect(snapshot.stop[0]).toEqual({ id: "stop_instructions", enabled: false, content: "My Stop text." });
    expect(Object.isFrozen(snapshot.stop[0])).toBe(true);
    const input = { target: "production" as const, providerId: "test", modelId: "model" };
    expect(createHelarcAgent({ ...input, instructionSettings: snapshot }).revision)
      .toBe(createHelarcAgent({ ...input, instructionSettings: defaults }).revision);
  });
});
