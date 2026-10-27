import { createHash } from "node:crypto";
import { open, type FileHandle } from "node:fs/promises";
import type { Stats } from "node:fs";
import { FileSystemError } from "./FileSystemError.js";

/** Bounded memory and handle-bound identity; not an exclusion lock on other writers. */
export async function inspectFileContent(path: string, options?: {maxBytes: number; signal: AbortSignal}): Promise<{digest: string; byteLength: number; stats: Stats}> {
  const handle = await open(path, "r");
  try {return await inspectFileHandleContent(handle, options);} finally {await handle.close();}
}

export async function inspectFileHandleContent(handle: FileHandle, options?: {maxBytes: number; signal: AbortSignal}): Promise<{digest: string; byteLength: number; stats: Stats}> {
  const before = await handle.stat();
  if (!before.isFile()) throw new FileSystemError("file_target_changed", "Expected a regular file.");
  if (options && before.size > options.maxBytes) throw new FileSystemError("file_inspection_limit_exceeded",
    `File exceeds the ${options.maxBytes}-byte target inspection limit.`);
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let offset = 0;
  // Bound this observation to its opening size; a growing file cannot extend it indefinitely.
  while (offset < before.size) {
    if (options?.signal.aborted) throw new FileSystemError("file_action_interrupted", "File inspection was interrupted.");
    const {bytesRead} = await handle.read(buffer, 0, Math.min(buffer.length, before.size - offset), offset);
    if (bytesRead === 0) break;
    hash.update(buffer.subarray(0, bytesRead));
    offset += bytesRead;
  }
  const after = await handle.stat();
  if (offset !== before.size || !sameFileIdentity(before, after) || before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
    throw new FileSystemError("file_target_changed", "File changed while its content was inspected.");
  }
  return {digest: `sha256:${hash.digest("hex")}`, byteLength: offset, stats: after};
}

export function sameFileIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}
