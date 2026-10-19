import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import { lstat, type FileHandle } from "node:fs/promises";
import type { FileBaseline } from "@agent-anything/canonical-action/subject";
import { FILE_MATERIAL_POLICY, snapshotFileMaterialPreparation, type FileMaterialPreparation, type FileMaterialRecord, type FileMaterialRecordPort } from "./FileMaterial.js";
import { inspectFileHandleContent, sameFileIdentity } from "./FileContentDigest.js";
import { FileSystemError } from "./FileSystemError.js";

export type FilePreimageCapture =
  | {readonly status: "available"; readonly material: FileMaterialRecord}
  | {readonly status: "unavailable"; readonly reason: string};

/** Called under the file owner's target claim, after current read authority and ancestry checks. */
export async function captureFilePreimage(input: {
  readonly preparation: FileMaterialPreparation;
  readonly handle: FileHandle | null;
  readonly records: FileMaterialRecordPort;
  readonly interruption: AbortSignal;
  readonly now: () => string;
}): Promise<FilePreimageCapture> {
  const preparation = snapshotFileMaterialPreparation(input.preparation);
  const {records, handle} = input;
  interrupted(input.interruption);
  const before = handle ? await handle.stat() : null;
  if (preparation.before.kind === "absent") {
    if (handle) changed();
    await assertAbsent(preparation.target.canonicalPath);
  } else {
    if (!handle || !before || !before.isFile() || before.nlink !== 1) return {status: "unavailable", reason: "file_support_target_unsupported"};
    if (!matchesFileBaselineIdentity(before, preparation.before) || before.size !== preparation.byteLength) changed();
    await assertFileHandlePath(preparation.target.canonicalPath, before);
  }
  const reservation = await records.reserveFileMaterial(preparation);
  if (reservation.status === "unavailable") return reservation;
  if (reservation.record.state !== "staging" && reservation.record.state !== "available") {
    return {status: "unavailable", reason: `file_material_${reservation.record.state}`};
  }
  try {
    interrupted(input.interruption);
    if (reservation.record.state === "available") {
      // A retained preimage is not evidence that its target still has those bytes.
      if (handle) {
        const current = await inspectFileHandleContent(handle);
        if (!matchesFileBaselineIdentity(current.stats, preparation.before) || current.stats.nlink !== 1 ||
            current.byteLength !== preparation.byteLength || preparation.before.kind !== "present" ||
            current.digest !== preparation.before.contentDigest) changed();
        await assertFileHandlePath(preparation.target.canonicalPath, current.stats);
      } else await assertAbsent(preparation.target.canonicalPath);
      interrupted(input.interruption);
      return {status: "available", material: reservation.record};
    }
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(FILE_MATERIAL_POLICY.chunkBytes);
    let offset = 0;
    while (offset < preparation.byteLength) {
      interrupted(input.interruption);
      if (!handle) changed();
      const {bytesRead} = await handle.read(buffer, 0, Math.min(buffer.length, preparation.byteLength - offset), offset);
      if (!bytesRead) changed();
      const chunk = buffer.subarray(0, bytesRead);
      hash.update(chunk);
      await records.appendFileMaterial(preparation.ref, offset, chunk.toString("base64"));
      offset += bytesRead;
    }
    interrupted(input.interruption);
    const digest = `sha256:${hash.digest("hex")}`;
    if (handle && before) {
      const after = await handle.stat();
      if (!sameFileIdentity(before, after) || before.size !== after.size || before.mtimeMs !== after.mtimeMs ||
          before.ctimeMs !== after.ctimeMs || after.nlink !== 1 || preparation.before.kind !== "present" || preparation.before.contentDigest !== digest) changed();
      await assertFileHandlePath(preparation.target.canonicalPath, after);
    } else await assertAbsent(preparation.target.canonicalPath);
    const material = await records.publishFileMaterial(preparation.ref, digest, input.now());
    return {status: "available", material};
  } catch (error) {
    // Only owner-confirmed pre-effect invalidation can discard staging. Store failure is not optional capture failure.
    if (error instanceof FileSystemError && reservation.record.state === "staging") {
      await records.abortFileMaterial(preparation.ref, error.code, input.now());
    }
    throw error;
  }
}

export function matchesFileBaselineIdentity(stats: Stats, baseline: FileBaseline): boolean {
  if (baseline.kind !== "present" || !stats.isFile() || baseline.entryKind !== "file") return false;
  const expected = baseline.objectIdentity;
  return expected.kind === "win32" ? String(stats.dev) === expected.volumeId && String(stats.ino) === expected.fileId :
    String(stats.dev) === expected.deviceId && String(stats.ino) === expected.inode;
}

export async function assertFileHandlePath(path: string, expected: Stats): Promise<void> {
  let actual: Stats;
  try {actual = await lstat(path);} catch {return changed();}
  if (actual.isSymbolicLink() || !actual.isFile() || !sameFileIdentity(expected, actual)) changed();
}

async function assertAbsent(path: string): Promise<void> {
  try {await lstat(path);} catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
  changed();
}
function interrupted(signal: AbortSignal): void {if (signal.aborted) throw new FileSystemError("file_action_interrupted", "File material capture was interrupted before mutation.");}
function changed(): never {throw new FileSystemError("file_target_changed", "File changed while its prior content was being retained. No requested mutation was performed.");}
