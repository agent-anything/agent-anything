import { open, rm, type FileHandle } from "node:fs/promises";
import { TextDecoder } from "node:util";
import type { ProcessStream } from "./ProcessBackend.js";
import type { ProcessOutputSlice } from "./ProcessObservation.js";
import { projectProcessOutputText, type ProcessTextProjection } from "./ProcessOutputText.js";

const SEGMENT_BYTES = 4096;
const MAX_SEGMENTS = 4096;
interface Segment { byteStart: number; byteEnd: number; decoderInputStart: number; text: string; }
interface StreamState {
  received: number; retained: number; projected: number; omitted: number;
  pending: Buffer; segments: Segment[]; projection: ProcessTextProjection | null;
  decoder: TextDecoder | null; strictDecoder: TextDecoder | null;
  decoderTail: Buffer; decoderPending: boolean;
  raw: FileHandle; text: FileHandle; textBytes: number;
}

export interface ProcessOutputPaths {
  readonly stdout: string; readonly stderr: string;
  readonly stdoutText: string; readonly stderrText: string; readonly manifest: string;
}

/** Owns bounded capture independently of process observations and consumers. */
export class ProcessOutputStore {
  private used = 0;
  private writeQueue: Promise<void> = Promise.resolve();
  private closePromise: Promise<void> | null = null;
  private failure: string | null = null;
  private closed = false;
  private readonly generation = 1;

  private constructor(
    readonly executionId: string,
    readonly paths: ProcessOutputPaths,
    readonly maximumBytes: number,
    private readonly streams: Record<ProcessStream, StreamState>,
    private readonly manifest: FileHandle,
  ) {}

  static async create(executionId: string, paths: ProcessOutputPaths, maximumBytes: number): Promise<ProcessOutputStore> {
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) throw new TypeError("Invalid process output limit.");
    const handles: FileHandle[] = [];
    const created: string[] = [];
    try {
      for (const path of [paths.stdout, paths.stderr, paths.stdoutText, paths.stderrText, paths.manifest]) {
        handles.push(await open(path, "wx", 0o600));
        created.push(path);
      }
      const state = (raw: FileHandle, text: FileHandle): StreamState => ({ received: 0, retained: 0, projected: 0,
        omitted: 0, pending: Buffer.alloc(0), segments: [], projection: null, decoder: null, strictDecoder: null,
        decoderTail: Buffer.alloc(0), decoderPending: false, raw, text, textBytes: 0 });
      return new ProcessOutputStore(executionId, paths, maximumBytes, {
        stdout: state(handles[0]!, handles[2]!), stderr: state(handles[1]!, handles[3]!),
      }, handles[4]!);
    } catch (error) {
      await Promise.all(handles.map((handle) => handle.close().catch(() => {})));
      for (const path of created) await rm(path, { force: true });
      throw error;
    }
  }

  append(stream: ProcessStream, input: Uint8Array): void {
    if (this.closed) return;
    const state = this.streams[stream];
    state.received += input.byteLength;
    const accepted = Math.min(input.byteLength, this.maximumBytes - this.used);
    state.omitted += input.byteLength - accepted;
    if (accepted === 0) return;
    const bytes = Buffer.from(input.subarray(0, accepted));
    this.used += accepted;
    state.retained += accepted;
    this.enqueue(async () => { await writeAll(state.raw, bytes); });
    state.pending = Buffer.concat([state.pending, bytes]);
    while (state.pending.length >= SEGMENT_BYTES) this.project(stream, SEGMENT_BYTES, false);
  }

  get status() {
    return Object.freeze({ retainedBytes: this.used,
      omittedBytes: this.streams.stdout.omitted + this.streams.stderr.omitted,
      failure: this.failure });
  }

  get positions() {
    return Object.freeze(Object.fromEntries((["stdout", "stderr"] as const).map(stream => {
      const s = this.streams[stream];
      return [stream, Object.freeze({received:s.received,retained:s.retained,projected:s.projected,omitted:s.omitted,
        encoding:s.projection?.encoding ?? null,integrity:s.projection?.integrity ?? null})];
    }))) as Readonly<Record<ProcessStream, {received:number;retained:number;projected:number;omitted:number;encoding:string|null;integrity:string|null}>>;
  }

  read(cursor?: string, maximumInlineBytes = 32_768) {
    if (!Number.isSafeInteger(maximumInlineBytes) || maximumInlineBytes < 24_576 || maximumInlineBytes > 131_072) {
      throw new TypeError("Process inline limit must be between 24576 and 131072 bytes.");
    }
    const position = this.decodeCursor(cursor);
    for (const stream of ["stdout", "stderr"] as const) {
      if (this.streams[stream].pending.length) this.project(stream, this.streams[stream].pending.length, this.closed);
    }
    const stdout = this.slice("stdout", position.stdout, Math.floor(maximumInlineBytes / 2));
    const stderr = this.slice("stderr", position.stderr, Math.floor(maximumInlineBytes / 2));
    const next = { version: 1, executionId: this.executionId, generation: this.generation,
      stdout: stdout.next, stderr: stderr.next };
    return Object.freeze({ stdout: stdout.value, stderr: stderr.value,
      nextCursor: Buffer.from(JSON.stringify(next)).toString("base64url"),
      hasMore: stdout.next < this.streams.stdout.segments.length || stderr.next < this.streams.stderr.segments.length });
  }

  hasUnread(cursor?: string): boolean {
    const position = this.decodeCursor(cursor);
    return (["stdout", "stderr"] as const).some((stream) =>
      position[stream] < this.streams[stream].segments.length || this.streams[stream].pending.length > 0);
  }

  close(): Promise<void> {
    if (this.closePromise !== null) return this.closePromise;
    this.closed = true;
    for (const stream of ["stdout", "stderr"] as const) this.project(stream, this.streams[stream].pending.length, true);
    this.closePromise = (async () => {
      await this.writeQueue;
      try {
        await this.manifest.writeFile(JSON.stringify({ executionId: this.executionId, generation: this.generation,
          streams: Object.fromEntries((["stdout", "stderr"] as const).map((stream) => {
            const state = this.streams[stream];
            return [stream, { receivedBytes: state.received, retainedBytes: state.retained,
              omittedBytes: state.omitted, projection: state.projection, projectedBytes: state.projected,
              textBytes: state.textBytes }];
          })), persistenceFailure: this.failure }));
        for (const handle of this.handles()) await handle.sync();
      } catch (error) { this.failure ??= message(error); }
      finally { for (const handle of this.handles()) await handle.close().catch((error) => { this.failure ??= message(error); }); }
      if (this.failure !== null) throw new Error(this.failure);
    })();
    return this.closePromise;
  }

  private project(stream: ProcessStream, length: number, final: boolean): void {
    const state = this.streams[stream];
    if (state.projection === null && length === 0 && !final) return;
    // Do not choose an encoding from a partial BOM or a lone multibyte prefix.
    if (state.projection === null && length < 4 && !final) {
      const prefix = state.pending.subarray(0, length);
      if (prefix.includes(0) || prefix[0] === 0xff || prefix[0] === 0xfe ||
          (prefix[0] === 0xef && length < 3)) return;
      try { new TextDecoder("utf-8", { fatal: true }).decode(prefix); } catch { return; }
    }
    const bytes = state.pending.subarray(0, length);
    if (state.projection === null) {
      let sample = bytes;
      if (!final && !bytes.includes(0)) {
        for (let trim = 0; trim <= Math.min(3, bytes.length); trim++) {
          try { new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, bytes.length - trim));
            sample = bytes.subarray(0, bytes.length - trim); break; } catch {}
        }
      }
      state.projection = projectProcessOutputText(sample);
      const bom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? "utf-8"
        : bytes[0] === 0xff && bytes[1] === 0xfe && !(bytes[2] === 0 && bytes[3] === 0) ? "utf-16le"
        : bytes[0] === 0xfe && bytes[1] === 0xff ? "utf-16be" : null;
      if (bom !== null) state.projection = {text:"",encoding:bom,encodingSource:"bom",integrity:"exact",replacementCount:0};
      if (state.projection.encoding !== null) {
        state.decoder = new TextDecoder(state.projection.encoding);
        state.strictDecoder = new TextDecoder(state.projection.encoding, { fatal: true });
      }
    }
    state.pending = state.pending.subarray(length);
    let text = "";
    if (state.decoder !== null) {
      text = state.decoder.decode(bytes, { stream: !final });
      try { state.strictDecoder?.decode(bytes, { stream: !final }); }
      catch { state.strictDecoder = null; state.projection = { ...state.projection, integrity: "lossy" }; }
    }
    const byteEnd = state.projected + bytes.length;
    state.decoderTail = Buffer.concat([state.decoderTail, bytes]).subarray(-4);
    state.decoderPending = !final && decoderHasPendingInput(state.projection.encoding, state.decoderTail, byteEnd);
    if (state.segments.length < MAX_SEGMENTS) {
      // A segment also records bytes buffered by the decoder; text may arrive in the next segment.
      state.segments.push({ byteStart: state.projected, byteEnd, decoderInputStart: 0, text });
      const encoded = Buffer.from(text);
      const remaining = this.maximumBytes * 3 - state.textBytes;
      if (encoded.length <= remaining) {
        state.textBytes += encoded.length;
        this.enqueue(async () => { await writeAll(state.text, encoded); });
      } else state.projection = { ...state.projection, integrity: "unavailable" };
    } else state.projection = { ...state.projection, integrity: "unavailable" };
    state.projected = byteEnd;
    state.projection = { ...state.projection, text: "", replacementCount:
      state.projection.replacementCount + [...text].filter((c) => c === "\ufffd").length };
  }

  private slice(stream: ProcessStream, from: number, budget: number) {
    const state = this.streams[stream];
    let next = from;
    let used = 0;
    const segments: Segment[] = [];
    while (next < state.segments.length) {
      const segment = state.segments[next]!;
      const size = Buffer.byteLength(segment.text);
      if (used + size > budget) break;
      used += size; next++; segments.push(Object.freeze({ ...segment }));
    }
    const start = state.segments[from]?.byteStart ?? state.projected;
    const projection = state.projection ?? projectProcessOutputText(new Uint8Array());
    const value: ProcessOutputSlice = Object.freeze({ ...projection,
      text: segments.map((segment) => segment.text).join(""), byteStart: start,
      byteEnd: segments.at(-1)?.byteEnd ?? start, receivedBytes: state.received,
      omittedBytes: state.omitted, projectionPending: state.pending.length > 0 || state.decoderPending,
      segments: Object.freeze(segments) });
    return { next, value };
  }

  private decodeCursor(cursor?: string): { stdout: number; stderr: number } {
    if (cursor === undefined) return { stdout: 0, stderr: 0 };
    try {
      if (cursor.length > 4096 || !/^[A-Za-z0-9_-]+$/u.test(cursor)) throw new Error();
      const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
      if (parsed.version !== 1 || parsed.executionId !== this.executionId || parsed.generation !== this.generation) throw new Error();
      for (const stream of ["stdout", "stderr"] as const) {
        if (!Number.isSafeInteger(parsed[stream]) || parsed[stream] < 0 || parsed[stream] > this.streams[stream].segments.length) throw new Error();
      }
      return parsed;
    } catch { throw new Error("process_output_cursor_invalid"); }
  }

  private handles(): FileHandle[] { return [this.streams.stdout.raw, this.streams.stderr.raw, this.streams.stdout.text, this.streams.stderr.text, this.manifest]; }
  private enqueue(write: () => Promise<void>): void {
    this.writeQueue = this.writeQueue.then(write).catch((error) => { this.failure ??= message(error); });
  }
}

async function writeAll(handle: FileHandle, bytes: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < bytes.length) {
    const result = await handle.write(bytes, offset, bytes.length - offset);
    if (result.bytesWritten === 0) throw new Error("Process output write made no progress.");
    offset += result.bytesWritten;
  }
}
function message(error: unknown): string { return error instanceof Error ? error.message : "Process output persistence failed."; }

function decoderHasPendingInput(encoding: string | null, tail: Buffer, bytes: number): boolean {
  if (encoding === null || bytes === 0) return false;
  if (encoding === "utf-8") {
    let index = tail.length - 1;
    while (index >= 0 && (tail[index]! & 0xc0) === 0x80) index--;
    if (index < 0) return false;
    const lead = tail[index]!;
    const length = lead >= 0xc2 && lead <= 0xdf ? 2 : lead >= 0xe0 && lead <= 0xef ? 3 : lead >= 0xf0 && lead <= 0xf4 ? 4 : 1;
    return tail.length - index < length;
  }
  if (encoding === "utf-16le" || encoding === "utf-16be") {
    if (bytes % 2) return true;
    const unit = encoding === "utf-16le" ? tail.readUInt16LE(tail.length - 2) : tail.readUInt16BE(tail.length - 2);
    return unit >= 0xd800 && unit <= 0xdbff;
  }
  // Stateful legacy encodings are not declared fully projected until EOF.
  return !/^(?:windows-|iso-8859-|koi8-)/u.test(encoding);
}
