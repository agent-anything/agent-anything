import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { TextDecoder } from "node:util";
import { sameFileIdentity } from "./FileContentDigest.js";
import { FileSystemError } from "./FileSystemError.js";

export interface FileTextPageRequest {
  readonly path: string;
  readonly offset: number;
  readonly limit: number;
  readonly maxBytes: number;
  readonly maxInspectionBytes: number;
  readonly signal: AbortSignal;
  readonly expectedDigest?: string;
}

/** Inspect/hash the whole bounded file, retaining only complete requested lines. */
export async function readFileTextPage(input: FileTextPageRequest) {
  const handle = await open(input.path, "r");
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new FileSystemError("file_target_changed", "Read requires a regular file.");
    if (before.size > input.maxInspectionBytes) throw new FileSystemError("file_read_inspection_limit_exceeded",
      `File exceeds the ${input.maxInspectionBytes}-byte inspection limit; use a narrower source or another admitted capability.`);
    const hash = createHash("sha256");
    const decoder = new TextDecoder("utf-8", {fatal: true, ignoreBOM: true});
    const buffer = Buffer.allocUnsafe(64 * 1024);
    const selected = Buffer.allocUnsafe(Math.min(before.size, input.maxBytes));
    let pendingBytes = 0;
    let selectedBytes = 0;
    let line = 1;
    let endLine = 0;
    let position = 0;
    let closed = false;
    const capture = (part: Buffer) => {
      if (closed || line < input.offset || line >= input.offset + input.limit) return;
      if (selectedBytes + pendingBytes + part.length > input.maxBytes) {
        if (endLine === 0) throw new FileSystemError("file_read_line_limit_exceeded",
          `The requested line exceeds the ${input.maxBytes}-byte page limit; Read does not split a line. Use another admitted capability for this line.`);
        pendingBytes = 0; closed = true;
        return;
      }
      part.copy(selected, selectedBytes + pendingBytes);
      pendingBytes += part.length;
    };
    const finishLine = () => {
      if (!closed && line >= input.offset && line < input.offset + input.limit) {
        selectedBytes += pendingBytes; endLine = line;
      }
      pendingBytes = 0;
    };
    while (position < before.size) {
      if (input.signal.aborted) throw new FileSystemError("file_action_interrupted", "Read was interrupted.");
      const {bytesRead} = await handle.read(buffer, 0, Math.min(buffer.length, before.size - position), position);
      if (!bytesRead) break;
      const bytes = buffer.subarray(0, bytesRead);
      hash.update(bytes);
      try { decoder.decode(bytes, {stream: true}); }
      catch { throw new FileSystemError("file_content_unsupported", "File is not supported UTF-8 text."); }
      if (bytes.includes(0)) throw new FileSystemError("file_content_unsupported", "File contains binary NUL bytes.");
      let start = 0;
      for (let index = 0; index < bytes.length; index++) {
        if (bytes[index] !== 10) continue;
        capture(bytes.subarray(start, index + 1)); finishLine(); line++; start = index + 1;
      }
      capture(bytes.subarray(start));
      position += bytesRead;
    }
    try { decoder.decode(); }
    catch { throw new FileSystemError("file_content_unsupported", "File ends with incomplete UTF-8 text."); }
    if (position > 0) finishLine();
    const after = await handle.stat();
    const digest = `sha256:${hash.digest("hex")}`;
    if (position !== before.size || !sameFileIdentity(before, after) || before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs ||
        input.expectedDigest !== undefined && input.expectedDigest !== digest) {
      throw new FileSystemError("file_target_changed", "File changed after admission or during Read; read its current version again.");
    }
    if (input.signal.aborted) throw new FileSystemError("file_action_interrupted", "Read was interrupted.");
    const totalLines = position === 0 ? 0 : line;
    return {
      content: selected.subarray(0, selectedBytes).toString("utf8"),
      start_line: Math.min(input.offset, totalLines + 1), end_line: endLine, total_lines: totalLines,
      next_offset: endLine > 0 && endLine < totalLines ? endLine + 1 : null,
      truncated: input.offset > 1 || endLine < totalLines,
      byte_length: position, content_digest: digest,
    };
  } finally { await handle.close(); }
}
