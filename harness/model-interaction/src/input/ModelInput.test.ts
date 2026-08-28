import { describe, expect, it } from "vitest";
import type { ModelInputComposition, ModelInputSection } from "./ModelInput.js";
import {
  modelInputFromSections,
  snapshotModelInputCapability,
  snapshotModelInputComposition,
} from "./ModelInput.js";

describe("ModelInputComposition contract", () => {
  it("reports unsupported exact accounting without fabricated estimates", () => {
    expect(snapshotModelInputCapability({ supported: false })).toEqual({
      supported: false,
    });
  });

  it("accounts the complete input and output reserve under one estimator", () => {
    const composition = snapshotModelInputComposition(validComposition());

    expect(composition.accounting).toEqual({
      unit: "tokens",
      sectionAmount: 70,
      framingAmount: 10,
      inputAmount: 80,
      outputReserveAmount: 100,
      remainingAmount: 820,
    });
    expect(composition.contextBudget.amount).toBe(300);
    expect(Object.isFrozen(composition.sections)).toBe(true);
    expect(Object.isFrozen(composition.sections[0]?.source)).toBe(true);
  });

  it("rejects mismatched units, false accounting, and unknown fields", () => {
    expect(() => snapshotModelInputComposition({
      ...validComposition(),
      contextBudget: { unit: "bytes", amount: 300 },
    })).toThrow(TypeError);

    expect(() => snapshotModelInputComposition({
      ...validComposition(),
      accounting: {
        ...validComposition().accounting,
        inputAmount: 79,
      },
    })).toThrow(TypeError);

    expect(() => snapshotModelInputComposition({
      ...validComposition(),
      metadata: { guessed: true },
    } as ModelInputComposition)).toThrow(TypeError);
  });

  it("fails before transport when mandatory input and reserve exceed the limit", () => {
    expect(() => snapshotModelInputComposition({
      ...validComposition(),
      limit: { unit: "tokens", maximum: 150, source: "provider_reported" },
      accounting: {
        unit: "tokens",
        sectionAmount: 70,
        framingAmount: 10,
        inputAmount: 80,
        outputReserveAmount: 100,
        remainingAmount: 0,
      },
    })).toThrow("exceeds the model input limit");
  });

  it("separates instructions and normalizes adjacent user material", () => {
    const input = modelInputFromSections([
      section("instruction", "instruction", "Instruction"),
      section("protocol", "instruction", "Protocol"),
      section("task", "user", "Task"),
      section("initial-state", "user", "Initial state"),
      section("history-user", "user", {
        kind: "model_message",
        message: { role: "user", content: [{ kind: "text", text: "Additional request" }] },
      }),
      section("history", "assistant", {
        kind: "model_message",
        message: { role: "assistant", content: [{ kind: "text", text: "Earlier turn" }] },
      }),
      section("history-continued", "assistant", {
        kind: "model_message",
        message: { role: "assistant", content: [{ kind: "text", text: "Separate turn" }] },
      }),
      section("current-state", "user", "Current state"),
      section("pending", "user", "Pending interactions: []"),
    ]);

    expect(input.instructions).toEqual({
      content: [
        { kind: "text", text: "Instruction" },
        { kind: "text", text: "Protocol" },
      ],
    });
    expect(input.messages).toEqual([{
      role: "user",
      content: [
        { kind: "text", text: "Task" },
        { kind: "text", text: "Initial state" },
        { kind: "text", text: "Additional request" },
      ],
    }, {
      role: "assistant",
      content: [{ kind: "text", text: "Earlier turn" }],
    }, {
      role: "assistant",
      content: [{ kind: "text", text: "Separate turn" }],
    }, {
      role: "user",
      content: [
        { kind: "text", text: "Current state" },
        { kind: "text", text: "Pending interactions: []" },
      ],
    }]);
  });

  it("rejects instruction material after conversation input has started", () => {
    expect(() => modelInputFromSections([
      section("task", "user", "Task"),
      section("late-instruction", "instruction", "Too late"),
    ])).toThrow("must precede conversation sections");
  });
});

function section(
  id: string,
  role: ModelInputSection["role"],
  content: string | ModelInputSection["content"],
): ModelInputSection {
  return {
    id,
    source: { owner: "test", kind: "fixture", id, revision: "1" },
    kind: "fixture",
    role,
    necessity: "mandatory",
    content: typeof content === "string" ? { kind: "text", text: content } : content,
    accounting: { unit: "tokens", amount: 1 },
  };
}

function validComposition(): ModelInputComposition {
  return {
    id: "composition-1",
    providerId: "provider-1",
    model: "model-1",
    estimator: {
      id: "provider-tokenizer",
      revision: "2026-08-14",
      unit: "tokens",
      accuracy: "exact",
    },
    limit: { unit: "tokens", maximum: 1000, source: "provider_reported" },
    outputReserve: { unit: "tokens", amount: 100 },
    interaction: { kind: "text_generation" },
    framing: {
      ref: { id: "chat-framing", revision: "1" },
      unit: "tokens",
      amount: 10,
    },
    contextBudget: { unit: "tokens", amount: 300 },
    sections: [{
      id: "product-instructions",
      source: {
        owner: "helarc",
        kind: "prompt_section",
        id: "instructions",
        revision: "3",
      },
      kind: "agent_instruction",
      role: "instruction",
      necessity: "mandatory",
      content: { kind: "text", text: "Follow the product protocol." },
      accounting: { unit: "tokens", amount: 40 },
    }, {
      id: "context-projection",
      source: {
        owner: "context",
        kind: "projection",
        id: "projection-1",
        revision: "3",
      },
      kind: "context_projection",
      role: "user",
      necessity: "optional",
      content: { kind: "structured", value: { blocks: 2 } },
      accounting: { unit: "tokens", amount: 30 },
    }],
    instructions: {
      content: [{ kind: "text", text: "Follow the product protocol." }],
    },
    messages: [{
      role: "user",
      content: [{ kind: "text", text: JSON.stringify({ blocks: 2 }) }],
    }],
    lineage: {
      instructionBinding: { owner: "agent-runtime", kind: "agent_instruction_binding", id: "binding-1", revision: "1" },
      agent: { owner: "agent-core", kind: "agent_revision", id: "agent-1", revision: "1" },
      instructions: { owner: "agent-core", kind: "agent_instructions", id: "instructions-1", revision: "1" },
      instructionRelease: { owner: "helarc", kind: "agent_instruction_release", id: "release-1", revision: "1" },
      instructionResolver: { owner: "helarc", kind: "agent_instruction_resolver", id: "resolver-1", revision: "1" },
      instructionContent: { owner: "agent-core", kind: "agent_instruction_content_digest", id: "instructions-1", revision: "1" },
      instructionModel: { providerId: "provider-1", model: "model-1" },
      instructionBlocks: [{ owner: "helarc", kind: "prompt_section", id: "instructions", revision: "3" }],
      activeContext: {
        owner: "context",
        kind: "active_context",
        id: "context-1",
        revision: "3",
      },
      contextProjection: {
        owner: "context",
        kind: "projection",
        id: "projection-1",
        revision: "3",
      },
      projectionManifest: {
        owner: "context",
        kind: "projection_manifest",
        id: "manifest-1",
        revision: "1",
      },
      toolSelection: { owner: "tools", kind: "tool_selection", id: "selection-1", revision: "1" },
      toolExposureContent: { owner: "tools", kind: "tool_exposure_content", id: "content-1", revision: "1" },
      toolExposureBasis: { owner: "tools", kind: "tool_exposure_basis", id: "basis-1", revision: "1" },
      toolExposureProof: { owner: "tools", kind: "tool_exposure_proof", id: "proof-1", revision: "proof-1" },
      toolGuidance: null,
      controllerControlGuidance: null,
      callableDefinitions: null,
      modelQualification: null,
      interactionHistory: null,
      protocol: {
        owner: "helarc",
        kind: "protocol",
        id: "controller-protocol",
        revision: "5",
      },
      policy: {
        owner: "governance",
        kind: "model_input_policy",
        id: "policy-1",
        revision: "4",
      },
    },
    accounting: {
      unit: "tokens",
      sectionAmount: 70,
      framingAmount: 10,
      inputAmount: 80,
      outputReserveAmount: 100,
      remainingAmount: 820,
    },
    composedAt: "2026-08-14T00:00:00.000Z",
  };
}
