import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { lstat, open, unlink, type FileHandle } from "node:fs/promises";
import { createFileBaseline, type FileBaseline } from "@agent-anything/canonical-action/subject";
import { executionEvidenceKey } from "@agent-anything/operation-catalog/evidence";
import { OperationCommitError } from "@agent-anything/operation-catalog/result";
import { FILE_MATERIAL_POLICY, snapshotFileMaterialPreparation, type FileMaterialPreparation,
  type FileMaterialRecordPort } from "./FileMaterial.js";
import { inspectFileContent, inspectFileHandleContent } from "./FileContentDigest.js";
import { writeBoundFileContent } from "./FileContentMutation.js";
import { hostFileMutationClaims } from "./FileMutationClaims.js";
import { assertFileHandlePath, matchesFileBaselineIdentity } from "./FilePreimageCapture.js";
import { FileSystemError } from "./FileSystemError.js";

export interface FileContentRestorationInput {
  /** Resolved from the original file owner's receipt, never a model path override. */
  readonly material: FileMaterialPreparation;
  readonly after: FileBaseline;
  readonly runId: string;
  readonly records: Pick<FileMaterialRecordPort, "readFileMaterialRecord" | "readFileMaterialRange" | "pinFileMaterial">;
  readonly signal: AbortSignal;
  /** Current capability checks for the exact root, ancestry and target. Throws on mismatch. */
  readonly revalidateTarget: () => Promise<void>;
  readonly markEffectStarted: () => void;
  readonly retainPreimage?: (handle: FileHandle | null) => Promise<void>;
}

export type FileContentRestorationResult =
  | {readonly kind: "content"; readonly digest: string; readonly byteLength: number; readonly after: FileBaseline}
  | {readonly kind: "absence"};

/** File-owner primitive. The caller admits current read/mutation authority and durable dispatch first. */
export async function restoreBoundFileContent(input: FileContentRestorationInput): Promise<FileContentRestorationResult> {
  const material = snapshotFileMaterialPreparation(input.material);
  const after = createFileBaseline(input.after);
  if ((after.kind === "present" && after.entryKind !== "file") || (after.kind === "absent" && material.before.kind === "absent") || material.byteLength > FILE_MATERIAL_POLICY.maxFileBytes ||
      !input.runId.trim() || input.runId.length > 4096 || input.runId.includes("\0")) {
    throw new FileSystemError("file_restore_input_invalid", "Restoration requires a retained bounded preimage and a confirmed file or absence post-state.");
  }
  interrupted(input.signal);
  const initial = await stored(() => input.records.readFileMaterialRecord(material.ref));
  if (!initial || !isDeepStrictEqual(initial.preparation, material)) unavailable();
  if (initial.state !== "available" || initial.digest === null) unavailable();
  await stored(() => input.records.pinFileMaterial(material.ref, input.runId));
  // Pin acknowledgement, not a historical availability flag, protects these reads from expiry.
  const retained = await stored(() => input.records.readFileMaterialRecord(material.ref));
  if (!retained || retained.state !== "available" || !isDeepStrictEqual(retained.preparation, material) ||
      retained.digest !== initial.digest || !retained.pins.includes(input.runId)) unavailable();
  const content = material.before.kind === "absent" ? null : Buffer.alloc(material.byteLength);
  let offset = 0;
  while (content !== null && offset < content.length) {
    interrupted(input.signal);
    const length = Math.min(FILE_MATERIAL_POLICY.readBytes, content.length - offset);
    const page = await stored(() => input.records.readFileMaterialRange(material.ref, offset, length));
    if (typeof page.base64 !== "string" || page.base64.length > Math.ceil(length / 3) * 4) corrupt();
    const bytes = Buffer.from(page.base64, "base64");
    if (executionEvidenceKey(page.reference) !== executionEvidenceKey(material.ref) || page.offset !== offset ||
        page.totalBytes !== material.byteLength || page.digest !== retained.digest || page.byteLength !== length ||
        bytes.length !== length || bytes.toString("base64") !== page.base64) corrupt();
    bytes.copy(content, offset); offset += length;
  }
  const digest = `sha256:${createHash("sha256").update(content ?? Buffer.alloc(0)).digest("hex")}`;
  if (digest !== retained.digest || material.before.kind === "present" && digest !== material.before.contentDigest) corrupt();
  return hostFileMutationClaims.execute(material.target.canonicalPath, after, async () => {
    interrupted(input.signal);
    await input.revalidateTarget();
    const retainPreimage = async (handle: FileHandle | null) => {
      if (handle !== null && (await handle.stat()).nlink !== 1) {
        throw new FileSystemError("file_target_changed", "Direct restoration does not support multiply linked files.");
      }
      await input.retainPreimage?.(handle);
      await input.revalidateTarget();
      if (handle !== null && (await handle.stat()).nlink !== 1) {
        throw new FileSystemError("file_target_changed", "The target gained another link while its preimage was retained.");
      }
    };
    if (content !== null) {
      const result = await writeBoundFileContent({path: material.target.canonicalPath, before: after, content,
        signal: input.signal, markEffectStarted: input.markEffectStarted, retainPreimage});
      const observed = await inspectFileContent(material.target.canonicalPath);
      if (observed.digest !== result.digest || observed.byteLength !== result.byteLength) {
        throw new FileSystemError("file_target_changed", "Restored content changed before its post-state was recorded.");
      }
      const observedAfter = createFileBaseline({kind: "present", entryKind: "file", contentDigest: observed.digest,
        objectIdentity: process.platform === "win32" ? {kind: "win32", volumeId: String(observed.stats.dev), fileId: String(observed.stats.ino)} :
          {kind: "posix", deviceId: String(observed.stats.dev), inode: String(observed.stats.ino)}});
      return {kind: "content", digest: result.digest, byteLength: result.byteLength, after: observedAfter};
    }
    if (after.kind !== "present") throw new FileSystemError("file_restore_input_invalid", "Removal requires a confirmed present file.");
    return removeCreatedFile({...input, material, after, retainPreimage});
  });

  async function stored<T>(request: () => Promise<T>): Promise<T> {
    try {return await request();} catch (cause) {
      if (cause instanceof OperationCommitError) throw cause;
      if (cause && typeof cause === "object" && "code" in cause && cause.code === "file_material_content_unavailable") unavailable();
      throw new OperationCommitError("helarc-files", material.ref.id, {cause});
    }
  }
}

async function removeCreatedFile(input: FileContentRestorationInput & {readonly after: Extract<FileBaseline, {kind: "present"}>}): Promise<FileContentRestorationResult> {
  const path = input.material.target.canonicalPath;
  const handle = await open(path, "r+");
  try {
    const check = async () => {
      const actual = await inspectFileHandleContent(handle);
      await assertFileHandlePath(path, actual.stats);
      if (actual.stats.nlink !== 1 || !matchesFileBaselineIdentity(actual.stats, input.after) || actual.digest !== input.after.contentDigest) {
        throw new FileSystemError("file_target_changed", "The created file no longer matches the original change receipt.");
      }
    };
    await check();
    await input.retainPreimage?.(handle);
    await check();
    interrupted(input.signal);
    input.markEffectStarted();
    await unlink(path);
    try {
      await lstat(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {kind: "absence"};
      throw error;
    }
    throw new FileSystemError("file_restore_postcondition_mismatch", "The path is present after removal; an overlapping external change is possible.");
  } finally {await handle.close();}
}

function interrupted(signal: AbortSignal): void {
  if (signal.aborted) throw new FileSystemError("file_action_interrupted", "File restoration was interrupted.");
}
function unavailable(): never {
  throw new FileSystemError("file_material_content_unavailable", "The exact retained file material is not available for this restoration.");
}
function corrupt(): never {
  throw new FileSystemError("file_material_corrupt", "Retained file material does not match its immutable length, identity or digest.");
}
