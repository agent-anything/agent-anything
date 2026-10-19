import { createHash } from "node:crypto";
import { open, type FileHandle } from "node:fs/promises";
import type { FileBaseline } from "@agent-anything/canonical-action/subject";
import { inspectFileHandleContent } from "./FileContentDigest.js";
import { assertFileHandlePath, matchesFileBaselineIdentity } from "./FilePreimageCapture.js";
import { FileSystemError } from "./FileSystemError.js";

/** Caller owns the mutation claim and permission. No pathname reopen between check and write. */
export async function writeBoundFileContent(input: {
  readonly path: string;
  readonly before: FileBaseline;
  readonly content: Uint8Array;
  readonly signal: AbortSignal;
  readonly markEffectStarted: () => void;
  readonly retainPreimage?: (handle: FileHandle | null) => Promise<void>;
}): Promise<{readonly digest: string; readonly byteLength: number}> {
  interrupted(input.signal);
  const creating = input.before.kind === "absent";
  if (creating) {
    await input.retainPreimage?.(null);
    interrupted(input.signal);
  }
  if (creating) input.markEffectStarted();
  const handle = await open(input.path, creating ? "wx+" : "r+");
  try {
    const initial = await inspectFileHandleContent(handle);
    await assertFileHandlePath(input.path, initial.stats);
    if (!creating && (!matchesFileBaselineIdentity(initial.stats, input.before) ||
        input.before.kind !== "present" || initial.digest !== input.before.contentDigest)) {
      throw new FileSystemError("file_target_changed", "File changed before its handle-bound mutation.");
    }
    if (!creating && input.retainPreimage) {
      await input.retainPreimage(handle);
      const checked = await inspectFileHandleContent(handle);
      await assertFileHandlePath(input.path, checked.stats);
      if (checked.digest !== initial.digest) throw new FileSystemError("file_target_changed", "File changed while its prior content was retained.");
    }
    interrupted(input.signal);
    input.markEffectStarted();
    let offset = 0;
    while (offset < input.content.byteLength) {
      interrupted(input.signal);
      const length = Math.min(64 * 1024, input.content.byteLength - offset);
      const {bytesWritten} = await handle.write(input.content, offset, length, offset);
      if (!bytesWritten) throw new FileSystemError("file_write_incomplete", "The file write made no progress; its effect may be partial.");
      offset += bytesWritten;
    }
    interrupted(input.signal);
    await handle.truncate(input.content.byteLength);
    await handle.sync();
    const current = await inspectFileHandleContent(handle);
    await assertFileHandlePath(input.path, current.stats);
    const intendedDigest = `sha256:${createHash("sha256").update(input.content).digest("hex")}`;
    if (current.digest !== intendedDigest || current.byteLength !== input.content.byteLength) {
      throw new FileSystemError("file_write_postcondition_mismatch", "Observed file content does not match the requested write; external overlap or a partial write is possible.");
    }
    return current;
  } finally {await handle.close();}
}
function interrupted(signal: AbortSignal): void {if (signal.aborted) throw new FileSystemError("file_action_interrupted", "File mutation was interrupted.");}
