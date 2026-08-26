import { describe, expect, it } from "vitest";
import {
  HELARC_INSTRUCTION_CATALOG,
  HelarcInstructionResolutionError,
  createHelarcInstructionCatalog,
  createHelarcInstructionRelease,
  createHelarcInstructionSource,
  resolveHelarcAgentInstructions,
  type HelarcInstructionRelease,
  type HelarcInstructionCatalog,
} from "./index.js";

const MODEL = Object.freeze({ providerId: "test-provider", modelId: "test-model" });
const DATE = "2026-08-26T00:00:00.000Z";

describe("Helarc instruction releases", () => {
  it("resolves complete minimal, production, and flattened delegated-worker targets", () => {
    const minimal = resolveDefault("minimal", "helarc-code-agent");
    const production = resolveDefault("production", "helarc-code-agent");
    const delegated = resolveDefault("delegated-worker", "helarc-delegated-worker");

    expect(minimal.blocks.map(({ id }) => id)).toEqual(["minimal_behavior"]);
    expect(production.blocks.map(({ id }) => id)).toEqual([
      "identity_and_role",
      "operating_principles",
      "task_execution",
      "tool_use_guidance",
      "code_change_behavior",
      "planning_and_progress",
      "verification_and_completion",
      "communication",
      "safety_and_uncertainty",
    ]);
    expect(delegated.blocks.slice(0, production.blocks.length)).toEqual(production.blocks);
    expect(delegated.blocks.at(-1)?.id).toBe("delegated_work");
    expect(JSON.stringify(production)).not.toContain("treatment");
    expect(JSON.stringify(production)).not.toContain("provenance");
    expect(JSON.stringify(production)).not.toContain("license");
    expect(HELARC_INSTRUCTION_CATALOG.sources.every(({ treatment }) => treatment === "authored"))
      .toBe(true);
    expect(HELARC_INSTRUCTION_CATALOG.sources.every(({ provenance }) => provenance.license === "Apache-2.0"))
      .toBe(true);
    expect(minimal.blocks[0]?.content).toContain(
      "An Operation completing does not by itself prove that a Check passed",
    );
    expect(production.blocks.find(({ id }) => id === "verification_and_completion")?.content)
      .toContain("refresh stale subject state");
  });

  it("is deterministic and changes resolved identity with model correlation", () => {
    const first = resolveDefault("production", "helarc-code-agent");
    const second = resolveDefault("production", "helarc-code-agent");
    const otherModel = resolveHelarcAgentInstructions({
      catalog: HELARC_INSTRUCTION_CATALOG,
      target: "production",
      agentId: "helarc-code-agent",
      providerId: MODEL.providerId,
      modelId: "other-model",
    });

    expect(second).toEqual(first);
    expect(second.contentDigest.value).toBe(first.contentDigest.value);
    expect(otherModel.contentDigest.value).not.toBe(first.contentDigest.value);
    expect(Object.isFrozen(HELARC_INSTRUCTION_CATALOG)).toBe(true);
    expect(Object.isFrozen(HELARC_INSTRUCTION_CATALOG.releases)).toBe(true);
  });

  it("never falls back when an explicit target is unavailable", () => {
    const source = testSource("base", "base");
    const production = testRelease({
      id: "production",
      target: "production",
      agentId: "agent",
      composition: { kind: "complete", base: null, sources: [source.ref] },
    });
    const catalog = createHelarcInstructionCatalog({
      sources: [source],
      releases: [production],
      targets: [{ target: "production", release: production.ref }],
    });

    expectResolutionError(() => resolveHelarcAgentInstructions({
      catalog,
      target: "minimal",
      agentId: "agent",
      ...MODEL,
    }), "instruction_target_unavailable");
  });

  it("rejects a target selection that points at another target's release", () => {
    const source = testSource("base", "base");
    const production = testRelease({
      id: "production",
      target: "production",
      agentId: "agent",
      composition: { kind: "complete", base: null, sources: [source.ref] },
    });

    expectResolutionError(() => createHelarcInstructionCatalog({
      sources: [source],
      releases: [production],
      targets: [{ target: "minimal", release: production.ref }],
    }), "instruction_catalog_corrupt");
  });

  it("content-addresses release changes and supports immutable target rollback", () => {
    const sourceV1 = testSource("behavior", "behavior");
    const sourceV2 = createHelarcInstructionSource({
      id: "behavior",
      section: "behavior",
      treatment: "adapted",
      content: "Revised instruction behavior.",
      provenance: { reference: "test-v2", license: "Apache-2.0", reviewedAt: DATE },
    });
    const releaseV1 = testRelease({
      id: "release",
      target: "production",
      agentId: "agent",
      composition: { kind: "complete", base: null, sources: [sourceV1.ref] },
    });
    const releaseV2 = testRelease({
      id: "release",
      target: "production",
      agentId: "agent",
      composition: { kind: "complete", base: null, sources: [sourceV2.ref] },
    });
    expect(releaseV2.ref.revision).not.toBe(releaseV1.ref.revision);

    const rollbackCatalog = createHelarcInstructionCatalog({
      sources: [sourceV1, sourceV2],
      releases: [releaseV1, releaseV2],
      targets: [{ target: "production", release: releaseV1.ref }],
    });
    const currentCatalog = createHelarcInstructionCatalog({
      sources: [sourceV1, sourceV2],
      releases: [releaseV1, releaseV2],
      targets: [{ target: "production", release: releaseV2.ref }],
    });
    const rollback = resolveHelarcAgentInstructions({
      catalog: rollbackCatalog,
      target: "production",
      agentId: "agent",
      ...MODEL,
    });
    const current = resolveHelarcAgentInstructions({
      catalog: currentCatalog,
      target: "production",
      agentId: "agent",
      ...MODEL,
    });
    expect(rollback.release).toEqual(releaseV1.ref);
    expect(current.release).toEqual(releaseV2.ref);
    expect(current.contentDigest.value).not.toBe(rollback.contentDigest.value);
  });

  it("rejects release cycles and missing bases", () => {
    const releaseARef = { id: "release-a", revision: `sha256:${"a".repeat(64)}` };
    const releaseBRef = { id: "release-b", revision: `sha256:${"b".repeat(64)}` };
    const releaseA = forgedRelease(releaseARef, "production", releaseBRef);
    const releaseB = forgedRelease(releaseBRef, "minimal", releaseARef);
    const cyclic = Object.freeze({
      revision: `sha256:${"c".repeat(64)}`,
      sources: Object.freeze([]),
      releases: Object.freeze([releaseA, releaseB]),
      targets: Object.freeze([{ target: "production" as const, release: releaseARef }]),
    }) satisfies HelarcInstructionCatalog;
    expectResolutionError(() => resolveHelarcAgentInstructions({
      catalog: cyclic,
      target: "production",
      agentId: "agent",
      ...MODEL,
    }), "instruction_release_cycle");

    const missing = testRelease({
      id: "missing-base",
      target: "production",
      agentId: "agent",
      composition: { kind: "extends", base: { id: "absent", revision: `sha256:${"f".repeat(64)}` }, sources: [] },
    });
    const missingCatalog = createHelarcInstructionCatalog({
      sources: [],
      releases: [missing],
      targets: [{ target: "production", release: missing.ref }],
    });
    expectResolutionError(() => resolveHelarcAgentInstructions({
      catalog: missingCatalog,
      target: "production",
      agentId: "agent",
      ...MODEL,
    }), "instruction_release_missing");
  });

  it("rejects duplicate sources, ambiguous model extensions, and digest corruption", () => {
    const source = testSource("base", "base");
    const duplicate = testRelease({
      id: "duplicate",
      target: "production",
      agentId: "agent",
      composition: { kind: "complete", base: null, sources: [source.ref, source.ref] },
    });
    const duplicateCatalog = createHelarcInstructionCatalog({
      sources: [source],
      releases: [duplicate],
      targets: [{ target: "production", release: duplicate.ref }],
    });
    expectResolutionError(() => resolveHelarcAgentInstructions({
      catalog: duplicateCatalog,
      target: "production",
      agentId: "agent",
      ...MODEL,
    }), "instruction_source_duplicate");

    const ambiguous = createHelarcInstructionRelease({
      id: "ambiguous",
      target: "production",
      agentId: "agent",
      composition: { kind: "complete", base: null, sources: [source.ref] },
      modelExtensions: [
        { condition: { id: "one", providerId: MODEL.providerId, modelIds: null }, sources: [] },
        { condition: { id: "two", providerId: MODEL.providerId, modelIds: [MODEL.modelId] }, sources: [] },
      ],
      createdAt: DATE,
      reviewedAt: DATE,
    });
    const ambiguousCatalog = createHelarcInstructionCatalog({
      sources: [source],
      releases: [ambiguous],
      targets: [{ target: "production", release: ambiguous.ref }],
    });
    expectResolutionError(() => resolveHelarcAgentInstructions({
      catalog: ambiguousCatalog,
      target: "production",
      agentId: "agent",
      ...MODEL,
    }), "instruction_model_condition_ambiguous");

    expectResolutionError(() => createHelarcInstructionCatalog({
      sources: [source],
      releases: [{ ...ambiguous, manifestDigest: `sha256:${"0".repeat(64)}` }],
      targets: [{ target: "production", release: ambiguous.ref }],
    }), "instruction_catalog_corrupt");

    const restricted = createHelarcInstructionRelease({
      id: "restricted",
      target: "production",
      agentId: "agent",
      composition: { kind: "complete", base: null, sources: [source.ref] },
      modelSupport: [{ id: "supported", providerId: "other-provider", modelIds: null }],
      createdAt: DATE,
      reviewedAt: DATE,
    });
    const restrictedCatalog = createHelarcInstructionCatalog({
      sources: [source],
      releases: [restricted],
      targets: [{ target: "production", release: restricted.ref }],
    });
    expectResolutionError(() => resolveHelarcAgentInstructions({
      catalog: restrictedCatalog,
      target: "production",
      agentId: "agent",
      ...MODEL,
    }), "instruction_model_unsupported");
  });
});

function resolveDefault(
  target: "minimal" | "production" | "delegated-worker",
  agentId: string,
) {
  return resolveHelarcAgentInstructions({
    catalog: HELARC_INSTRUCTION_CATALOG,
    target,
    agentId,
    ...MODEL,
  });
}

function testSource(id: string, section: string) {
  return createHelarcInstructionSource({
    id,
    section,
    treatment: "authored",
    content: `Instruction ${id}.`,
    provenance: { reference: "test", license: "Apache-2.0", reviewedAt: DATE },
  });
}

function testRelease(input: Pick<
  HelarcInstructionRelease,
  "target" | "agentId" | "composition"
> & { readonly id: string }) {
  return createHelarcInstructionRelease({
    id: input.id,
    target: input.target,
    agentId: input.agentId,
    composition: input.composition,
    createdAt: DATE,
    reviewedAt: DATE,
  });
}

function forgedRelease(
  ref: { readonly id: string; readonly revision: string },
  target: "minimal" | "production",
  base: { readonly id: string; readonly revision: string },
): HelarcInstructionRelease {
  return Object.freeze({
    ref: Object.freeze(ref),
    target,
    agentId: "agent",
    resolverRevision: "test-resolver.v1",
    composition: Object.freeze({
      kind: "extends" as const,
      base: Object.freeze(base),
      sources: Object.freeze([]),
    }),
    modelSupport: null,
    modelExtensions: Object.freeze([]),
    status: "available" as const,
    createdAt: DATE,
    reviewedAt: DATE,
    manifestDigest: `sha256:${"d".repeat(64)}`,
  });
}

function expectResolutionError(operation: () => unknown, code: string): void {
  try {
    operation();
    throw new Error("Expected HelarcInstructionResolutionError.");
  } catch (error) {
    expect(error).toBeInstanceOf(HelarcInstructionResolutionError);
    expect((error as HelarcInstructionResolutionError).code).toBe(code);
  }
}
