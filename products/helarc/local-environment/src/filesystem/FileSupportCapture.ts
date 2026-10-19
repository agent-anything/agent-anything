import { lstat, realpath, type FileHandle } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import type { FileBaseline, ActionAttemptRef } from "@agent-anything/canonical-action/subject";
import { snapshotOperationInvocationRef, type OperationInvocationRef } from "@agent-anything/operation-catalog/identity";
import type { ExecutionSupportMaterial } from "@agent-anything/operation-catalog/evidence";
import { OperationCommitError } from "@agent-anything/operation-catalog/result";
import { FILE_MATERIAL_POLICY, type FileMaterialRecordPort } from "./FileMaterial.js";
import { captureFilePreimage } from "./FilePreimageCapture.js";
import { FileSystemError } from "./FileSystemError.js";

export interface FileSupportServices {
  readonly records: FileMaterialRecordPort;
  /** Current owner authority, not a historical grant or a model-provided path claim. */
  authorizeRead(input: {readonly runId: string; readonly path: string}): Promise<string | null>;
}
export interface FileSupportOrigin {
  readonly runId: string;
  readonly invocation: OperationInvocationRef;
  readonly preparedAt: string;
  readonly rootIdentity: string;
  readonly ancestryIdentity: string | null;
}

export function snapshotFileSupportOrigin(value: unknown): FileSupportOrigin | null {
  if (value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Invalid file support origin.");
  const input = value as Record<string, unknown>;
  if (Object.keys(input).length !== 5 || ["runId", "preparedAt", "rootIdentity"].some(key => typeof input[key] !== "string" || !input[key]) ||
      input.ancestryIdentity !== null && (typeof input.ancestryIdentity !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(input.ancestryIdentity)) ||
      !Number.isFinite(Date.parse(input.preparedAt as string))) throw new TypeError("Invalid file support origin.");
  return {runId: input.runId as string, preparedAt: input.preparedAt as string, rootIdentity: input.rootIdentity as string,
    ancestryIdentity: input.ancestryIdentity as string | null, invocation: snapshotOperationInvocationRef(input.invocation as OperationInvocationRef)};
}

/** Retained preparation remains queryable even when mutation settlement is uncertain. */
export async function retainedFileFailureSupport(services: FileSupportServices | undefined,
  attempts: readonly ActionAttemptRef[], invocation: OperationInvocationRef): Promise<unknown | null> {
  if (!services) return null;
  try {
    for (const attempt of [...attempts].reverse()) {
      const ref = {owner: "helarc-files", kind: "material" as const, id: `${attempt.id}:preimage`, revision: "1"};
      const saved = await services.records.readFileMaterialRecord(ref);
      if (!saved) continue;
      if (saved.preparation.invocation.id !== invocation.id) throw new TypeError("Retained material invocation mismatch.");
      return {file_support: {after: null, material: {ref, label: "Retained pre-effect file content or absence",
        mediaType: "application/octet-stream", byteLength: saved.preparation.byteLength, digest: saved.digest,
        availability: saved.state === "available" ? "available" : saved.state === "staging" ? "incomplete" : saved.state === "expired" ? "expired" : "not_captured",
        reason: saved.state === "available" ? null : saved.reason ?? "capture_incomplete", expiresAt: saved.expiresAt}}};
    }
    return null;
  } catch (cause) {throw new OperationCommitError("helarc-files", invocation.id, {cause});}
}

/** Capture only after dispatch authorization, inside the shared file mutation claim. */
export async function retainFileSupport(input: {readonly services?: FileSupportServices; readonly origin: FileSupportOrigin;
  readonly root: string; readonly path: string; readonly before: FileBaseline; readonly byteLength: number;
  readonly attempt: ActionAttemptRef; readonly handle: FileHandle | null; readonly signal: AbortSignal; readonly now: () => string;
}): Promise<ExecutionSupportMaterial> {
  const ref = {owner: "helarc-files", kind: "material" as const, id: `${input.attempt.id}:preimage`, revision: "1"};
  const unavailable = (reason: string): ExecutionSupportMaterial => ({ref, label: "Prior file content or absence", mediaType: "application/octet-stream",
    byteLength: input.byteLength, digest: null, availability: "not_captured", reason, expiresAt: null});
  if (!input.services) return unavailable("file_material_store_unavailable");
  if (input.origin.ancestryIdentity === null) return unavailable("file_support_ancestry_unsupported");
  const ancestry = await fileAncestryIdentity(input.root, input.path);
  if (ancestry !== input.origin.ancestryIdentity) throw new FileSystemError("file_target_changed", "File ancestry changed before capture.");
  let authority: string | null;
  try {authority = await input.services.authorizeRead({runId: input.origin.runId, path: input.path});}
  catch (cause) {throw new OperationCommitError("helarc-files", ref.id, {cause});}
  if (authority === null) return unavailable("file_material_read_not_authorized");
  try {
    const captured = await captureFilePreimage({handle: input.handle, records: input.services.records, interruption: input.signal, now: input.now,
      preparation: {ref, policyRevision: FILE_MATERIAL_POLICY.revision, runId: input.origin.runId, invocation: input.origin.invocation,
        attempt: {id: input.attempt.id, action: {id: input.attempt.action.id}, ordinal: input.attempt.ordinal},
        target: {canonicalPath: input.path, rootIdentity: input.origin.rootIdentity, ancestryIdentity: ancestry},
        before: input.before, byteLength: input.byteLength, readAuthorityRef: authority, preparedAt: input.origin.preparedAt}});
    if (await fileAncestryIdentity(input.root, input.path) !== ancestry) throw new FileSystemError("file_target_changed", "File ancestry changed while retaining its prior content.");
    if (captured.status === "unavailable") return unavailable(captured.reason);
    return {ref, label: input.before.kind === "absent" ? "Prior absence" : "Prior file content", mediaType: "application/octet-stream",
      byteLength: captured.material.preparation.byteLength, digest: captured.material.digest, availability: "available", reason: null,
      expiresAt: captured.material.expiresAt};
  } catch (cause) {
    if (cause instanceof FileSystemError || cause instanceof OperationCommitError) throw cause;
    throw new OperationCommitError("helarc-files", ref.id, {cause});
  }
}

/** Object identities for every existing ancestor; rejects symlinks and paths outside the root. */
export async function fileAncestryIdentity(root: string, path: string): Promise<string> {
  const base = resolve(root), parent = resolve(dirname(path));
  const rel = relative(base, parent);
  if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`) || resolve(base, rel) !== parent) throw new FileSystemError("file_support_ancestry_unsupported", "Unsupported file ancestry.");
  const ancestors = [base];
  if (rel) for (const part of rel.split(sep)) ancestors.push(resolve(ancestors.at(-1)!, part));
  const entries = [];
  for (const ancestor of ancestors) {
    let stats, canonical;
    try {stats = await lstat(ancestor); canonical = await realpath(ancestor);} catch (cause) {
      if (["ENOENT", "ENOTDIR", "EACCES", "EPERM"].includes((cause as NodeJS.ErrnoException).code ?? "")) {
        throw new FileSystemError("file_support_ancestry_unsupported", "File support requires readable existing directory ancestry.");
      }
      throw cause;
    }
    if (!stats.isDirectory() || stats.isSymbolicLink() || (process.platform === "win32" ? canonical.toLowerCase() !== ancestor.toLowerCase() : canonical !== ancestor)) {
      throw new FileSystemError("file_support_ancestry_unsupported", "Direct file restoration requires regular, unchanged directory ancestry.");
    }
    entries.push([ancestor, String(stats.dev), String(stats.ino)]);
  }
  return `sha256:${createHash("sha256").update(JSON.stringify(entries)).digest("hex")}`;
}
