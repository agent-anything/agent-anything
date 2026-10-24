import type {ProcessOutputCheckpoint} from "./ProcessOutputStore.js";

export interface ProcessOutputSearchInput {readonly query: string; readonly stream?: "stdout" | "stderr"; readonly search_cursor?: string; readonly limit?: number;}
export interface ProcessOutputSearchResult {
  readonly kind: "output_search"; readonly task_id: string; readonly stream: "stdout" | "stderr";
  readonly coordinate: "projected_utf8_bytes"; readonly frontier: {readonly segments: number; readonly bytes: number};
  readonly matches: readonly {readonly byte_start: number; readonly byte_end: number; readonly text: string}[];
  readonly next_search_cursor: string | null; readonly scanned_bytes: number; readonly exhausted: boolean;
  readonly encoding: string | null; readonly integrity: string; readonly omitted_raw_bytes: number;
  readonly limitations: readonly string[];
}
const SCAN_BYTES = 262_144;
/** Searches a frozen, decoded view. Raw source positions are deliberately a different coordinate domain. */
export function searchProcessOutput(value: ProcessOutputCheckpoint, input: ProcessOutputSearchInput): ProcessOutputSearchResult {
  const {query} = input, stream = input.stream ?? "stdout", limit = input.limit ?? 8;
  if (typeof query !== "string" || !query.length || Buffer.byteLength(query) > 1024 || !["stdout", "stderr"].includes(stream) ||
      !integer(limit, 1, 16)) throw new TypeError("Output search needs a nonempty literal query (at most 1024 UTF-8 bytes), stdout/stderr and limit 1-16.");
  const source = value.streams[stream];
  let segments = source.segments.length, offset = 0, expectedBytes: number | null = null;
  if (input.search_cursor !== undefined) {
    try {
      if (typeof input.search_cursor !== "string" || input.search_cursor.length > 4096) throw new Error();
      const cursor = JSON.parse(Buffer.from(input.search_cursor, "base64url").toString("utf8"));
      if (cursor.version !== 1 || cursor.task !== value.executionId || cursor.stream !== stream || cursor.query !== query ||
          !integer(cursor.segments, 0, segments) || !integer(cursor.bytes, 0, Number.MAX_SAFE_INTEGER) || !integer(cursor.offset, 0, cursor.bytes)) throw new Error();
      segments = cursor.segments; offset = cursor.offset; expectedBytes = cursor.bytes;
    } catch {throw new TypeError("Invalid output-search cursor. Keep the exact task, stream and query, or start a new search.");}
  }
  let total = 0;
  const chunks = source.segments.slice(0, segments).map(segment => {
    const start = total; total += Buffer.byteLength(segment.text); return {start, end: total, text: segment.text};
  });
  if (expectedBytes !== null && total !== expectedBytes) throw new TypeError("Output-search frontier is unavailable.");
  const range = (start: number, end: number) => Buffer.concat(chunks.filter(c => c.start < end && c.end > start)
    .map(c => Buffer.from(c.text).subarray(Math.max(0, start - c.start), Math.min(c.end - c.start, end - c.start))));
  const needle = Buffer.from(query), scanEnd = Math.min(total, offset + SCAN_BYTES);
  const bytes = range(offset, Math.min(total, scanEnd + needle.length - 1));
  const matches: ProcessOutputSearchResult["matches"][number][] = [];
  let from = 0;
  while (matches.length < limit) {
    const found = bytes.indexOf(needle, from);
    if (found < 0 || offset + found >= scanEnd) break;
    const start = offset + found, excerpt = range(start, Math.min(total, start + Math.max(256, needle.length) + 3));
    let length = Math.min(excerpt.length, Math.max(256, needle.length));
    while (length < excerpt.length && (excerpt[length]! & 0xc0) === 0x80) length--;
    matches.push({byte_start: start, byte_end: start + length, text: new TextDecoder("utf-8", {fatal: true}).decode(excerpt.subarray(0, length))});
    from = found + needle.length;
  }
  const next = matches.length >= limit ? offset + from : scanEnd;
  const exhausted = next >= total;
  return {kind: "output_search", task_id: value.executionId, stream, coordinate: "projected_utf8_bytes", frontier: {segments, bytes: total}, matches,
    next_search_cursor: exhausted ? null : Buffer.from(JSON.stringify({version: 1, task: value.executionId, stream, query, segments, bytes: total, offset: next})).toString("base64url"),
    scanned_bytes: next - offset, exhausted, encoding: source.projection?.encoding ?? null, integrity: source.projection?.integrity ?? "unavailable",
    omitted_raw_bytes: source.omitted, limitations: ["frozen_captured_text_prefix", "not_a_command_success_assessment",
      ...(!exhausted ? ["partial_scan", "no_match_is_not_absence"] : []),
      ...(source.projectionPending ? ["decoder_tail_not_in_view"] : []), ...(source.omitted ? ["capture_omitted_bytes"] : []),
      ...(value.failure ? ["output_capture_failure"] : [])]};
}
function integer(value: unknown, min: number, max: number): value is number {return Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max;}
