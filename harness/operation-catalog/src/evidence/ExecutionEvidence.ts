import {
  operationDefinitionRevisionKey, snapshotOperationBindingRevisionRef, snapshotOperationCorrelation,
  snapshotOperationInvocationRef, type OperationBindingRevisionRef, type OperationCorrelation,
} from "../identity/index.js";
import type { OperationLowerResultRef, OperationResultRef, OperationResult } from "../result/OperationResult.js";
import { dateTime, denseArray, strictRecord, token } from "../contract/OperationContractValidation.js";

export type ExecutionEvidenceKind = "execution" | "effect" | "support" | "material";

/** A locator for immutable owner evidence, never an authorization credential. */
export interface ExecutionEvidenceRef<K extends ExecutionEvidenceKind = ExecutionEvidenceKind> {
  readonly owner: string;
  readonly kind: K;
  readonly id: string;
  readonly revision: string;
}

export interface ExecutionEvidenceCoverage {
  readonly scope: string;
  readonly extent: "complete" | "partial" | "not_assessed";
  readonly limitations: readonly string[];
}

export type EvidenceData = null | boolean | number | string | readonly EvidenceData[] | {readonly [key: string]: EvidenceData};

export interface ExecutionEffectEvidence {
  readonly ref: ExecutionEvidenceRef<"effect">;
  readonly schema: {readonly owner: string; readonly id: string; readonly revision: string};
  readonly summary: string;
  readonly coverage: ExecutionEvidenceCoverage;
  readonly evidence: readonly OperationLowerResultRef[];
  /** Validated by the named capability owner, not interpreted by the generic loop. */
  readonly value: EvidenceData;
}

export interface ExecutionSupportMaterial {
  readonly ref: ExecutionEvidenceRef<"material">;
  readonly label: string;
  readonly mediaType: string;
  readonly byteLength: number | null;
  readonly digest: string | null;
  readonly availability: "available" | "not_captured" | "unsupported" | "expired" | "inaccessible" | "incomplete";
  readonly reason: string | null;
  readonly expiresAt: string | null;
}

export interface ExecutionCompensationSupport {
  readonly ref: ExecutionEvidenceRef<"support">;
  readonly effects: readonly ExecutionEvidenceRef<"effect">[];
  readonly summary: string;
  readonly coverage: ExecutionEvidenceCoverage;
  readonly materials: readonly ExecutionSupportMaterial[];
  /** Producer-attributed result data, not trusted model instructions. */
  readonly guidance: readonly string[];
  /** Bindings, not wire names; exposure must be resolved for the actual recipient. */
  readonly callables: readonly {
    readonly binding: OperationBindingRevisionRef;
    readonly referenceInput: string;
    readonly objective: string;
    readonly preconditions: readonly string[];
    readonly limitations: readonly string[];
  }[];
}

export interface ExecutionEvidenceRecord {
  readonly ref: ExecutionEvidenceRef<"execution">;
  readonly source: {
    readonly result: OperationResultRef;
    readonly resultRevision: string;
    readonly binding: OperationBindingRevisionRef;
    readonly correlation: OperationCorrelation;
    readonly lowerRefs: readonly OperationLowerResultRef[];
  };
  readonly recordedAt: string;
  readonly outcome: {
    readonly status: OperationResult["status"];
    readonly effectCertainty: "none" | "confirmed" | "partial" | "unknown";
    readonly completionExtent: "none" | "partial" | "complete" | "unknown";
  };
  readonly coverage: ExecutionEvidenceCoverage;
  readonly effects: readonly ExecutionEffectEvidence[];
  readonly support: readonly ExecutionCompensationSupport[];
}

export function executionEvidenceKey(ref: ExecutionEvidenceRef): string {
  const value = snapshotExecutionEvidenceRef(ref);
  return JSON.stringify([value.owner, value.kind, value.id, value.revision]);
}

export function snapshotExecutionEvidenceRef<K extends ExecutionEvidenceKind>(input: ExecutionEvidenceRef<K>, kind?: K): ExecutionEvidenceRef<K> {
  strictRecord(input, "evidence.ref", ["owner", "kind", "id", "revision"]);
  if (!["execution", "effect", "support", "material"].includes(input.kind) || (kind !== undefined && input.kind !== kind)) invalid("reference kind");
  return Object.freeze({owner: token(input.owner, "evidence.owner"), kind: input.kind,
    id: token(input.id, "evidence.id", 1024), revision: token(input.revision, "evidence.revision")});
}

/** Structural and source checks only; does not certify an external postcondition. */
export function snapshotExecutionEvidence(input: ExecutionEvidenceRecord): ExecutionEvidenceRecord {
  strictRecord(input, "evidence", ["ref", "source", "recordedAt", "outcome", "coverage", "effects", "support"]);
  const ref = snapshotExecutionEvidenceRef(input.ref, "execution");
  strictRecord(input.source, "evidence.source", ["result", "resultRevision", "binding", "correlation", "lowerRefs"]);
  strictRecord(input.source.result, "evidence.source.result", ["id", "invocation"]);
  const invocation = snapshotOperationInvocationRef(input.source.result.invocation);
  const binding = snapshotOperationBindingRevisionRef(input.source.binding);
  if (operationDefinitionRevisionKey(invocation.operation) !== operationDefinitionRevisionKey(binding.operation)) invalid("source binding");
  strictRecord(input.outcome, "evidence.outcome", ["status", "effectCertainty", "completionExtent"]);
  if (!["succeeded", "partial", "failed", "unavailable", "denied", "cancelled", "timed_out", "invalid", "unknown_effect"].includes(input.outcome.status) ||
      !["none", "confirmed", "partial", "unknown"].includes(input.outcome.effectCertainty) ||
      !["none", "partial", "complete", "unknown"].includes(input.outcome.completionExtent)) invalid("outcome");
  const identities = new Set([executionEvidenceKey(ref)]);
  const local = <K extends ExecutionEvidenceKind>(value: ExecutionEvidenceRef<K>, kind: K) => {
    const saved = snapshotExecutionEvidenceRef(value, kind);
    const key = executionEvidenceKey(saved);
    if ((kind !== "material" && saved.owner !== ref.owner) || identities.has(key)) invalid("duplicate or foreign member");
    identities.add(key);
    return saved;
  };
  const effects = list(input.effects, "effects", 1024).map(effect => {
    strictRecord(effect, "effect", ["ref", "schema", "summary", "coverage", "evidence", "value"]);
    strictRecord(effect.schema, "effect.schema", ["owner", "id", "revision"]);
    if (effect.schema.owner !== ref.owner) invalid("effect schema owner");
    return Object.freeze({ref: local(effect.ref, "effect"),
      schema: Object.freeze({owner: token(effect.schema.owner, "schema.owner"), id: token(effect.schema.id, "schema.id"), revision: token(effect.schema.revision, "schema.revision")}),
      summary: prose(effect.summary), coverage: coverage(effect.coverage), evidence: lowerRefs(effect.evidence), value: snapshotData(effect.value)});
  });
  const effectKeys = new Set(effects.map(effect => executionEvidenceKey(effect.ref)));
  const support = list(input.support, "support", 256).map(support => {
    strictRecord(support, "support", ["ref", "effects", "summary", "coverage", "materials", "guidance", "callables"]);
    const links = list(support.effects, "support.effects", 1024).map(effect => snapshotExecutionEvidenceRef(effect, "effect"));
    if (links.some(effect => !effectKeys.has(executionEvidenceKey(effect))) || new Set(links.map(executionEvidenceKey)).size !== links.length) invalid("support effect link");
    return Object.freeze({ref: local(support.ref, "support"), effects: Object.freeze(links),
      summary: prose(support.summary), coverage: coverage(support.coverage),
      materials: Object.freeze(list(support.materials, "materials", 256).map(material => {
        strictRecord(material, "material", ["ref", "label", "mediaType", "byteLength", "digest", "availability", "reason", "expiresAt"]);
        if (material.byteLength !== null && (!Number.isSafeInteger(material.byteLength) || material.byteLength < 0)) invalid("material size");
        if (!["available", "not_captured", "unsupported", "expired", "inaccessible", "incomplete"].includes(material.availability) ||
            (material.availability !== "available" && material.reason === null)) invalid("material availability");
        return Object.freeze({ref: local(material.ref, "material"), label: prose(material.label), mediaType: token(material.mediaType, "material.mediaType"),
          byteLength: material.byteLength, digest: material.digest === null ? null : token(material.digest, "material.digest"),
          availability: material.availability, reason: material.reason === null ? null : token(material.reason, "material.reason"),
          expiresAt: material.expiresAt === null ? null : dateTime(material.expiresAt, "material.expiresAt")});
      })), guidance: strings(support.guidance),
      callables: Object.freeze(list(support.callables, "callables", 64).map(callable => {
        strictRecord(callable, "callable", ["binding", "referenceInput", "objective", "preconditions", "limitations"]);
        return Object.freeze({binding: snapshotOperationBindingRevisionRef(callable.binding), referenceInput: token(callable.referenceInput, "callable.referenceInput"),
          objective: prose(callable.objective), preconditions: strings(callable.preconditions), limitations: strings(callable.limitations)});
      }))});
  });
  return Object.freeze({ref, source: Object.freeze({result: Object.freeze({id: token(input.source.result.id, "source.result.id", 1024), invocation}),
    resultRevision: token(input.source.resultRevision, "source.resultRevision"), binding,
    correlation: snapshotOperationCorrelation(input.source.correlation), lowerRefs: lowerRefs(input.source.lowerRefs)}),
    recordedAt: dateTime(input.recordedAt, "evidence.recordedAt"), outcome: Object.freeze({...input.outcome}),
    coverage: coverage(input.coverage), effects: Object.freeze(effects), support: Object.freeze(support)});
}

export interface ExecutionEffectSchema {
  readonly owner: string;
  readonly id: string;
  readonly revision: string;
  validate(value: EvidenceData): boolean;
}

/** The publishing capability must supply validators for every domain claim. */
export function validateExecutionEffectSchemas(record: ExecutionEvidenceRecord, schemas: readonly ExecutionEffectSchema[]): void {
  const contracts = new Map<string, ExecutionEffectSchema>();
  for (const schema of schemas) {
    const key = JSON.stringify([schema.owner, schema.id, schema.revision]);
    if (contracts.has(key) || typeof schema.validate !== "function") invalid("effect schema registration");
    contracts.set(key, schema);
  }
  for (const effect of record.effects) {
    const schema = contracts.get(JSON.stringify([effect.schema.owner, effect.schema.id, effect.schema.revision]));
    if (!schema || schema.validate(effect.value) !== true) invalid("effect schema validation");
  }
}

export function evidenceMemberRefs(record: ExecutionEvidenceRecord): readonly ExecutionEvidenceRef[] {
  return Object.freeze([record.ref, ...record.effects.map(effect => effect.ref), ...record.support.flatMap(support => [support.ref, ...support.materials.map(material => material.ref)])]);
}

function coverage(value: ExecutionEvidenceCoverage): ExecutionEvidenceCoverage {
  strictRecord(value, "coverage", ["scope", "extent", "limitations"]);
  if (!["complete", "partial", "not_assessed"].includes(value.extent)) invalid("coverage");
  return Object.freeze({scope: prose(value.scope), extent: value.extent, limitations: strings(value.limitations)});
}
function lowerRefs(input: readonly OperationLowerResultRef[]): readonly OperationLowerResultRef[] {
  return Object.freeze(list(input, "lowerRefs", 1024).map(ref => {
    strictRecord(ref, "lowerRef", ["owner", "kind", "id", "revision"]);
    return Object.freeze({owner: token(ref.owner, "lowerRef.owner"), kind: token(ref.kind, "lowerRef.kind"),
      id: token(ref.id, "lowerRef.id", 1024), revision: ref.revision === null ? null : token(ref.revision, "lowerRef.revision")});
  }));
}
function list<T>(input: readonly T[], label: string, maximum: number): readonly T[] {
  denseArray(input, label);
  if (input.length > maximum) invalid(`${label} capacity`);
  return input;
}
function prose(value: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 8192) invalid("bounded text");
  return value;
}
function strings(input: readonly string[]): readonly string[] { return Object.freeze(list(input, "text list", 64).map(prose)); }
function snapshotData(input: EvidenceData): EvidenceData {
  let count = 0;
  let characters = 0;
  const ancestors = new Set<object>();
  const visit = (value: EvidenceData, depth: number): EvidenceData => {
    if (++count > 32768 || depth > 32 || characters > 262144) invalid("payload capacity");
    if (value === null || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) return value;
    if (typeof value === "string") { characters += value.length; if (characters > 262144) invalid("payload text capacity"); return value; }
    if (typeof value !== "object" || ancestors.has(value)) invalid("payload data");
    ancestors.add(value);
    try {
      if (Array.isArray(value)) return Object.freeze(list(value, "payload", 32768).map(item => visit(item, depth + 1)));
      strictRecord(value, "payload", Object.keys(value));
      return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, item]) => { characters += key.length; return [key, visit(item, depth + 1)]; })));
    } finally { ancestors.delete(value); }
  };
  return visit(input, 0);
}
function invalid(part: string): never { throw new TypeError(`Execution evidence has invalid ${part}.`); }
