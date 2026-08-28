import { describe, expect, it } from "vitest";
import { createOperationCatalogSnapshot } from "@agent-anything/operation-catalog/catalog";
import { createToolRegistrationSnapshot, type RegisteredTool } from "@agent-anything/tools/registration";
import type { ToolDescriptorInput } from "@agent-anything/tools/catalog";
import {
  HelarcToolGuidanceError,
  admitHelarcSelectedTools,
  annotateHelarcToolInputSchema,
  collectHelarcToolInputFieldPointers,
  createHelarcToolGuidanceBinding,
  createHelarcToolGuidanceCatalog,
  createHelarcToolGuidanceRelease,
  createHelarcToolGuidanceSource,
  projectHelarcToolGuidanceSafe,
  resolveHelarcToolGuidance,
  type HelarcToolGuidanceSource,
} from "./index.js";

const DATE = "2026-08-28T00:00:00.000Z";
const PROFILE = "helarc.complete-test-tools.v1";

describe("Helarc Product Tool Guidance", () => {
  it("creates deterministic immutable sources, releases, catalogs, profiles, and bindings", () => {
    const tools = registeredTools("Read", "Write");
    const sources = tools.map((tool) => guidanceSource(tool));
    const release = guidanceRelease(sources);
    const catalog = createHelarcToolGuidanceCatalog({ sources, releases: [release] });
    const selection = admitHelarcSelectedTools({ toolSelectionRevision: PROFILE, tools });
    const resolved = resolveHelarcToolGuidance({
      catalog,
      release: release.ref,
      providerId: "ollama",
      modelId: "gemma4:e4b",
      toolSelectionRevision: PROFILE,
      tools,
    });
    const repeated = resolveHelarcToolGuidance({
      catalog,
      release: release.ref,
      providerId: "ollama",
      modelId: "gemma4:e4b",
      toolSelectionRevision: PROFILE,
      tools,
    });
    const binding = createHelarcToolGuidanceBinding({ runId: "run-1", guidance: resolved });

    expect(repeated).toEqual(resolved);
    expect(selection.id).toBe(resolved.toolSelection.id);
    expect(resolved.entries.map(({ name }) => name)).toEqual(["Read", "Write"]);
    expect(Object.isFrozen(catalog)).toBe(true);
    expect(Object.isFrozen(resolved.entries[0]?.inputSchema)).toBe(true);
    expect(binding.guidanceId).toBe(resolved.id);
    expect(projectHelarcToolGuidanceSafe(resolved)).toEqual({
      releaseId: "test-guidance",
      releaseRevision: release.ref.revision,
      guidanceProfileRevision: PROFILE,
      toolSelectionRevision: PROFILE,
      providerId: "ollama",
      modelId: "gemma4:e4b",
      entryCount: 2,
      resolverRevision: "helarc.tool-guidance-resolver.v1",
    });
    expect(JSON.stringify(projectHelarcToolGuidanceSafe(resolved))).not.toContain(
      "Use Read",
    );
  });

  it("adds descriptions only at canonical JSON Pointer fields and preserves structural shape", () => {
    const schema = {
      type: "object",
      additionalProperties: false,
      required: ["questions"],
      properties: {
        questions: {
          type: "array",
          items: {
            type: "object",
            properties: {
              prompt: { type: "string" },
              metadata: {
                type: "object",
                properties: { "a/b~c": { type: "boolean" } },
              },
            },
          },
        },
      },
    } as const;
    const pointers = collectHelarcToolInputFieldPointers(schema);
    expect(pointers).toEqual([
      "/properties/questions",
      "/properties/questions/items/properties/metadata",
      "/properties/questions/items/properties/metadata/properties/a~1b~0c",
      "/properties/questions/items/properties/prompt",
    ]);
    const annotated = annotateHelarcToolInputSchema({
      schema,
      fieldDescriptions: Object.fromEntries(pointers.map((pointer) => [
        pointer,
        `Meaning for ${pointer}.`,
      ])),
    });

    expect(annotated.canonicalShapeDigest).not.toBe(annotated.annotatedShapeDigest);
    expect(schema.properties.questions).not.toHaveProperty("description");
    expect((annotated.schema.properties as any).questions.description).toContain("questions");
    expect(() => annotateHelarcToolInputSchema({
      schema,
      fieldDescriptions: { "/properties/missing": "Unknown field." },
    })).toThrowError(expect.objectContaining({
      code: "tool_guidance_schema_coverage_invalid",
    }));
    expect(() => annotateHelarcToolInputSchema({
      schema,
      fieldDescriptions: {
        ...Object.fromEntries(pointers.map((pointer) => [pointer, "Known field."])),
        "/properties/questions/~2bad": "Invalid escape.",
      },
    })).toThrowError(HelarcToolGuidanceError);
  });

  it("resolves one exact complete model replacement without mutating the base release", () => {
    const tools = registeredTools("Read", "Write");
    const base = tools.map((tool) => guidanceSource(tool));
    const replacement = guidanceSource(tools[0]!, "Use Read only for exact bounded file observation.");
    const release = guidanceRelease(base, [{
      condition: { id: "ollama-gemma", providerId: "ollama", modelIds: ["gemma4:e4b"] },
      replacementSources: [replacement.ref],
    }]);
    const catalog = createHelarcToolGuidanceCatalog({
      sources: [...base, replacement],
      releases: [release],
    });

    const resolved = resolveHelarcToolGuidance({
      catalog,
      release: release.ref,
      providerId: "ollama",
      modelId: "gemma4:e4b",
      toolSelectionRevision: PROFILE,
      tools,
    });
    expect(resolved.entries.find(({ name }) => name === "Read")?.source)
      .toEqual(replacement.ref);
    expect(base[0]?.modelDescription).not.toBe(replacement.modelDescription);
  });

  it("resolves only the Run-selected subset from a complete Product guidance profile", () => {
    const productTools = registeredTools("Read", "Bash", "PowerShell");
    const sources = productTools.map((tool) => guidanceSource(tool));
    const release = guidanceRelease(sources);
    const catalog = createHelarcToolGuidanceCatalog({ sources, releases: [release] });

    const resolved = resolveHelarcToolGuidance({
      catalog,
      release: release.ref,
      providerId: "test-provider",
      modelId: "test-model",
      toolSelectionRevision: "windows-selection-1",
      tools: productTools.filter(({ descriptor }) => descriptor.name !== "Bash"),
    });

    expect(release.tools.map((tool) => tool.tool.name)).toEqual([
      "bash",
      "powershell",
      "read",
    ]);
    expect(resolved.entries.map(({ name }) => name)).toEqual(["PowerShell", "Read"]);
    expect(resolved.entries.map(({ name }) => name)).not.toContain("Bash");
  });

  it("fails closed for missing, extra, withdrawn, ambiguous, or incoherent profile material", () => {
    const tools = registeredTools("Read", "Write");
    const sources = tools.map((tool) => guidanceSource(tool));
    const baseInput = {
      providerId: "ollama",
      modelId: "gemma4:e4b",
      toolSelectionRevision: PROFILE,
      tools,
    } as const;

    const missingRelease = guidanceRelease(sources.slice(0, 1), [], tools.map(({ descriptor }) => descriptor.ref));
    expect(() => createHelarcToolGuidanceCatalog({ sources, releases: [missingRelease] }))
      .toThrowError(expect.objectContaining({ code: "tool_guidance_coverage_missing" }));

    const extraTool = registeredTools("Agent")[0]!;
    const extraSource = guidanceSource(extraTool);
    const extraRelease = guidanceRelease(
      [...sources, extraSource],
      [],
      tools.map(({ descriptor }) => descriptor.ref),
    );
    expect(() => createHelarcToolGuidanceCatalog({
      sources: [...sources, extraSource],
      releases: [extraRelease],
    })).toThrowError(expect.objectContaining({ code: "tool_guidance_coverage_extra" }));

    const validRelease = guidanceRelease(sources);
    expect(() => resolveHelarcToolGuidance({
      ...baseInput,
      tools: [...tools, extraTool],
      catalog: createHelarcToolGuidanceCatalog({ sources, releases: [validRelease] }),
      release: validRelease.ref,
    })).toThrowError(expect.objectContaining({ code: "tool_guidance_coverage_extra" }));

    const withdrawn = createHelarcToolGuidanceRelease({
      id: "withdrawn",
      guidanceProfileRevision: PROFILE,
      tools: tools.map(({ descriptor }) => descriptor.ref),
      sources: sources.map(({ ref }) => ref),
      status: "withdrawn",
      createdAt: DATE,
      reviewedAt: DATE,
    });
    expect(() => resolveHelarcToolGuidance({
      ...baseInput,
      catalog: createHelarcToolGuidanceCatalog({ sources, releases: [withdrawn] }),
      release: withdrawn.ref,
    })).toThrowError(expect.objectContaining({ code: "tool_guidance_release_withdrawn" }));

    const replacementA = guidanceSource(tools[0]!, "Complete replacement guidance A.");
    const replacementB = guidanceSource(tools[0]!, "Complete replacement guidance B.");
    const ambiguous = guidanceRelease(sources, [
      {
        condition: { id: "all-ollama", providerId: "ollama", modelIds: null },
        replacementSources: [replacementA.ref],
      },
      {
        condition: { id: "exact-gemma", providerId: "ollama", modelIds: ["gemma4:e4b"] },
        replacementSources: [replacementB.ref],
      },
    ]);
    expect(() => resolveHelarcToolGuidance({
      ...baseInput,
      catalog: createHelarcToolGuidanceCatalog({
        sources: [...sources, replacementA, replacementB],
        releases: [ambiguous],
      }),
      release: ambiguous.ref,
    })).toThrowError(expect.objectContaining({
      code: "tool_guidance_model_condition_ambiguous",
    }));

    const tampered = [{ ...tools[0]!, registrationFingerprint: `sha256:${"0".repeat(64)}` }];
    expect(() => admitHelarcSelectedTools({
      toolSelectionRevision: PROFILE,
      tools: tampered,
    })).toThrowError(expect.objectContaining({ code: "tool_guidance_binding_invalid" }));
  });

  it("rejects corrupt digests, duplicate refs, incomplete field coverage, and accessors", () => {
    const tools = registeredTools("Read");
    const source = guidanceSource(tools[0]!);
    expect(() => createHelarcToolGuidanceCatalog({
      sources: [{ ...source, ref: { ...source.ref, revision: `sha256:${"0".repeat(64)}` } }],
      releases: [],
    })).toThrowError(expect.objectContaining({ code: "tool_guidance_catalog_corrupt" }));
    expect(() => createHelarcToolGuidanceRelease({
      id: "duplicate",
      guidanceProfileRevision: PROFILE,
      tools: [source.tool],
      sources: [source.ref, source.ref],
      createdAt: DATE,
      reviewedAt: DATE,
    })).toThrowError(expect.objectContaining({ code: "tool_guidance_source_duplicate" }));

    const incomplete = createHelarcToolGuidanceSource({
      id: "incomplete",
      tool: tools[0]!.descriptor.ref,
      modelDescription: "Complete operational description with a missing field annotation.",
      inputFieldDescriptions: {},
      provenance: provenance(),
    });
    const release = guidanceRelease([incomplete]);
    expect(() => resolveHelarcToolGuidance({
      catalog: createHelarcToolGuidanceCatalog({ sources: [incomplete], releases: [release] }),
      release: release.ref,
      providerId: "test-provider",
      modelId: "test-model",
      toolSelectionRevision: PROFILE,
      tools,
    })).toThrowError(expect.objectContaining({ code: "tool_guidance_schema_coverage_invalid" }));

    const accessor = Object.defineProperty({}, "id", {
      enumerable: true,
      get: () => "secret",
    });
    expect(() => createHelarcToolGuidanceSource(accessor as never))
      .toThrowError(HelarcToolGuidanceError);
  });
});

function registeredTools(...names: string[]): readonly RegisteredTool[] {
  const operationCatalog = createOperationCatalogSnapshot({
    id: "empty-operation-catalog",
    revision: "1",
    entries: [],
  });
  return createToolRegistrationSnapshot(
    operationCatalog,
    names.map((name) => ({
      admissionId: `admit-${name}`,
      descriptor: descriptor(name),
      allowedOrigins: ["model"],
      admittedAt: DATE,
    })),
  ).registrations;
}

function descriptor(name: string): ToolDescriptorInput {
  return {
    ref: {
      tool: { namespace: "helarc", name: name.toLowerCase() },
      revision: "1",
    },
    name,
    description: `Concise ${name} display summary.`,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["value"],
      properties: { value: { type: "string", minLength: 1 } },
    },
    outputSchema: { type: "object", properties: { result: { type: "string" } } },
    schemaRevisions: {
      dialect: "json-schema-2020-12",
      input: "input-1",
      output: "output-1",
      translation: "native-1",
    },
    source: {
      kind: "product",
      sourceId: "helarc",
      sourceRevision: "1",
      activationEpoch: null,
    },
    binding: {
      kind: "interaction",
      protocol: { owner: "helarc", kind: `test-${name}`, revision: "1" },
      blockingScope: "branch",
      revision: `binding-${name}`,
    },
  };
}

function guidanceSource(
  tool: RegisteredTool,
  modelDescription = `Use ${tool.descriptor.name} for its exact complete declared responsibility.`,
): HelarcToolGuidanceSource {
  return createHelarcToolGuidanceSource({
    id: `guidance-${tool.descriptor.name.toLowerCase()}-${modelDescription.length}`,
    tool: tool.descriptor.ref,
    modelDescription,
    inputFieldDescriptions: {
      "/properties/value": `Exact input value for ${tool.descriptor.name}.`,
    },
    provenance: provenance(),
  });
}

function guidanceRelease(
  sources: readonly HelarcToolGuidanceSource[],
  modelExtensions: Parameters<typeof createHelarcToolGuidanceRelease>[0]["modelExtensions"] = [],
  tools: readonly ToolDescriptorInput["ref"][] = sources.map(({ tool }) => tool),
) {
  return createHelarcToolGuidanceRelease({
    id: "test-guidance",
    guidanceProfileRevision: PROFILE,
    tools,
    sources: sources.map(({ ref }) => ref),
    modelExtensions,
    createdAt: DATE,
    reviewedAt: DATE,
  });
}

function provenance() {
  return {
    reference: "authored:helarc-test",
    license: "Apache-2.0",
    reviewedAt: DATE,
  } as const;
}
