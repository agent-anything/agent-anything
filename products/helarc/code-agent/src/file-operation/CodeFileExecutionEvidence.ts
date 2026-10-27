import type { OperationResult } from "@agent-anything/operation-catalog/result";
import { operationDefinitionRevisionKey } from "@agent-anything/operation-catalog/identity";
import {
  type EvidenceData,
  type ExecutionEffectEvidence,
  type ExecutionEffectSchema,
  type ExecutionCompensationSupport,
} from "@agent-anything/operation-catalog/evidence";
import { createFileBaseline } from "@agent-anything/canonical-action/subject";
import { snapshotExecutionEvidenceRef } from "@agent-anything/operation-catalog/evidence";
import { bindingRefForCodeFileTool } from "./CodeFileOperation.js";

const OWNER = "helarc.code-agent";
const SCHEMA = Object.freeze({owner: OWNER, id: "file-content-change", revision: "2"});
export const CODE_FILE_RESTORE_OPERATION = Object.freeze({operation: {namespace: "helarc.code-agent.file", name: "restore"}, revision: "1"});
export const CODE_FILE_RESTORE_BINDING = Object.freeze({operation: CODE_FILE_RESTORE_OPERATION, revision: "1"});

export const CODE_FILE_CONTENT_CHANGE_SCHEMA: ExecutionEffectSchema = Object.freeze({
  ...SCHEMA,
  validate(value: EvidenceData): boolean {
    if (!record(value) || !exactKeys(value, ["target_id", "file_path", "operation", "before", "after", ...(value.restoration === undefined ? [] : ["restoration"])]) ||
        !text(value.target_id, 1024) || !text(value.file_path, 4096) ||
        !["created", "replaced", "updated", "restored", "removed"].includes(value.operation as string) ||
        (value.operation === "removed" ? value.after !== null : !baseline(value.after))) return false;
    if (value.after !== null && !baseline(value.after)) return false;
    if (value.operation === "created" && value.before !== null) return false;
    if (value.after !== null && (value.after.target_id !== value.target_id || value.after.file_path !== value.file_path)) return false;
    if (value.restoration !== undefined) {
      if (!record(value.restoration) || !exactKeys(value.restoration, ["material", "after"])) return false;
      try {
        snapshotExecutionEvidenceRef(value.restoration.material as never, "material");
        const after = createFileBaseline(value.restoration.after as never);
        if (value.after === null ? after.kind !== "absent" :
          after.kind !== "present" || after.entryKind !== "file" || after.contentDigest !== value.after.content_digest) return false;
      } catch {return false;}
    }
    return value.before === null ? value.operation === "created" || value.operation === "restored" : baseline(value.before) &&
      value.before.target_id === value.target_id && value.before.file_path === value.file_path;
  },
});

/** A content observation, not retained old bytes or authority to restore the path. */
export function codeFileExecutionEffects(result: OperationResult): readonly ExecutionEffectEvidence[] {
  const tool = fileTool(result);
  if (!tool || result.semanticOwner !== OWNER || result.status !== "succeeded" ||
      result.metadata.effectCertainty !== "confirmed" || result.metadata.completionExtent !== "complete") return [];
  const output = result.output;
  if (!record(output) || (tool === "RestoreFile" ? !["restored", "removed"].includes(output.operation as string) : tool === "Edit" ? output.operation !== "updated" :
      !["created", "replaced"].includes(output.operation as string))) invalid();
  const support = record(output.file_support) && record(output.file_support.material) && output.file_support.material.availability === "available" ? output.file_support : null;
  const value = {target_id: output.target_id, file_path: output.file_path, operation: output.operation,
    before: copyBaseline(output.previous_baseline), after: copyBaseline(output.current_baseline),
    ...(support ? {restoration: {material: (support.material as Record<string, unknown>).ref, after: support.after}} : {})};
  if (!CODE_FILE_CONTENT_CHANGE_SCHEMA.validate(value as EvidenceData)) invalid();
  return Object.freeze([Object.freeze({
    ref: Object.freeze({owner: OWNER, kind: "effect" as const, id: `${result.ref.id}:file-content`, revision: SCHEMA.revision}),
    schema: SCHEMA,
    summary: `Observed ${output.operation} file content: ${output.file_path}`,
    coverage: Object.freeze({scope: "The target file's observed content and existence at settlement", extent: "complete" as const,
      limitations: Object.freeze([
        "This observation does not retain previous file bytes or authorize restoration.",
        "Current content may change after settlement; object identity, ancestry and authority require new checks.",
        "Directory creation, metadata and unrelated external effects are outside this content receipt.",
      ])}),
    evidence: Object.freeze(result.lowerRefs.map(ref => Object.freeze({...ref}))),
    value: Object.freeze(value) as EvidenceData,
  })]);
}

export function codeFileCompensationSupport(result: OperationResult): readonly ExecutionCompensationSupport[] {
  if (result.semanticOwner !== OWNER || !fileTool(result)) return [];
  const effects = codeFileExecutionEffects(result);
  if (!record(result.output) || !record(result.output.file_support) || !record(result.output.file_support.material)) return [];
  const material = result.output.file_support.material;
  const available = material.availability === "available" && effects.length > 0;
  return [{ref: {owner: OWNER, kind: "support", id: `${result.ref.id}:file-restore`, revision: "1"}, effects: effects.map(value => value.ref),
    summary: available ? "Bounded prior file content/existence retained; conditional restoration can be requested." : "Direct restoration is unavailable; ordinary governed editing remains possible.",
    coverage: {scope: "One file's content or prior absence", extent: "partial", limitations: ["Does not restore ACLs, metadata, parent directories, external consumers or arbitrary Shell effects.",
      "Serializes participating Host file mutations, not external writers. New authority and exact current identity/content checks are required."]},
    materials: [material as unknown as ExecutionCompensationSupport["materials"][number]],
    guidance: effects.length ? ["Use the exact file effect reference as change_ref. A conflict must be investigated; there is no force mode."] :
      ["Retained bytes prove preparation only. Inspect the current target and retained material before deciding further work; no confirmed post-state is available."],
    callables: available ? [{binding: CODE_FILE_RESTORE_BINDING, referenceInput: "change_ref", objective: "Restore captured prior file content or remove the same newly created file.",
      preconditions: ["Current read and mutation authority", "Retained material and unchanged root, ancestry, file identity and post-state"],
      limitations: ["No whole-workspace, directory or metadata restoration; external writers are not excluded."]}] : []}];
}

function fileTool(result: OperationResult) {
  return (["Edit", "Write", "RestoreFile"] as const).find(name => {
    const binding = name === "RestoreFile" ? CODE_FILE_RESTORE_BINDING : bindingRefForCodeFileTool(name);
    return operationDefinitionRevisionKey(binding.operation) === operationDefinitionRevisionKey(result.ref.invocation.operation) &&
      operationDefinitionRevisionKey(binding.operation) === operationDefinitionRevisionKey(result.binding.operation) && binding.revision === result.binding.revision;
  });
}

function copyBaseline(value: unknown) {
  if (value === null) return null;
  if (!record(value)) invalid();
  return Object.freeze({target_id: value.target_id, file_path: value.file_path,
    byte_length: value.byte_length, content_digest: value.content_digest});
}
function baseline(value: unknown): value is Record<string, unknown> {
  return record(value) && exactKeys(value, ["target_id", "file_path", "byte_length", "content_digest"]) &&
    text(value.target_id, 1024) && text(value.file_path, 4096) && Number.isSafeInteger(value.byte_length) &&
    (value.byte_length as number) >= 0 && typeof value.content_digest === "string" && /^sha256:[a-f0-9]{64}$/u.test(value.content_digest);
}
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function exactKeys(value: Record<string, unknown>, keys: readonly string[]) {return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));}
function text(value: unknown, max: number): value is string {return typeof value === "string" && value.length > 0 && value.length <= max;}
function invalid(): never {throw new TypeError("File content evidence requires matching, validated before/after observations.");}
