import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { HelarcInstructionSettings } from "../shared/HelarcInstructionSettings.js";
import { InstructionSettingsEditor, instructionPreview } from "./InstructionSettingsPanel.js";

function createDefaultHelarcInstructionSettings(): HelarcInstructionSettings {
  return {
    agent: [{ id: "identity_and_role", enabled: true, content: "Root role." }],
    delegated: [{ id: "delegated_work", enabled: true, content: "You are a delegated Helarc worker." }],
    protocol: [{ id: "native_tool_protocol", enabled: true, content: "Use native calls." }],
    stop: [{ id: "stop_instructions", enabled: true, content: "Check the proposed completion." }],
  };
}

describe("Instruction settings editor", () => {
  it("renders content controls and both Root and Child previews without a target selector", () => {
    const defaults = createDefaultHelarcInstructionSettings();
    const html = renderToStaticMarkup(<InstructionSettingsEditor snapshot={{ settings: defaults, defaults }}
      onSave={async (settings) => ({ settings, defaults })} />);
    expect(html).toContain("Agent Instructions");
    expect(html).toContain("Protocol Instructions");
    expect(html).toContain("Child Instructions");
    expect(html).toContain("Stop Instructions");
    expect(html).toContain("Enable Stop Instructions");
    expect(html).toContain("Restore Stop Instructions default text");
    expect(html).not.toContain("Hook");
    expect(html).toContain('role="switch"');
    expect(html).toContain("Enable Role Instructions");
    expect(html).toContain("Restore Native tool protocol default text");
    expect(html).toContain("Model Request Preview (System Prompt)");
    expect(html).not.toContain('aria-label="Preview target"');
    expect(html).not.toContain("<details");
    expect(html).toMatch(/<textarea[^>]*aria-label="Root system prompt preview text"[^>]*>Root role\.\n\nUse native calls\.<\/textarea>/);
    expect(html).toMatch(/<textarea[^>]*aria-label="Child system prompt preview text"[^>]*>Root role\.\n\nYou are a delegated Helarc worker\.\n\nUse native calls\.<\/textarea>/);
    expect(instructionPreview(defaults, "root")).not.toContain("delegated Helarc worker");
    expect(instructionPreview(defaults, "child")).toContain("delegated Helarc worker");
    expect(instructionPreview(defaults, "stop")).toBe("Check the proposed completion.");
    expect(instructionPreview(defaults, "child")).not.toContain("Check the proposed completion.");
    expect(html).toMatch(/<textarea[^>]*aria-label="Stop system prompt preview text"[^>]*>Check the proposed completion\.<\/textarea>/);
  });

  it("keeps disabled instruction text visible and editable, separate from the request previews", () => {
    const defaults = createDefaultHelarcInstructionSettings();
    const settings = { ...defaults, agent: [{ ...defaults.agent[0]!, enabled: false, content: "My saved role." }] };
    const html = renderToStaticMarkup(<InstructionSettingsEditor snapshot={{ settings, defaults }}
      onSave={async (value) => ({ settings: value, defaults })} />);

    expect(html).toContain("Disabled");
    expect(html).toContain('class="instruction-section"');
    expect(html).toMatch(/<textarea[^>]*aria-label="Role Instructions text"[^>]*>My saved role\.<\/textarea>/);
    const editor = html.match(/<textarea[^>]*aria-label="Role Instructions text"[^>]*>/)?.[0];
    expect(editor).not.toMatch(/disabled|readonly/);
    expect(instructionPreview(settings, "root")).not.toContain("My saved role.");
  });

  it("previews only selected exact text, including a genuinely empty prompt", () => {
    const defaults = createDefaultHelarcInstructionSettings();
    const settings = {
      agent: defaults.agent.map((entry) => ({ ...entry, enabled: false })),
      delegated: defaults.delegated.map((entry) => ({ ...entry, enabled: false })),
      protocol: defaults.protocol.map((entry) => ({ ...entry, enabled: false })),
      stop: defaults.stop.map((entry) => ({ ...entry, enabled: false })),
    };
    expect(instructionPreview(settings, "root")).toBe("");
    expect(instructionPreview(settings, "child")).toBe("");
    expect(instructionPreview(settings, "stop")).toBe("");
    settings.agent[0] = { ...settings.agent[0]!, enabled: true, content: "My role." };
    settings.protocol[0] = { ...settings.protocol[0]!, enabled: true, content: "My protocol." };
    expect(instructionPreview(settings, "root")).toBe("My role.\n\nMy protocol.");
  });

  it("keeps disabled Stop text editable and saved while its separate preview is empty", () => {
    const defaults = createDefaultHelarcInstructionSettings();
    const settings = { ...defaults, stop: [{ ...defaults.stop[0]!, enabled: false, content: "My Stop instructions." }] };
    const html = renderToStaticMarkup(<InstructionSettingsEditor snapshot={{ settings, defaults }}
      onSave={async (value) => ({ settings: value, defaults })} />);
    expect(html).toMatch(/<textarea[^>]*aria-label="Stop Instructions text"[^>]*>My Stop instructions\.<\/textarea>/);
    expect(html.match(/<textarea[^>]*aria-label="Stop Instructions text"[^>]*>/)?.[0]).not.toMatch(/disabled|readonly/);
    expect(instructionPreview(settings, "stop")).toBe("");
    expect(instructionPreview(settings, "root")).toBe(instructionPreview(defaults, "root"));
  });
});
