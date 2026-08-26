import { createHash } from "node:crypto";
import {
  createAgentInstructions,
  type AgentInstructionReleaseRef,
  type AgentInstructions,
} from "@agent-anything/agent-core/agent";

export const HELARC_INSTRUCTION_RESOLVER_REVISION = "helarc-instruction-resolver.v1";

export type HelarcInstructionTarget = "minimal" | "production" | "delegated-worker";
export type HelarcMainInstructionTarget = Exclude<HelarcInstructionTarget, "delegated-worker">;
export type HelarcInstructionSourceTreatment = "adopted" | "adapted" | "authored";

export interface HelarcInstructionSourceRef {
  readonly id: string;
  readonly revision: string;
}

export interface HelarcInstructionSource {
  readonly ref: HelarcInstructionSourceRef;
  readonly section: string;
  readonly treatment: HelarcInstructionSourceTreatment;
  readonly content: string;
  readonly provenance: {
    readonly reference: string;
    readonly license: string | null;
    readonly reviewedAt: string;
  };
}

export interface HelarcInstructionModelCondition {
  readonly id: string;
  readonly providerId: string;
  readonly modelIds: readonly string[] | null;
}

export interface HelarcInstructionModelExtension {
  readonly condition: HelarcInstructionModelCondition;
  readonly sources: readonly HelarcInstructionSourceRef[];
}

export interface HelarcInstructionRelease {
  readonly ref: AgentInstructionReleaseRef;
  readonly target: HelarcInstructionTarget;
  readonly agentId: string;
  readonly resolverRevision: string;
  readonly composition:
    | {
        readonly kind: "complete";
        readonly base: null;
        readonly sources: readonly HelarcInstructionSourceRef[];
      }
    | {
        readonly kind: "extends";
        readonly base: AgentInstructionReleaseRef;
        readonly sources: readonly HelarcInstructionSourceRef[];
      };
  readonly modelSupport: readonly HelarcInstructionModelCondition[] | null;
  readonly modelExtensions: readonly HelarcInstructionModelExtension[];
  readonly status: "available" | "withdrawn";
  readonly createdAt: string;
  readonly reviewedAt: string;
  readonly manifestDigest: string;
}

export interface HelarcInstructionTargetSelection {
  readonly target: HelarcInstructionTarget;
  readonly release: AgentInstructionReleaseRef;
}

export interface HelarcInstructionCatalog {
  readonly revision: string;
  readonly sources: readonly HelarcInstructionSource[];
  readonly releases: readonly HelarcInstructionRelease[];
  readonly targets: readonly HelarcInstructionTargetSelection[];
}

export type HelarcInstructionResolutionErrorCode =
  | "instruction_target_unavailable"
  | "instruction_release_missing"
  | "instruction_release_withdrawn"
  | "instruction_release_agent_mismatch"
  | "instruction_release_cycle"
  | "instruction_source_missing"
  | "instruction_source_duplicate"
  | "instruction_section_duplicate"
  | "instruction_model_unsupported"
  | "instruction_model_condition_ambiguous"
  | "instruction_catalog_corrupt";

export class HelarcInstructionResolutionError extends Error {
  constructor(readonly code: HelarcInstructionResolutionErrorCode, message: string) {
    super(message);
    this.name = "HelarcInstructionResolutionError";
  }
}

export function createHelarcInstructionSource(input: {
  readonly id: string;
  readonly section: string;
  readonly treatment: HelarcInstructionSourceTreatment;
  readonly content: string;
  readonly provenance: HelarcInstructionSource["provenance"];
}): HelarcInstructionSource {
  const material = {
    id: token(input.id, "HelarcInstructionSource.id"),
    section: token(input.section, "HelarcInstructionSource.section"),
    treatment: sourceTreatment(input.treatment),
    content: content(input.content, "HelarcInstructionSource.content"),
    provenance: snapshotProvenance(input.provenance),
  };
  const revision = digest("agent-anything.helarc.instruction-source.v1", material);
  return deepFreeze({
    ref: { id: material.id, revision },
    section: material.section,
    treatment: material.treatment,
    content: material.content,
    provenance: material.provenance,
  });
}

export function createHelarcInstructionRelease(input: {
  readonly id: string;
  readonly target: HelarcInstructionTarget;
  readonly agentId: string;
  readonly resolverRevision?: string;
  readonly composition: HelarcInstructionRelease["composition"];
  readonly modelSupport?: readonly HelarcInstructionModelCondition[] | null;
  readonly modelExtensions?: readonly HelarcInstructionModelExtension[];
  readonly status?: HelarcInstructionRelease["status"];
  readonly createdAt: string;
  readonly reviewedAt: string;
}): HelarcInstructionRelease {
  const id = token(input.id, "HelarcInstructionRelease.id");
  const releaseFields = {
    target: instructionTarget(input.target),
    agentId: token(input.agentId, "HelarcInstructionRelease.agentId"),
    resolverRevision: token(
      input.resolverRevision ?? HELARC_INSTRUCTION_RESOLVER_REVISION,
      "HelarcInstructionRelease.resolverRevision",
    ),
    composition: snapshotComposition(input.composition),
    modelSupport: input.modelSupport === undefined || input.modelSupport === null
      ? null
      : snapshotModelConditions(input.modelSupport),
    modelExtensions: snapshotModelExtensions(input.modelExtensions ?? []),
    status: releaseStatus(input.status ?? "available"),
    createdAt: dateTime(input.createdAt, "HelarcInstructionRelease.createdAt"),
    reviewedAt: dateTime(input.reviewedAt, "HelarcInstructionRelease.reviewedAt"),
  };
  const manifestDigest = digest("agent-anything.helarc.instruction-release.v1", {
    id,
    ...releaseFields,
  });
  return deepFreeze({
    ref: { id, revision: manifestDigest },
    ...releaseFields,
    manifestDigest,
  });
}

export function createHelarcInstructionCatalog(input: {
  readonly sources: readonly HelarcInstructionSource[];
  readonly releases: readonly HelarcInstructionRelease[];
  readonly targets: readonly HelarcInstructionTargetSelection[];
}): HelarcInstructionCatalog {
  const sources = Object.freeze(input.sources.map(snapshotSource));
  const releases = Object.freeze(input.releases.map(snapshotRelease));
  const targets = Object.freeze(input.targets.map(snapshotTargetSelection));
  uniqueRefs(sources.map(({ ref }) => ref), "instruction source");
  uniqueRefs(releases.map(({ ref }) => ref), "instruction release");
  uniqueValues(targets.map(({ target }) => target), "instruction target");
  for (const selection of targets) {
    const release = releases.find(({ ref }) => sameRef(ref, selection.release));
    if (release === undefined) {
      resolutionError("instruction_catalog_corrupt", `Target '${selection.target}' references a missing release.`);
    }
    if (release.target !== selection.target) {
      resolutionError(
        "instruction_catalog_corrupt",
        `Target '${selection.target}' references a '${release.target}' release.`,
      );
    }
  }
  const revision = digest("agent-anything.helarc.instruction-catalog.v1", {
    sources: sources.map(({ ref }) => ref),
    releases: releases.map(({ ref }) => ref),
    targets,
  });
  return deepFreeze({ revision, sources, releases, targets });
}

export function resolveHelarcAgentInstructions(input: {
  readonly catalog: HelarcInstructionCatalog;
  readonly target: HelarcInstructionTarget;
  readonly agentId: string;
  readonly providerId: string;
  readonly modelId: string;
}): AgentInstructions {
  const target = instructionTarget(input.target);
  const agentId = token(input.agentId, "HelarcInstructionResolution.agentId");
  const providerId = token(input.providerId, "HelarcInstructionResolution.providerId");
  const modelId = token(input.modelId, "HelarcInstructionResolution.modelId");
  const selection = input.catalog.targets.find((candidate) => candidate.target === target);
  if (selection === undefined) {
    return resolutionError("instruction_target_unavailable", `Instruction target '${target}' is unavailable.`);
  }
  const release = findRelease(input.catalog, selection.release);
  if (release.agentId !== agentId) {
    return resolutionError(
      "instruction_release_agent_mismatch",
      `Instruction target '${target}' does not belong to Agent '${agentId}'.`,
    );
  }
  const sourceRefs = resolveReleaseSources(
    input.catalog,
    release,
    providerId,
    modelId,
    new Set(),
  );
  const seenSourceRefs = new Set<string>();
  const seenSections = new Set<string>();
  const sources = sourceRefs.map((ref) => {
    const key = refKey(ref);
    if (seenSourceRefs.has(key)) {
      return resolutionError("instruction_source_duplicate", `Instruction source '${key}' is duplicated.`);
    }
    seenSourceRefs.add(key);
    const source = input.catalog.sources.find(({ ref: candidate }) => sameRef(candidate, ref));
    if (source === undefined) {
      return resolutionError("instruction_source_missing", `Instruction source '${key}' is unavailable.`);
    }
    if (seenSections.has(source.section)) {
      return resolutionError(
        "instruction_section_duplicate",
        `Instruction section '${source.section}' is duplicated.`,
      );
    }
    seenSections.add(source.section);
    return source;
  });

  return createAgentInstructions({
    id: `${release.agentId}.${release.target}.instructions`,
    release: release.ref,
    model: { providerId, modelId },
    resolverRevision: release.resolverRevision,
    blocks: sources.map((source) => ({
      id: source.section,
      source: {
        owner: "helarc",
        kind: "product_agent_instruction_source",
        id: source.ref.id,
        revision: source.ref.revision,
      },
      content: source.content,
    })),
  });
}

function resolveReleaseSources(
  catalog: HelarcInstructionCatalog,
  release: HelarcInstructionRelease,
  providerId: string,
  modelId: string,
  stack: Set<string>,
): readonly HelarcInstructionSourceRef[] {
  const key = refKey(release.ref);
  if (stack.has(key)) {
    return resolutionError("instruction_release_cycle", `Instruction release cycle includes '${key}'.`);
  }
  if (release.status !== "available") {
    return resolutionError("instruction_release_withdrawn", `Instruction release '${key}' is withdrawn.`);
  }
  if (
    release.modelSupport !== null &&
    !release.modelSupport.some((condition) => matchesModel(condition, providerId, modelId))
  ) {
    return resolutionError(
      "instruction_model_unsupported",
      `Instruction release '${key}' does not support ${providerId}/${modelId}.`,
    );
  }
  const extensions = release.modelExtensions.filter(({ condition }) =>
    matchesModel(condition, providerId, modelId)
  );
  if (extensions.length > 1) {
    return resolutionError(
      "instruction_model_condition_ambiguous",
      `Instruction release '${key}' has ambiguous model extensions.`,
    );
  }
  stack.add(key);
  const base = release.composition.kind === "extends"
    ? resolveReleaseSources(
        catalog,
        findRelease(catalog, release.composition.base),
        providerId,
        modelId,
        stack,
      )
    : [];
  stack.delete(key);
  return Object.freeze([
    ...base,
    ...release.composition.sources,
    ...(extensions[0]?.sources ?? []),
  ]);
}

function findRelease(
  catalog: HelarcInstructionCatalog,
  ref: AgentInstructionReleaseRef,
): HelarcInstructionRelease {
  const release = catalog.releases.find(({ ref: candidate }) => sameRef(candidate, ref));
  if (release === undefined) {
    return resolutionError("instruction_release_missing", `Instruction release '${refKey(ref)}' is unavailable.`);
  }
  return release;
}

function snapshotSource(input: HelarcInstructionSource): HelarcInstructionSource {
  const recreated = createHelarcInstructionSource({
    id: input.ref.id,
    section: input.section,
    treatment: input.treatment,
    content: input.content,
    provenance: input.provenance,
  });
  if (!sameRef(recreated.ref, input.ref)) {
    return resolutionError("instruction_catalog_corrupt", `Instruction source '${input.ref.id}' digest is invalid.`);
  }
  return recreated;
}

function snapshotRelease(input: HelarcInstructionRelease): HelarcInstructionRelease {
  const recreated = createHelarcInstructionRelease({
    id: input.ref.id,
    target: input.target,
    agentId: input.agentId,
    resolverRevision: input.resolverRevision,
    composition: input.composition,
    modelSupport: input.modelSupport,
    modelExtensions: input.modelExtensions,
    status: input.status,
    createdAt: input.createdAt,
    reviewedAt: input.reviewedAt,
  });
  if (!sameRef(recreated.ref, input.ref) || recreated.manifestDigest !== input.manifestDigest) {
    return resolutionError("instruction_catalog_corrupt", `Instruction release '${input.ref.id}' digest is invalid.`);
  }
  return recreated;
}

function snapshotTargetSelection(
  input: HelarcInstructionTargetSelection,
): HelarcInstructionTargetSelection {
  return deepFreeze({
    target: instructionTarget(input.target),
    release: snapshotReleaseRef(input.release, "HelarcInstructionTargetSelection.release"),
  });
}

function snapshotComposition(
  input: HelarcInstructionRelease["composition"],
): HelarcInstructionRelease["composition"] {
  if (input.kind === "complete") {
    if (input.base !== null) throw new TypeError("A complete instruction release cannot have a base.");
    return deepFreeze({ kind: "complete" as const, base: null, sources: snapshotRefs(input.sources) });
  }
  if (input.kind !== "extends") throw new TypeError("Instruction release composition kind is invalid.");
  return deepFreeze({
    kind: "extends" as const,
    base: snapshotReleaseRef(input.base, "HelarcInstructionRelease.composition.base"),
    sources: snapshotRefs(input.sources),
  });
}

function snapshotModelConditions(
  input: readonly HelarcInstructionModelCondition[],
): readonly HelarcInstructionModelCondition[] {
  const conditions = Object.freeze(input.map(snapshotModelCondition));
  uniqueValues(conditions.map(({ id }) => id), "model condition");
  return conditions;
}

function snapshotModelCondition(
  input: HelarcInstructionModelCondition,
): HelarcInstructionModelCondition {
  return deepFreeze({
    id: token(input.id, "HelarcInstructionModelCondition.id"),
    providerId: token(input.providerId, "HelarcInstructionModelCondition.providerId"),
    modelIds: input.modelIds === null
      ? null
      : Object.freeze(input.modelIds.map((modelId) => token(modelId, "HelarcInstructionModelCondition.modelIds"))),
  });
}

function snapshotModelExtensions(
  input: readonly HelarcInstructionModelExtension[],
): readonly HelarcInstructionModelExtension[] {
  const extensions = Object.freeze(input.map((extension) => deepFreeze({
    condition: snapshotModelCondition(extension.condition),
    sources: snapshotRefs(extension.sources),
  })));
  uniqueValues(extensions.map(({ condition }) => condition.id), "model extension condition");
  return extensions;
}

function matchesModel(
  condition: HelarcInstructionModelCondition,
  providerId: string,
  modelId: string,
): boolean {
  return condition.providerId === providerId &&
    (condition.modelIds === null || condition.modelIds.includes(modelId));
}

function snapshotRefs(
  input: readonly HelarcInstructionSourceRef[],
): readonly HelarcInstructionSourceRef[] {
  if (!Array.isArray(input)) throw new TypeError("Instruction source refs must be an array.");
  return Object.freeze(input.map((ref) => snapshotSourceRef(ref, "HelarcInstructionSourceRef")));
}

function snapshotSourceRef<T extends { readonly id: string; readonly revision: string }>(
  input: T,
  field: string,
): T {
  return Object.freeze({
    id: token(input.id, `${field}.id`),
    revision: digestRef(input.revision, `${field}.revision`),
  }) as T;
}

function snapshotReleaseRef<T extends { readonly id: string; readonly revision: string }>(
  input: T,
  field: string,
): T {
  return Object.freeze({
    id: token(input.id, `${field}.id`),
    revision: digestRef(input.revision, `${field}.revision`),
  }) as T;
}

function snapshotProvenance(
  input: HelarcInstructionSource["provenance"],
): HelarcInstructionSource["provenance"] {
  return Object.freeze({
    reference: token(input.reference, "HelarcInstructionSource.provenance.reference"),
    license: input.license === null
      ? null
      : token(input.license, "HelarcInstructionSource.provenance.license"),
    reviewedAt: dateTime(input.reviewedAt, "HelarcInstructionSource.provenance.reviewedAt"),
  });
}

function digest(domain: string, value: unknown): string {
  return `sha256:${createHash("sha256")
    .update(domain, "utf8")
    .update("\0", "utf8")
    .update(canonicalJson(value), "utf8")
    .digest("hex")}`;
}

function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Instruction identity requires finite numbers.");
    return Object.is(value, -0) ? "0" : value.toString();
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value === null || typeof value !== "object") {
    throw new TypeError("Instruction identity must be canonical JSON data.");
  }
  const keys = Object.keys(value).sort(compareStrings);
  return `{${keys.map((key) =>
    `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`
  ).join(",")}}`;
}

function uniqueRefs(
  refs: readonly { readonly id: string; readonly revision: string }[],
  field: string,
): void {
  uniqueValues(refs.map(refKey), field);
}

function uniqueValues(values: readonly string[], field: string): void {
  if (new Set(values).size !== values.length) {
    resolutionError("instruction_catalog_corrupt", `The ${field} list contains duplicates.`);
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

function token(input: unknown, field: string): string {
  if (
    typeof input !== "string" || input.length === 0 || input.length > 1_024 ||
    input !== input.trim() || input.includes("\0")
  ) {
    throw new TypeError(`${field} must be a bounded non-empty token.`);
  }
  return input;
}

function content(input: unknown, field: string): string {
  if (
    typeof input !== "string" || input.trim().length === 0 ||
    input.length > 262_144 || input.includes("\0")
  ) {
    throw new TypeError(`${field} must be bounded non-empty text.`);
  }
  return input;
}

function digestRef(input: unknown, field: string): string {
  if (typeof input !== "string" || !/^sha256:[0-9a-f]{64}$/.test(input)) {
    throw new TypeError(`${field} must be a canonical SHA-256 reference.`);
  }
  return input;
}

function dateTime(input: unknown, field: string): string {
  if (typeof input !== "string" || !Number.isFinite(Date.parse(input))) {
    throw new TypeError(`${field} must be a valid date-time string.`);
  }
  return input;
}

function instructionTarget(input: unknown): HelarcInstructionTarget {
  if (input !== "minimal" && input !== "production" && input !== "delegated-worker") {
    throw new TypeError("Helarc instruction target is invalid.");
  }
  return input;
}

function sourceTreatment(input: unknown): HelarcInstructionSourceTreatment {
  if (input !== "adopted" && input !== "adapted" && input !== "authored") {
    throw new TypeError("Helarc instruction source treatment is invalid.");
  }
  return input;
}

function releaseStatus(input: unknown): HelarcInstructionRelease["status"] {
  if (input !== "available" && input !== "withdrawn") {
    throw new TypeError("Helarc instruction release status is invalid.");
  }
  return input;
}

function resolutionError(code: HelarcInstructionResolutionErrorCode, message: string): never {
  throw new HelarcInstructionResolutionError(code, message);
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
