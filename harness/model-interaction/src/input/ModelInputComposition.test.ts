import { describe, expect, it } from "vitest";
import {
  allocateModelInputContext,
  composeModelInput,
  ModelInputCompositionError,
} from "./ModelInputComposition.js";
import { createUtf8ModelInputAccounting } from "./Utf8ModelInputAccounting.js";

describe("complete Model Input Composition", () => {
  it("reserves output and framing before granting the remaining Context amount", () => {
    const accounting = testAccounting(100);
    const allocation = allocateModelInputContext({
      accounting,
      outputFormat: { kind: "text" },
      outputReserve: { unit: "bytes", amount: 10 },
      baseSections: [section("system", "system", "12345")],
      maximumContextAmount: 80,
    });

    expect(allocation).toMatchObject({
      unit: "bytes",
      amount: 78,
      remainingAmount: 78,
      framing: { amount: 7 },
    });
  });

  it("composes all ordered sections and verifies the same Provider accounting", () => {
    const accounting = testAccounting(100);
    const composition = composeModelInput({
      id: "composition-1",
      providerId: "provider-1",
      model: "model-1",
      accounting,
      outputFormat: { kind: "text" },
      outputReserve: { unit: "bytes", amount: 10 },
      contextBudget: { unit: "bytes", amount: 40 },
      contextProjectedAmount: 12,
      sections: [
        section("system", "system", "rules"),
        section("user", "user", "task and context"),
      ],
      lineage: lineage(),
      composedAt: "2026-08-16T00:00:00.000Z",
    });

    expect(composition.accounting).toEqual({
      unit: "bytes",
      sectionAmount: 21,
      framingAmount: 7,
      inputAmount: 28,
      outputReserveAmount: 10,
      remainingAmount: 62,
    });
    expect(() => accounting.verify({
      providerId: "provider-1",
      model: "model-1",
      messages: composition.sections.map((section) => ({
        role: section.role,
        content: section.content.kind === "text"
          ? section.content.text
          : JSON.stringify(section.content.value),
      })),
      outputFormat: composition.outputFormat,
      composition,
    })).not.toThrow();
  });

  it("fails before transport for unsupported accounting and mandatory overflow", () => {
    expect(() => allocateModelInputContext({
      accounting: {
        capability: { supported: false },
        estimateSection() { throw new Error("not called"); },
        estimateFraming() { throw new Error("not called"); },
        verify() { throw new Error("not called"); },
      },
      outputFormat: { kind: "text" },
      outputReserve: { unit: "bytes", amount: 1 },
      baseSections: [section("system", "system", "rules")],
      maximumContextAmount: 1,
    })).toThrow(ModelInputCompositionError);

    expect(() => composeModelInput({
      id: "composition-overflow",
      providerId: "provider-1",
      model: "model-1",
      accounting: testAccounting(20),
      outputFormat: { kind: "text" },
      outputReserve: { unit: "bytes", amount: 10 },
      contextBudget: { unit: "bytes", amount: 0 },
      contextProjectedAmount: 0,
      sections: [section("system", "system", "this is too large")],
      lineage: lineage(),
      composedAt: "2026-08-16T00:00:00.000Z",
    })).toThrow("exceeds the effective input limit");
  });

  it("rejects Provider messages that diverge from the accepted composition", () => {
    const accounting = testAccounting(100);
    const composition = composeModelInput({
      id: "composition-verify",
      providerId: "provider-1",
      model: "model-1",
      accounting,
      outputFormat: { kind: "text" },
      outputReserve: { unit: "bytes", amount: 10 },
      contextBudget: { unit: "bytes", amount: 0 },
      contextProjectedAmount: 0,
      sections: [section("system", "system", "rules")],
      lineage: lineage(),
      composedAt: "2026-08-16T00:00:00.000Z",
    });

    expect(() => accounting.verify({
      providerId: "provider-1",
      model: "model-1",
      messages: [{ role: "system", content: "changed" }],
      outputFormat: composition.outputFormat,
      composition,
    })).toThrow("diverge");
  });

  it("accounts and verifies the exact Provider-native output format", () => {
    const accounting = createUtf8ModelInputAccounting({
      providerId: "provider-1",
      model: "model-1",
      maximumInputBytes: 1_024,
      limitSource: "host_configured",
      estimator: { id: "test-utf8", revision: "1" },
      framing: { id: "format-aware-framing", revision: "1" },
      renderFraming: (_sections, outputFormat) => JSON.stringify(outputFormat),
    });
    const outputFormat = {
      kind: "json_schema" as const,
      name: "test_decision",
      schemaId: "test.decision",
      schemaRevision: "1",
      schema: { type: "object", required: ["kind"] },
    };
    const composition = composeModelInput({
      id: "composition-format",
      providerId: "provider-1",
      model: "model-1",
      accounting,
      outputFormat,
      outputReserve: { unit: "bytes", amount: 10 },
      contextBudget: { unit: "bytes", amount: 0 },
      contextProjectedAmount: 0,
      sections: [section("system", "system", "rules")],
      lineage: lineage(),
      composedAt: "2026-08-16T00:00:00.000Z",
    });

    expect(composition.outputFormat).toEqual(outputFormat);
    expect(composition.framing.amount).toBeGreaterThan(0);
    expect(() => accounting.verify({
      providerId: "provider-1",
      model: "model-1",
      messages: [{ role: "system", content: "rules" }],
      outputFormat: { kind: "text" },
      composition,
    })).toThrow("does not match");
  });
});

function testAccounting(maximumInputBytes: number) {
  return createUtf8ModelInputAccounting({
    providerId: "provider-1",
    model: "model-1",
    maximumInputBytes,
    limitSource: "host_configured",
    estimator: { id: "test-utf8", revision: "1" },
    framing: { id: "test-framing", revision: "1" },
    renderFraming: () => "1234567",
  });
}

function section(id: string, role: "system" | "user", text: string) {
  return {
    id,
    source: { owner: "test", kind: "section", id, revision: "1" },
    kind: id === "system" ? "agent_instruction" : id,
    role,
    necessity: "mandatory" as const,
    content: { kind: "text" as const, text },
  };
}

function lineage() {
  return {
    instructionBinding: { owner: "agent-runtime", kind: "agent_instruction_binding", id: "binding", revision: "1" },
    agent: { owner: "agent-core", kind: "agent_revision", id: "agent", revision: "1" },
    instructions: { owner: "agent-core", kind: "agent_instructions", id: "instructions", revision: "1" },
    instructionRelease: { owner: "test", kind: "agent_instruction_release", id: "release", revision: "1" },
    instructionResolver: { owner: "test", kind: "agent_instruction_resolver", id: "resolver", revision: "1" },
    instructionContent: { owner: "agent-core", kind: "agent_instruction_content_digest", id: "instructions", revision: "1" },
    instructionModel: { providerId: "provider-1", model: "model-1" },
    instructionBlocks: [{ owner: "test", kind: "section", id: "system", revision: "1" }],
    activeContext: null,
    contextProjection: null,
    projectionManifest: null,
    toolSelection: null,
    toolExposureContent: null,
    toolExposureBasis: null,
    toolExposureProof: null,
    protocol: { owner: "test", kind: "protocol", id: "protocol", revision: "1" },
    policy: { owner: "test", kind: "policy", id: "policy", revision: "1" },
  };
}
