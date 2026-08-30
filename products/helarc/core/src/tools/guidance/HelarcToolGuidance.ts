import type { RegisteredTool } from "@agent-anything/tools/registration";
import type { ToolDescriptor, ToolJsonObject } from "@agent-anything/tools/catalog";
import { createToolCatalogSnapshot } from "@agent-anything/tools/catalog";
import type { ToolBindingRef, ToolRevisionRef } from "@agent-anything/tools/identity";
import { createToolContractIdentity, toolRevisionKey } from "@agent-anything/tools/identity";
import { operationRevisionKey } from "@agent-anything/operation-catalog/identity";
import { annotateHelarcToolInputSchema } from "./HelarcToolGuidanceSchema.js";
import { toolGuidanceError } from "./HelarcToolGuidanceError.js";

export const HELARC_TOOL_GUIDANCE_RESOLVER_REVISION =
  "helarc.tool-guidance-resolver.v1";

export interface HelarcToolGuidanceSourceRef {
  readonly id: string;
  readonly revision: string;
}

export interface HelarcToolGuidanceReleaseRef {
  readonly id: string;
  readonly revision: string;
}

export interface HelarcToolGuidanceProvenance {
  readonly reference: string;
  readonly license: string | null;
  readonly reviewedAt: string;
}

export interface HelarcToolGuidanceSource {
  readonly ref: HelarcToolGuidanceSourceRef;
  readonly tool: ToolRevisionRef;
  readonly modelDescription: string;
  readonly inputFieldDescriptions: Readonly<Record<string, string>>;
  readonly provenance: HelarcToolGuidanceProvenance;
}

export interface HelarcToolGuidanceModelCondition {
  readonly id: string;
  readonly providerId: string;
  readonly modelIds: readonly string[] | null;
}

export interface HelarcToolGuidanceModelExtension {
  readonly condition: HelarcToolGuidanceModelCondition;
  readonly replacementSources: readonly HelarcToolGuidanceSourceRef[];
}

export interface HelarcToolGuidanceRelease {
  readonly ref: HelarcToolGuidanceReleaseRef;
  readonly productId: "helarc";
  readonly resolverRevision: string;
  readonly guidanceProfileRevision: string;
  readonly tools: readonly ToolRevisionRef[];
  readonly sources: readonly HelarcToolGuidanceSourceRef[];
  readonly modelExtensions: readonly HelarcToolGuidanceModelExtension[];
  readonly status: "available" | "withdrawn";
  readonly createdAt: string;
  readonly reviewedAt: string;
  readonly manifestDigest: string;
}

export interface HelarcToolGuidanceCatalog {
  readonly revision: string;
  readonly sources: readonly HelarcToolGuidanceSource[];
  readonly releases: readonly HelarcToolGuidanceRelease[];
}

export interface HelarcSelectedToolEntry {
  readonly tool: ToolRevisionRef;
  readonly name: string;
  readonly descriptorFingerprint: string;
  readonly registrationFingerprint: string;
  readonly bindingDigest: string;
}

export interface HelarcSelectedToolAdmission {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly toolSelectionRevision: string;
  readonly tools: readonly HelarcSelectedToolEntry[];
}

export interface ResolvedHelarcToolGuidanceEntry {
  readonly tool: ToolRevisionRef;
  readonly name: string;
  readonly source: HelarcToolGuidanceSourceRef;
  readonly modelDescription: string;
  readonly inputFieldDescriptions: Readonly<Record<string, string>>;
  readonly inputSchema: ToolJsonObject;
  readonly canonicalSchemaDigest: string;
  readonly annotatedSchemaDigest: string;
  readonly descriptorFingerprint: string;
  readonly registrationFingerprint: string;
  readonly bindingDigest: string;
  readonly contentDigest: string;
}

export interface ResolvedHelarcToolGuidance {
  readonly id: string;
  readonly release: HelarcToolGuidanceReleaseRef;
  readonly productId: "helarc";
  readonly providerId: string;
  readonly modelId: string;
  readonly guidanceProfileRevision: string;
  readonly toolSelection: HelarcSelectedToolAdmission;
  readonly entries: readonly ResolvedHelarcToolGuidanceEntry[];
  readonly resolverRevision: string;
  readonly contentDigest: string;
}

export interface HelarcToolGuidanceBinding {
  readonly id: string;
  readonly runId: string;
  readonly guidanceId: string;
  readonly release: HelarcToolGuidanceReleaseRef;
  readonly providerId: string;
  readonly modelId: string;
  readonly guidanceProfileRevision: string;
  readonly toolSelectionId: string;
  readonly toolSelectionRevision: string;
  readonly contentDigest: string;
}

export interface HelarcToolGuidanceSafeProjection {
  readonly releaseId: string;
  readonly releaseRevision: string;
  readonly guidanceProfileRevision: string;
  readonly toolSelectionRevision: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly entryCount: number;
  readonly resolverRevision: string;
}

interface NormalizedRegisteredTool {
  readonly registration: RegisteredTool;
  readonly descriptor: ToolDescriptor;
  readonly entry: HelarcSelectedToolEntry;
}

export function createHelarcToolGuidanceSource(input: {
  readonly id: string;
  readonly tool: ToolRevisionRef;
  readonly modelDescription: string;
  readonly inputFieldDescriptions: Readonly<Record<string, string>>;
  readonly provenance: HelarcToolGuidanceProvenance;
}): HelarcToolGuidanceSource {
  assertExactRecord(input, "HelarcToolGuidanceSource", [
    "id",
    "tool",
    "modelDescription",
    "inputFieldDescriptions",
    "provenance",
  ]);
  const material = {
    id: token(input.id, "HelarcToolGuidanceSource.id"),
    tool: snapshotToolRef(input.tool, "HelarcToolGuidanceSource.tool"),
    modelDescription: boundedText(
      input.modelDescription,
      "HelarcToolGuidanceSource.modelDescription",
      131_072,
    ),
    inputFieldDescriptions: snapshotDescriptions(input.inputFieldDescriptions),
    provenance: snapshotProvenance(input.provenance),
  };
  const revision = digest("agent-anything.helarc.tool-guidance-source.v1", material);
  return deepFreeze({
    ref: { id: material.id, revision },
    tool: material.tool,
    modelDescription: material.modelDescription,
    inputFieldDescriptions: material.inputFieldDescriptions,
    provenance: material.provenance,
  });
}

export function createHelarcToolGuidanceRelease(input: {
  readonly id: string;
  readonly resolverRevision?: string;
  readonly guidanceProfileRevision: string;
  readonly tools: readonly ToolRevisionRef[];
  readonly sources: readonly HelarcToolGuidanceSourceRef[];
  readonly modelExtensions?: readonly HelarcToolGuidanceModelExtension[];
  readonly status?: HelarcToolGuidanceRelease["status"];
  readonly createdAt: string;
  readonly reviewedAt: string;
}): HelarcToolGuidanceRelease {
  assertExactRecord(input, "HelarcToolGuidanceRelease", [
    "id",
    "resolverRevision",
    "guidanceProfileRevision",
    "tools",
    "sources",
    "modelExtensions",
    "status",
    "createdAt",
    "reviewedAt",
  ]);
  const id = token(input.id, "HelarcToolGuidanceRelease.id");
  const tools = snapshotToolRefs(input.tools, "HelarcToolGuidanceRelease.tools");
  if (tools.length === 0) {
    toolGuidanceError(
      "tool_guidance_release_invalid",
      "A Tool Guidance release must declare a complete Product Tool profile.",
      "tools",
    );
  }
  uniqueToolKeys(tools, "tool_guidance_release_invalid", "Tool Guidance release profile");
  const sources = snapshotSourceRefs(input.sources, "HelarcToolGuidanceRelease.sources");
  if (sources.length === 0) {
    toolGuidanceError(
      "tool_guidance_release_invalid",
      "A Tool Guidance release must contain a complete base source set.",
      "sources",
    );
  }
  uniqueRefKeys(sources, "tool_guidance_source_duplicate", "Tool Guidance release sources");
  const releaseFields = {
    productId: "helarc" as const,
    resolverRevision: token(
      input.resolverRevision ?? HELARC_TOOL_GUIDANCE_RESOLVER_REVISION,
      "HelarcToolGuidanceRelease.resolverRevision",
    ),
    guidanceProfileRevision: token(
      input.guidanceProfileRevision,
      "HelarcToolGuidanceRelease.guidanceProfileRevision",
    ),
    tools,
    sources,
    modelExtensions: snapshotModelExtensions(input.modelExtensions ?? []),
    status: releaseStatus(input.status ?? "available"),
    createdAt: dateTime(input.createdAt, "HelarcToolGuidanceRelease.createdAt"),
    reviewedAt: dateTime(input.reviewedAt, "HelarcToolGuidanceRelease.reviewedAt"),
  };
  if (releaseFields.reviewedAt < releaseFields.createdAt) {
    toolGuidanceError(
      "tool_guidance_release_invalid",
      "A Tool Guidance release cannot be reviewed before it is created.",
      "reviewedAt",
    );
  }
  const manifestDigest = digest("agent-anything.helarc.tool-guidance-release.v1", {
    id,
    ...releaseFields,
  });
  return deepFreeze({
    ref: { id, revision: manifestDigest },
    ...releaseFields,
    manifestDigest,
  });
}

export function createHelarcToolGuidanceCatalog(input: {
  readonly sources: readonly HelarcToolGuidanceSource[];
  readonly releases: readonly HelarcToolGuidanceRelease[];
}): HelarcToolGuidanceCatalog {
  assertExactRecord(input, "HelarcToolGuidanceCatalog", ["sources", "releases"]);
  if (!Array.isArray(input.sources) || !Array.isArray(input.releases)) {
    toolGuidanceError(
      "tool_guidance_catalog_corrupt",
      "A Tool Guidance catalog requires source and release arrays.",
    );
  }
  const sources = Object.freeze(input.sources.map(snapshotSource));
  const releases = Object.freeze(input.releases.map(snapshotRelease));
  uniqueRefKeys(
    sources.map(({ ref }) => ref),
    "tool_guidance_source_duplicate",
    "Tool Guidance catalog sources",
  );
  uniqueRefKeys(
    releases.map(({ ref }) => ref),
    "tool_guidance_catalog_corrupt",
    "Tool Guidance catalog releases",
  );
  for (const release of releases) {
    const releaseSources = resolveSources(sources, release.sources);
    assertToolRefCoverage(releaseSources, release.tools, "release");
    for (const extension of release.modelExtensions) {
      const replacementSources = resolveSources(sources, extension.replacementSources);
      assertToolSubset(
        replacementSources.map(({ tool }) => tool),
        release.tools,
        `model extension '${extension.condition.id}'`,
      );
    }
  }
  const revision = digest("agent-anything.helarc.tool-guidance-catalog.v1", {
    sources: sources.map(({ ref }) => ref),
    releases: releases.map(({ ref }) => ref),
  });
  return deepFreeze({ revision, sources, releases });
}

export function admitHelarcSelectedTools(input: {
  readonly toolSelectionRevision: string;
  readonly tools: readonly RegisteredTool[];
}): HelarcSelectedToolAdmission {
  assertExactRecord(input, "HelarcSelectedToolAdmission", [
    "toolSelectionRevision",
    "tools",
  ]);
  const toolSelectionRevision = token(
    input.toolSelectionRevision,
    "HelarcSelectedToolAdmission.toolSelectionRevision",
  );
  const normalized = normalizeRegisteredTools(input.tools);
  const tools = Object.freeze(normalized.map(({ entry }) => entry));
  const id = digest("agent-anything.helarc.selected-tools.v1", {
    toolSelectionRevision,
    tools,
  });
  return deepFreeze({
    schemaVersion: 1 as const,
    id,
    toolSelectionRevision,
    tools,
  });
}

export function resolveHelarcToolGuidance(input: {
  readonly catalog: HelarcToolGuidanceCatalog;
  readonly release: HelarcToolGuidanceReleaseRef;
  readonly providerId: string;
  readonly modelId: string;
  readonly toolSelectionRevision: string;
  readonly tools: readonly RegisteredTool[];
}): ResolvedHelarcToolGuidance {
  assertExactRecord(input, "ResolvedHelarcToolGuidanceInput", [
    "catalog",
    "release",
    "providerId",
    "modelId",
    "toolSelectionRevision",
    "tools",
  ]);
  const providerId = token(input.providerId, "ResolvedHelarcToolGuidance.providerId");
  const modelId = token(input.modelId, "ResolvedHelarcToolGuidance.modelId");
  const releaseRef = snapshotSourceRef(input.release, "ResolvedHelarcToolGuidance.release");
  const release = input.catalog.releases.find(({ ref }) => sameRef(ref, releaseRef));
  if (release === undefined) {
    return toolGuidanceError(
      "tool_guidance_release_missing",
      `Tool Guidance release '${refKey(releaseRef)}' is unavailable.`,
    );
  }
  if (release.status !== "available") {
    return toolGuidanceError(
      "tool_guidance_release_withdrawn",
      `Tool Guidance release '${refKey(releaseRef)}' is withdrawn.`,
    );
  }
  const toolSelection = admitHelarcSelectedTools({
    toolSelectionRevision: input.toolSelectionRevision,
    tools: input.tools,
  });
  const normalizedTools = normalizeRegisteredTools(input.tools);
  const baseSources = resolveSources(input.catalog.sources, release.sources);
  assertToolRefCoverage(baseSources, release.tools, "release");
  assertSelectedToolsBelongToProfile(normalizedTools, release.tools);
  const sourceByTool = new Map(baseSources.map((source) => [toolRevisionKey(source.tool), source]));
  const matches = release.modelExtensions.filter(({ condition }) =>
    matchesModel(condition, providerId, modelId)
  );
  if (matches.length > 1) {
    return toolGuidanceError(
      "tool_guidance_model_condition_ambiguous",
      `More than one Tool Guidance model condition matches '${providerId}/${modelId}'.`,
    );
  }
  if (matches.length === 1) {
    const replacements = resolveSources(input.catalog.sources, matches[0]!.replacementSources);
    const replacementKeys = new Set<string>();
    for (const replacement of replacements) {
      const key = toolRevisionKey(replacement.tool);
      if (replacementKeys.has(key)) {
        return toolGuidanceError(
          "tool_guidance_source_duplicate",
          `Model-specific Tool Guidance duplicates '${key}'.`,
        );
      }
      replacementKeys.add(key);
      if (!sourceByTool.has(key)) {
        return toolGuidanceError(
          "tool_guidance_coverage_extra",
          `Model-specific Tool Guidance references Tool '${key}' outside the base profile.`,
        );
      }
      sourceByTool.set(key, replacement);
    }
  }
  const resolvedSources = Object.freeze(normalizedTools.map(({ descriptor }) => {
    const source = sourceByTool.get(toolRevisionKey(descriptor.ref));
    if (source === undefined) {
      return toolGuidanceError(
        "tool_guidance_coverage_missing",
        `Resolved Tool Guidance is missing '${toolRevisionKey(descriptor.ref)}'.`,
      );
    }
    return source;
  }));
  assertSelectedCoverage(resolvedSources, normalizedTools, "resolved");

  const entries = Object.freeze(normalizedTools.map(({ descriptor, entry }) => {
    const source = sourceByTool.get(toolRevisionKey(descriptor.ref));
    if (source === undefined) {
      return toolGuidanceError(
        "tool_guidance_coverage_missing",
        `Resolved Tool Guidance is missing '${toolRevisionKey(descriptor.ref)}'.`,
      );
    }
    const annotated = annotateHelarcToolInputSchema({
      schema: descriptor.inputSchema,
      fieldDescriptions: source.inputFieldDescriptions,
    });
    const fields = {
      tool: descriptor.ref,
      name: descriptor.name,
      source: source.ref,
      modelDescription: source.modelDescription,
      inputFieldDescriptions: source.inputFieldDescriptions,
      inputSchema: annotated.schema,
      canonicalSchemaDigest: annotated.canonicalShapeDigest,
      annotatedSchemaDigest: annotated.annotatedShapeDigest,
      descriptorFingerprint: entry.descriptorFingerprint,
      registrationFingerprint: entry.registrationFingerprint,
      bindingDigest: entry.bindingDigest,
    };
    return deepFreeze({
      ...fields,
      contentDigest: digest("agent-anything.helarc.resolved-tool-guidance-entry.v1", fields),
    });
  }));
  const resolvedFields = {
    release: release.ref,
    productId: "helarc" as const,
    providerId,
    modelId,
    guidanceProfileRevision: release.guidanceProfileRevision,
    toolSelection,
    entries,
    resolverRevision: release.resolverRevision,
  };
  const contentDigest = digest(
    "agent-anything.helarc.resolved-tool-guidance.v1",
    resolvedFields,
  );
  return deepFreeze({ id: contentDigest, ...resolvedFields, contentDigest });
}

export function createHelarcToolGuidanceBinding(input: {
  readonly runId: string;
  readonly guidance: ResolvedHelarcToolGuidance;
}): HelarcToolGuidanceBinding {
  assertExactRecord(input, "HelarcToolGuidanceBinding", ["runId", "guidance"]);
  const fields = {
    runId: token(input.runId, "HelarcToolGuidanceBinding.runId"),
    guidanceId: digestRef(input.guidance.id, "HelarcToolGuidanceBinding.guidanceId"),
    release: snapshotSourceRef(input.guidance.release, "HelarcToolGuidanceBinding.release"),
    providerId: token(input.guidance.providerId, "HelarcToolGuidanceBinding.providerId"),
    modelId: token(input.guidance.modelId, "HelarcToolGuidanceBinding.modelId"),
    guidanceProfileRevision: token(
      input.guidance.guidanceProfileRevision,
      "HelarcToolGuidanceBinding.guidanceProfileRevision",
    ),
    toolSelectionId: digestRef(
      input.guidance.toolSelection.id,
      "HelarcToolGuidanceBinding.toolSelectionId",
    ),
    toolSelectionRevision: token(
      input.guidance.toolSelection.toolSelectionRevision,
      "HelarcToolGuidanceBinding.toolSelectionRevision",
    ),
    contentDigest: digestRef(
      input.guidance.contentDigest,
      "HelarcToolGuidanceBinding.contentDigest",
    ),
  };
  return deepFreeze({
    id: digest("agent-anything.helarc.tool-guidance-binding.v1", fields),
    ...fields,
  });
}

export function projectHelarcToolGuidanceSafe(
  guidance: ResolvedHelarcToolGuidance,
): HelarcToolGuidanceSafeProjection {
  return Object.freeze({
    releaseId: token(guidance.release.id, "HelarcToolGuidanceSafeProjection.releaseId"),
    releaseRevision: digestRef(
      guidance.release.revision,
      "HelarcToolGuidanceSafeProjection.releaseRevision",
    ),
    guidanceProfileRevision: token(
      guidance.guidanceProfileRevision,
      "HelarcToolGuidanceSafeProjection.guidanceProfileRevision",
    ),
    toolSelectionRevision: token(
      guidance.toolSelection.toolSelectionRevision,
      "HelarcToolGuidanceSafeProjection.toolSelectionRevision",
    ),
    providerId: token(guidance.providerId, "HelarcToolGuidanceSafeProjection.providerId"),
    modelId: token(guidance.modelId, "HelarcToolGuidanceSafeProjection.modelId"),
    entryCount: guidance.entries.length,
    resolverRevision: token(
      guidance.resolverRevision,
      "HelarcToolGuidanceSafeProjection.resolverRevision",
    ),
  });
}

function normalizeRegisteredTools(input: readonly RegisteredTool[]): readonly NormalizedRegisteredTool[] {
  if (!Array.isArray(input) || input.length === 0) {
    return toolGuidanceError(
      "tool_guidance_profile_invalid",
      "A Run Tool Selection requires at least one registered Tool.",
      "tools",
    );
  }
  assertDenseArray(input, "tools");
  const seen = new Set<string>();
  const normalized = input.map((registration, index) => {
    if (!isPlainRecord(registration as unknown)) {
      return toolGuidanceError(
        "tool_guidance_profile_invalid",
        "A Run Tool Selection requires registered Tool records.",
        `tools[${index}]`,
      );
    }
    const descriptor = createToolCatalogSnapshot([descriptorInput(registration.descriptor)]).tools[0]!;
    const key = toolRevisionKey(descriptor.ref);
    if (seen.has(key)) {
      return toolGuidanceError(
        "tool_guidance_profile_invalid",
        `Run Tool Selection duplicates '${key}'.`,
        `tools[${index}]`,
      );
    }
    seen.add(key);
    if (descriptor.retirement !== null) {
      return toolGuidanceError(
        "tool_guidance_profile_invalid",
        `Retired Tool '${key}' cannot enter a Run Tool Selection.`,
        `tools[${index}]`,
      );
    }
    if (!Array.isArray(registration.allowedOrigins) || !registration.allowedOrigins.includes("model")) {
      return toolGuidanceError(
        "tool_guidance_binding_invalid",
        `Tool '${key}' is not registered for model-origin requests.`,
        `tools[${index}].allowedOrigins`,
      );
    }
    if (!registrationBindingMatchesDescriptor(registration, descriptor)) {
      return toolGuidanceError(
        "tool_guidance_binding_invalid",
        `Tool '${key}' does not have one coherent admitted binding.`,
        `tools[${index}].binding`,
      );
    }
    const registrationBase = {
      admissionId: registration.admissionId,
      descriptor,
      binding: registration.binding,
      allowedOrigins: Object.freeze([...registration.allowedOrigins]),
      admittedAt: registration.admittedAt,
    };
    const expectedRegistrationFingerprint = createToolContractIdentity(
      "agent-anything.tool-registration.v3",
      registrationBase,
    );
    if (registration.registrationFingerprint !== expectedRegistrationFingerprint) {
      return toolGuidanceError(
        "tool_guidance_binding_invalid",
        `Tool '${key}' registration fingerprint is invalid.`,
        `tools[${index}].registrationFingerprint`,
      );
    }
    const entry = deepFreeze({
      tool: descriptor.ref,
      name: descriptor.name,
      descriptorFingerprint: descriptor.fingerprint,
      registrationFingerprint: expectedRegistrationFingerprint,
      bindingDigest: digest("agent-anything.helarc.tool-binding.v1", descriptor.binding),
    });
    return Object.freeze({ registration, descriptor, entry });
  });
  normalized.sort((left, right) =>
    toolRevisionKey(left.descriptor.ref).localeCompare(toolRevisionKey(right.descriptor.ref))
  );
  return Object.freeze(normalized);
}

function registrationBindingMatchesDescriptor(
  registration: RegisteredTool,
  descriptor: ToolDescriptor,
): boolean {
  if (registration.binding.kind !== descriptor.binding.kind) return false;
  switch (registration.binding.kind) {
    case "operation":
      return descriptor.binding.kind === "operation" &&
        operationRevisionKey(registration.binding.operation.operation.ref) ===
          operationRevisionKey(descriptor.binding.operation) &&
        registration.binding.operation.binding.ref.revision === descriptor.binding.revision;
    case "interaction":
      return descriptor.binding.kind === "interaction" &&
        registration.binding.ref.revision === descriptor.binding.revision &&
        registration.binding.ref.protocol.owner === descriptor.binding.protocol.owner &&
        registration.binding.ref.protocol.kind === descriptor.binding.protocol.kind &&
        registration.binding.ref.protocol.revision === descriptor.binding.protocol.revision;
    case "descendant_agent":
      return descriptor.binding.kind === "descendant_agent" &&
        registration.binding.ref.revision === descriptor.binding.revision &&
        registration.binding.ref.agent.id === descriptor.binding.agent.id &&
        registration.binding.ref.agent.revision === descriptor.binding.agent.revision;
    case "descendant_message":
      return descriptor.binding.kind === "descendant_message" &&
        registration.binding.ref.revision === descriptor.binding.revision &&
        registration.binding.ref.agent.id === descriptor.binding.agent.id &&
        registration.binding.ref.agent.revision === descriptor.binding.agent.revision;
  }
}

function assertSelectedCoverage(
  sources: readonly HelarcToolGuidanceSource[],
  tools: readonly NormalizedRegisteredTool[],
  label: string,
): void {
  const sourceKeys = sources.map(({ tool }) => toolRevisionKey(tool));
  if (new Set(sourceKeys).size !== sourceKeys.length) {
    toolGuidanceError(
      "tool_guidance_source_duplicate",
      `The ${label} Tool Guidance source set contains duplicate Tool revisions.`,
    );
  }
  const toolKeys = tools.map(({ descriptor }) => toolRevisionKey(descriptor.ref));
  const missing = toolKeys.filter((key) => !sourceKeys.includes(key));
  const extra = sourceKeys.filter((key) => !toolKeys.includes(key));
  if (missing.length > 0) {
    toolGuidanceError(
      "tool_guidance_coverage_missing",
      `The ${label} Tool Guidance source set is missing: ${missing.join(", ")}.`,
    );
  }
  if (extra.length > 0) {
    toolGuidanceError(
      "tool_guidance_coverage_extra",
      `The ${label} Tool Guidance source set contains extra Tools: ${extra.join(", ")}.`,
    );
  }
}

function assertToolRefCoverage(
  sources: readonly HelarcToolGuidanceSource[],
  tools: readonly ToolRevisionRef[],
  label: string,
): void {
  const sourceKeys = sources.map(({ tool }) => toolRevisionKey(tool));
  if (new Set(sourceKeys).size !== sourceKeys.length) {
    toolGuidanceError(
      "tool_guidance_source_duplicate",
      `The ${label} Tool Guidance source set contains duplicate Tool revisions.`,
    );
  }
  const toolKeys = tools.map(toolRevisionKey);
  const missing = toolKeys.filter((key) => !sourceKeys.includes(key));
  const extra = sourceKeys.filter((key) => !toolKeys.includes(key));
  if (missing.length > 0) {
    toolGuidanceError(
      "tool_guidance_coverage_missing",
      `The ${label} Tool Guidance source set is missing: ${missing.join(", ")}.`,
    );
  }
  if (extra.length > 0) {
    toolGuidanceError(
      "tool_guidance_coverage_extra",
      `The ${label} Tool Guidance source set contains extra Tools: ${extra.join(", ")}.`,
    );
  }
}

function assertSelectedToolsBelongToProfile(
  tools: readonly NormalizedRegisteredTool[],
  profile: readonly ToolRevisionRef[],
): void {
  const profileKeys = new Set(profile.map(toolRevisionKey));
  const extra = tools
    .map(({ descriptor }) => toolRevisionKey(descriptor.ref))
    .filter((key) => !profileKeys.has(key));
  if (extra.length > 0) {
    toolGuidanceError(
      "tool_guidance_coverage_extra",
      `The Run Tool Selection contains Tools outside the guidance profile: ${extra.join(", ")}.`,
    );
  }
}

function assertToolSubset(
  tools: readonly ToolRevisionRef[],
  profile: readonly ToolRevisionRef[],
  label: string,
): void {
  uniqueToolKeys(tools, "tool_guidance_source_duplicate", label);
  const profileKeys = new Set(profile.map(toolRevisionKey));
  const extra = tools.map(toolRevisionKey).filter((key) => !profileKeys.has(key));
  if (extra.length > 0) {
    toolGuidanceError(
      "tool_guidance_coverage_extra",
      `The ${label} references Tools outside the guidance profile: ${extra.join(", ")}.`,
    );
  }
}

function resolveSources(
  sources: readonly HelarcToolGuidanceSource[],
  refs: readonly HelarcToolGuidanceSourceRef[],
): readonly HelarcToolGuidanceSource[] {
  const seen = new Set<string>();
  return Object.freeze(refs.map((ref) => {
    const key = refKey(ref);
    if (seen.has(key)) {
      return toolGuidanceError(
        "tool_guidance_source_duplicate",
        `Tool Guidance source '${key}' is duplicated.`,
      );
    }
    seen.add(key);
    const source = sources.find(({ ref: candidate }) => sameRef(candidate, ref));
    if (source === undefined) {
      return toolGuidanceError(
        "tool_guidance_source_missing",
        `Tool Guidance source '${key}' is unavailable.`,
      );
    }
    return source;
  }));
}

function snapshotSource(input: HelarcToolGuidanceSource): HelarcToolGuidanceSource {
  const recreated = createHelarcToolGuidanceSource({
    id: input.ref.id,
    tool: input.tool,
    modelDescription: input.modelDescription,
    inputFieldDescriptions: input.inputFieldDescriptions,
    provenance: input.provenance,
  });
  if (!sameRef(recreated.ref, input.ref)) {
    return toolGuidanceError(
      "tool_guidance_catalog_corrupt",
      `Tool Guidance source '${input.ref.id}' digest is invalid.`,
    );
  }
  return recreated;
}

function snapshotRelease(input: HelarcToolGuidanceRelease): HelarcToolGuidanceRelease {
  const recreated = createHelarcToolGuidanceRelease({
    id: input.ref.id,
    resolverRevision: input.resolverRevision,
    guidanceProfileRevision: input.guidanceProfileRevision,
    tools: input.tools,
    sources: input.sources,
    modelExtensions: input.modelExtensions,
    status: input.status,
    createdAt: input.createdAt,
    reviewedAt: input.reviewedAt,
  });
  if (!sameRef(recreated.ref, input.ref) || recreated.manifestDigest !== input.manifestDigest) {
    return toolGuidanceError(
      "tool_guidance_catalog_corrupt",
      `Tool Guidance release '${input.ref.id}' digest is invalid.`,
    );
  }
  return recreated;
}

function snapshotToolRefs(
  input: readonly ToolRevisionRef[],
  path: string,
): readonly ToolRevisionRef[] {
  if (!Array.isArray(input)) {
    return toolGuidanceError(
      "tool_guidance_release_invalid",
      "A Tool Guidance profile must be an array.",
      path,
    );
  }
  assertDenseArray(input, path);
  return Object.freeze(input.map((ref, index) => snapshotToolRef(ref, `${path}[${index}]`)));
}

function snapshotModelExtensions(
  input: readonly HelarcToolGuidanceModelExtension[],
): readonly HelarcToolGuidanceModelExtension[] {
  if (!Array.isArray(input)) {
    return toolGuidanceError(
      "tool_guidance_release_invalid",
      "Tool Guidance model extensions must be an array.",
      "modelExtensions",
    );
  }
  assertDenseArray(input, "modelExtensions");
  const extensions = input.map((extension, index) => {
    assertExactRecord(extension, `modelExtensions[${index}]`, [
      "condition",
      "replacementSources",
    ]);
    const condition = snapshotModelCondition(extension.condition);
    const replacementSources = snapshotSourceRefs(
      extension.replacementSources,
      `modelExtensions[${index}].replacementSources`,
    );
    if (replacementSources.length === 0) {
      toolGuidanceError(
        "tool_guidance_release_invalid",
        "A Tool Guidance model extension must replace at least one complete source.",
        `modelExtensions[${index}].replacementSources`,
      );
    }
    uniqueRefKeys(
      replacementSources,
      "tool_guidance_source_duplicate",
      `model extension '${condition.id}' sources`,
    );
    return deepFreeze({
      condition,
      replacementSources,
    });
  });
  const ids = extensions.map(({ condition }) => condition.id);
  if (new Set(ids).size !== ids.length) {
    toolGuidanceError(
      "tool_guidance_release_invalid",
      "Tool Guidance model extension condition IDs must be unique.",
      "modelExtensions",
    );
  }
  return Object.freeze(extensions);
}

function snapshotModelCondition(
  input: HelarcToolGuidanceModelCondition,
): HelarcToolGuidanceModelCondition {
  assertExactRecord(input, "HelarcToolGuidanceModelCondition", ["id", "providerId", "modelIds"]);
  const modelIds = input.modelIds === null
    ? null
    : snapshotUniqueTokens(input.modelIds, "HelarcToolGuidanceModelCondition.modelIds");
  if (modelIds !== null && modelIds.length === 0) {
    toolGuidanceError(
      "tool_guidance_release_invalid",
      "A Tool Guidance model condition must name at least one model or use null.",
    );
  }
  return deepFreeze({
    id: token(input.id, "HelarcToolGuidanceModelCondition.id"),
    providerId: token(input.providerId, "HelarcToolGuidanceModelCondition.providerId"),
    modelIds,
  });
}

function matchesModel(
  condition: HelarcToolGuidanceModelCondition,
  providerId: string,
  modelId: string,
): boolean {
  return condition.providerId === providerId &&
    (condition.modelIds === null || condition.modelIds.includes(modelId));
}

function snapshotSourceRefs(
  input: readonly HelarcToolGuidanceSourceRef[],
  path: string,
): readonly HelarcToolGuidanceSourceRef[] {
  if (!Array.isArray(input)) {
    return toolGuidanceError(
      "tool_guidance_release_invalid",
      "Tool Guidance source references must be an array.",
      path,
    );
  }
  assertDenseArray(input, path);
  return Object.freeze(input.map((ref, index) => snapshotSourceRef(ref, `${path}[${index}]`)));
}

function snapshotSourceRef<T extends { readonly id: string; readonly revision: string }>(
  input: T,
  path: string,
): T {
  assertExactRecord(input, path, ["id", "revision"]);
  return Object.freeze({
    id: token(input.id, `${path}.id`),
    revision: digestRef(input.revision, `${path}.revision`),
  }) as T;
}

function snapshotToolRef(input: ToolRevisionRef, path: string): ToolRevisionRef {
  assertExactRecord(input, path, ["tool", "revision"]);
  assertExactRecord(input.tool, `${path}.tool`, ["namespace", "name"]);
  return deepFreeze({
    tool: {
      namespace: token(input.tool.namespace, `${path}.tool.namespace`),
      name: token(input.tool.name, `${path}.tool.name`),
    },
    revision: token(input.revision, `${path}.revision`),
  });
}

function snapshotDescriptions(
  input: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  if (!isPlainRecord(input)) {
    return toolGuidanceError(
      "tool_guidance_source_invalid",
      "Tool Guidance field descriptions must use a plain object.",
      "inputFieldDescriptions",
    );
  }
  assertNoAccessors(input, "inputFieldDescriptions");
  if (Reflect.ownKeys(input).some((key) => typeof key !== "string")) {
    return toolGuidanceError(
      "tool_guidance_source_invalid",
      "Tool Guidance field descriptions cannot contain symbol properties.",
      "inputFieldDescriptions",
    );
  }
  const output: Record<string, string> = {};
  for (const pointer of Object.keys(input).sort(compareStrings)) {
    if (!pointer.startsWith("/") || pointer.includes("\0")) {
      return toolGuidanceError(
        "tool_guidance_schema_pointer_invalid",
        `Tool Guidance field pointer '${pointer}' is invalid.`,
        pointer,
      );
    }
    output[pointer] = boundedText(
      input[pointer],
      `HelarcToolGuidanceSource.inputFieldDescriptions['${pointer}']`,
      8_192,
    );
  }
  return Object.freeze(output);
}

function snapshotProvenance(
  input: HelarcToolGuidanceProvenance,
): HelarcToolGuidanceProvenance {
  assertExactRecord(input, "HelarcToolGuidanceProvenance", [
    "reference",
    "license",
    "reviewedAt",
  ]);
  return Object.freeze({
    reference: boundedText(input.reference, "HelarcToolGuidanceProvenance.reference", 8_192),
    license: input.license === null
      ? null
      : boundedText(input.license, "HelarcToolGuidanceProvenance.license", 1_024),
    reviewedAt: dateTime(input.reviewedAt, "HelarcToolGuidanceProvenance.reviewedAt"),
  });
}

function descriptorInput(descriptor: ToolDescriptor) {
  return {
    ref: descriptor.ref,
    name: descriptor.name,
    ...(descriptor.description === undefined ? {} : { description: descriptor.description }),
    inputSchema: descriptor.inputSchema,
    ...(descriptor.outputSchema === undefined ? {} : { outputSchema: descriptor.outputSchema }),
    schemaRevisions: descriptor.schemaRevisions,
    annotations: descriptor.annotations,
    source: descriptor.source,
    binding: descriptor.binding,
    retirement: descriptor.retirement,
    metadata: descriptor.metadata,
  };
}

function digest(domain: string, value: unknown): string {
  return createToolContractIdentity(domain, value);
}

function uniqueRefKeys(
  refs: readonly { readonly id: string; readonly revision: string }[],
  code: Parameters<typeof toolGuidanceError>[0],
  label: string,
): void {
  const keys = refs.map(refKey);
  if (new Set(keys).size !== keys.length) {
    toolGuidanceError(code, `${label} contain duplicate references.`);
  }
}

function uniqueToolKeys(
  refs: readonly ToolRevisionRef[],
  code: Parameters<typeof toolGuidanceError>[0],
  label: string,
): void {
  const keys = refs.map(toolRevisionKey);
  if (new Set(keys).size !== keys.length) {
    toolGuidanceError(code, `${label} contains duplicate Tool revisions.`);
  }
}

function sameRef(
  left: { readonly id: string; readonly revision: string },
  right: { readonly id: string; readonly revision: string },
): boolean {
  return left.id === right.id && left.revision === right.revision;
}

function refKey(ref: { readonly id: string; readonly revision: string }): string {
  return `${ref.id}@${ref.revision}`;
}

function token(input: unknown, path: string): string {
  if (
    typeof input !== "string" || input.length === 0 || input.length > 1_024 ||
    input !== input.trim() || input.includes("\0")
  ) {
    return toolGuidanceError(
      "tool_guidance_source_invalid",
      `${path} must be a bounded canonical token.`,
      path,
    );
  }
  return input;
}

function boundedText(input: unknown, path: string, maxLength: number): string {
  if (
    typeof input !== "string" || input.trim().length === 0 ||
    input.length > maxLength || input.includes("\0")
  ) {
    return toolGuidanceError(
      "tool_guidance_source_invalid",
      `${path} must be bounded non-empty text.`,
      path,
    );
  }
  return input;
}

function digestRef(input: unknown, path: string): string {
  if (typeof input !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(input)) {
    return toolGuidanceError(
      "tool_guidance_source_invalid",
      `${path} must be a canonical SHA-256 reference.`,
      path,
    );
  }
  return input;
}

function dateTime(input: unknown, path: string): string {
  if (
    typeof input !== "string" || Number.isNaN(Date.parse(input)) ||
    new Date(input).toISOString() !== input
  ) {
    return toolGuidanceError(
      "tool_guidance_source_invalid",
      `${path} must be an ISO date-time string.`,
      path,
    );
  }
  return input;
}

function releaseStatus(input: unknown): HelarcToolGuidanceRelease["status"] {
  if (input !== "available" && input !== "withdrawn") {
    return toolGuidanceError(
      "tool_guidance_release_invalid",
      "Tool Guidance release status is invalid.",
      "status",
    );
  }
  return input;
}

function snapshotUniqueTokens(input: readonly string[], path: string): readonly string[] {
  if (!Array.isArray(input)) {
    return toolGuidanceError(
      "tool_guidance_release_invalid",
      `${path} must be an array.`,
      path,
    );
  }
  assertDenseArray(input, path);
  const values = input.map((value, index) => token(value, `${path}[${index}]`));
  if (new Set(values).size !== values.length) {
    return toolGuidanceError(
      "tool_guidance_release_invalid",
      `${path} cannot contain duplicates.`,
      path,
    );
  }
  return Object.freeze(values.sort(compareStrings));
}

function assertExactRecord(input: unknown, path: string, allowed: readonly string[]): void {
  if (!isPlainRecord(input)) {
    toolGuidanceError(
      "tool_guidance_source_invalid",
      `${path} must be a plain object.`,
      path,
    );
  }
  assertNoAccessors(input, path);
  const keys = Reflect.ownKeys(input);
  if (keys.some((key) => typeof key !== "string" || !allowed.includes(key))) {
    toolGuidanceError(
      "tool_guidance_source_invalid",
      `${path} contains an unsupported field.`,
      path,
    );
  }
}

function assertNoAccessors(input: Record<string, any>, path: string): void {
  for (const key of Reflect.ownKeys(input)) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (descriptor?.get !== undefined || descriptor?.set !== undefined) {
      toolGuidanceError(
        "tool_guidance_source_invalid",
        `${path} cannot contain accessors.`,
        `${path}.${String(key)}`,
      );
    }
  }
}

function assertDenseArray(input: readonly unknown[], path: string): void {
  for (let index = 0; index < input.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(input, index)) {
      toolGuidanceError(
        "tool_guidance_source_invalid",
        `${path} cannot contain sparse arrays.`,
        `${path}[${index}]`,
      );
    }
  }
}

function isPlainRecord(input: unknown): input is Record<string, any> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return false;
  const prototype = Object.getPrototypeOf(input);
  return prototype === Object.prototype || prototype === null;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function deepFreeze<T>(input: T): T {
  if (input !== null && typeof input === "object" && !Object.isFrozen(input)) {
    for (const value of Object.values(input as Record<string, unknown>)) deepFreeze(value);
    Object.freeze(input);
  }
  return input;
}
