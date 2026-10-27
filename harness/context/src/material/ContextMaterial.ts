import { createHash } from "node:crypto";

export const CONTEXT_MATERIAL_LIMITS = Object.freeze({revision: "context-material-access.v2",
  pageBytes: 16_384, scanBytes: 262_144, searchBytes: 8_388_608, searchMs: 1_000, matches: 16, queryBytes: 1_024, descriptions: 64, references: 16});
export interface ContextMaterialRef { readonly id: string; readonly revision: string; }
export interface ContextMaterialDescription {
  readonly reference: ContextMaterialRef;
  readonly originRunId: string;
  readonly source: {readonly owner: string; readonly kind: string; readonly id: string; readonly revision: string | null};
  readonly label: string;
  readonly role: "user" | "assistant" | "tool" | "data";
  readonly position: number;
  readonly bytes: number;
  readonly format: "text" | "json";
  readonly relationships: readonly {readonly kind: string; readonly id: string}[];
  readonly limitations: readonly string[];
}
export interface ContextMaterialDocument { readonly description: ContextMaterialDescription; readonly text: string; }
export interface ContextMaterialRead {
  readonly reference: ContextMaterialRef; readonly offset?: number; readonly length?: number;
}
export interface ContextMaterialSearch {
  readonly query?: string; readonly in?: "content" | "description";
  readonly limit?: number; readonly cursor?: string;
  readonly references?: readonly ContextMaterialRef[];
}
export interface ContextMaterialPage {
  readonly description: ContextMaterialDescription; readonly text: string;
  readonly byteStart: number; readonly byteEnd: number; readonly nextOffset: number | null;
  readonly complete: boolean; readonly coordinate: "utf8_view_bytes";
}
export interface ContextMaterialSearchPage {
  readonly matches: readonly {readonly description: ContextMaterialDescription; readonly excerpt: string;
    readonly byteStart: number; readonly byteEnd: number}[];
  readonly nextCursor: string | null; readonly exhausted: boolean;
  readonly scannedBytes: number; readonly scannedDescriptions: number;
  readonly frontier: number; readonly limitations: readonly string[];
  readonly stopReason?: "scope_exhausted" | "result_limit" | "execution_budget";
}
export interface ContextMaterialAccessPort {
  read(runId: string, input: ContextMaterialRead, signal: AbortSignal, invocationId: string): Promise<ContextMaterialPage>;
  search(runId: string, input: ContextMaterialSearch, signal: AbortSignal, invocationId: string, deadlineAt?: string): Promise<ContextMaterialSearchPage>;
  validate(runId: string, references: readonly ContextMaterialRef[]): Promise<void>;
}
export class ContextMaterialError extends Error {
  constructor(readonly code: string, message: string) {super(message); this.name = "ContextMaterialError";}
}
export function snapshotContextMaterialRef(input: unknown): ContextMaterialRef {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(key => key !== "id" && key !== "revision")) {
    throw new ContextMaterialError("context_reference_invalid", "Copy an exact material reference returned by ContextMaterialSearch or a material handoff.");
  }
  const value = input as Record<string, unknown>;
  if (typeof value.id !== "string" || !value.id.length || value.id.length > 1024 ||
      typeof value.revision !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value.revision)) {
    throw new ContextMaterialError("context_reference_invalid", "A retained material needs its exact id and sha256 revision.");
  }
  return Object.freeze({id: value.id, revision: value.revision});
}
export function snapshotContextMaterialRefs(input: unknown): readonly ContextMaterialRef[] {
  if (!Array.isArray(input) || input.length > CONTEXT_MATERIAL_LIMITS.references) {
    throw new ContextMaterialError("context_references_invalid", "Supply at most 16 exact material references.");
  }
  const values = input.map(snapshotContextMaterialRef);
  if (new Set(values.map(value => value.id)).size !== values.length) throw new ContextMaterialError("context_references_invalid", "Do not repeat a material reference.");
  return Object.freeze(values);
}
export function contextMaterialDigest(text: string): string {return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;}
/** Coordinates belong to the retained UTF-8 view, not the original file encoding. */
export function readContextMaterialText(document: ContextMaterialDocument, offset = 0, length = CONTEXT_MATERIAL_LIMITS.pageBytes): ContextMaterialPage {
  const body = Buffer.from(document.text, "utf8");
  if (contextMaterialDigest(document.text) !== document.description.reference.revision || body.length !== document.description.bytes) {
    throw new ContextMaterialError("context_material_integrity_failed", "Retained material content does not match its immutable version.");
  }
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > body.length || !Number.isSafeInteger(length) || length < 4 || length > CONTEXT_MATERIAL_LIMITS.pageBytes ||
      offset < body.length && (body[offset]! & 0xc0) === 0x80) {
    throw new ContextMaterialError("context_range_invalid", "Use a returned nextOffset, or a UTF-8 boundary; length must be 4-16384 bytes.");
  }
  let end = Math.min(body.length, offset + length);
  while (end < body.length && (body[end]! & 0xc0) === 0x80) end--;
  return Object.freeze({description: document.description, text: body.subarray(offset, end).toString("utf8"), byteStart: offset,
    byteEnd: end, nextOffset: end < body.length ? end : null, complete: offset === 0 && end === body.length, coordinate: "utf8_view_bytes"});
}
