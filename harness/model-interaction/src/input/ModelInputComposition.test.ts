import { describe, expect, it } from "vitest";
import {
  composeModelInput,
  ModelInputCompositionError,
} from "./ModelInputComposition.js";
import { snapshotModelInputComposition } from "./ModelInput.js";

describe("semantic Model Input Composition", () => {
  it("composes ordered semantic sections without transport accounting", () => {
    const composition = composeModelInput({
      id: "composition-1",
      providerId: "provider-1",
      model: "model-1",
      interaction: { kind: "text_generation" },
      sections: [
        section("instructions", "instruction", "agent_instruction", "Follow the protocol."),
        section("task", "user", "task", "Inspect package.json."),
      ],
      lineage: lineage(),
      composedAt: "2026-08-16T00:00:00.000Z",
    });

    expect(composition.instructions.content).toEqual([
      { kind: "text", text: "Follow the protocol." },
    ]);
    expect(composition.messages).toEqual([{
      role: "user",
      content: [{ kind: "text", text: "Inspect package.json." }],
    }]);
    expect(composition).not.toHaveProperty("accounting");
    expect(composition).not.toHaveProperty("contextBudget");
  });

  it("rejects empty input and duplicate semantic section identities", () => {
    expect(() => composeModelInput({
      id: "empty",
      providerId: "provider-1",
      model: "model-1",
      interaction: { kind: "text_generation" },
      sections: [],
      lineage: lineage(),
      composedAt: "2026-08-16T00:00:00.000Z",
    })).toThrow(ModelInputCompositionError);

    expect(() => composeModelInput({
      id: "duplicate",
      providerId: "provider-1",
      model: "model-1",
      interaction: { kind: "text_generation" },
      sections: [
        section("instructions", "instruction", "agent_instruction", "Rules."),
        section("instructions", "user", "task", "Task."),
      ],
      lineage: lineage(),
      composedAt: "2026-08-16T00:00:00.000Z",
    })).toThrow("section identities must be unique");
  });

  it("rejects Provider input that diverges from its semantic sections", () => {
    const composition = composeModelInput({
      id: "composition-2",
      providerId: "provider-1",
      model: "model-1",
      interaction: { kind: "text_generation" },
      sections: [
        section("instructions", "instruction", "agent_instruction", "Rules."),
        section("task", "user", "task", "Task."),
      ],
      lineage: lineage(),
      composedAt: "2026-08-16T00:00:00.000Z",
    });

    expect(() => snapshotModelInputComposition({
      ...composition,
      messages: [{ role: "user", content: [{ kind: "text", text: "Changed." }] }],
    })).toThrow("input diverges from its sections");
  });
});

function section(
  id: string,
  role: "instruction" | "user",
  kind: string,
  text: string,
) {
  return {
    id,
    source: source("test", kind, id),
    kind,
    role,
    necessity: "mandatory" as const,
    content: { kind: "text" as const, text },
  };
}

function lineage() {
  return {
    instructionBinding: source("agent-runtime", "instruction_binding", "binding"),
    agent: source("agent-core", "agent_revision", "agent"),
    instructions: source("agent-core", "agent_instructions", "instructions"),
    instructionRelease: source("test", "instruction_release", "release"),
    instructionResolver: source("test", "instruction_resolver", "resolver"),
    instructionContent: source("agent-core", "instruction_content", "instructions"),
    instructionModel: { providerId: "provider-1", model: "model-1" },
    instructionBlocks: [source("test", "agent_instruction", "instructions")],
    activeContext: null,
    contextProjection: null,
    projectionManifest: null,
    toolSelection: null,
    toolExposureContent: null,
    toolExposureBasis: null,
    toolExposureProof: null,
    toolGuidance: null,
    controllerControlGuidance: null,
    callableDefinitions: null,
    modelQualification: null,
    interactionHistory: null,
    protocol: source("test", "protocol", "protocol"),
    policy: source("test", "policy", "policy"),
  };
}

function source(owner: string, kind: string, id: string) {
  return { owner, kind, id, revision: "1" };
}
