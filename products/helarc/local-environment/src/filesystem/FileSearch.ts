import { Buffer } from "node:buffer";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import type { Dir } from "node:fs";
import { isAbsolute, join, matchesGlob, relative, sep } from "node:path";
import type { CodeAgentFileLimits, CodeFileGrepEntry, CodeFileSearchCoverage } from "@agent-anything/helarc-code-agent/source";
import { FileSearchMatcher } from "./FileSearchMatcher.js";
import { FileSystemError } from "./FileSystemError.js";
import { decodeUtf8 } from "./Utf8.js";
import { sameFileIdentity } from "./FileContentDigest.js";

export interface FileSearchRequest {
  operation: "glob" | "grep"; root: string; target: string; pattern: string; glob: string | null;
  mode: "content" | "files_with_matches" | "count"; offset: number; limit: number;
  caseSensitive: boolean; multiline: boolean; before: number; after: number;
}

export async function searchWorkspaceFiles(input: FileSearchRequest, limits: CodeAgentFileLimits, signal: AbortSignal) {
  const scan: CodeFileSearchCoverage = {complete: true, entries_visited: 0, files_searched: 0, bytes_read: 0,
    skipped_count: 0, skipped: [], skipped_details_truncated: false, stop_reason: null};
  const entries: CodeFileGrepEntry[] = [];
  const paths: string[] = [];
  const maximum = input.operation === "glob" ? limits.maxGlobEntries : Math.min(input.limit, limits.maxGrepMatches);
  const offset = input.operation === "glob" ? 0 : input.offset - 1;
  const deadline = performance.now() + limits.maxSearchDurationMs;
  let total = 0;
  let matchWork = 0;
  let outputBytes = 0;
  let matcher: FileSearchMatcher | null = null;
  const relativePath = (path: string) => relative(input.root, path).split(sep).join("/") || ".";
  const skip = (path: string, reason: string) => {
    scan.complete = false; scan.skipped_count++;
    if (scan.skipped.length < 32) scan.skipped.push({file_path: relativePath(path), reason});
    else scan.skipped_details_truncated = true;
  };
  const stop = (reason: string) => { scan.complete = false; scan.stop_reason ??= reason; };
  const check = () => {
    if (signal.aborted) throw new FileSystemError("file_action_interrupted", "Search was interrupted.");
    if (performance.now() >= deadline) stop("time_limit");
    return scan.stop_reason === null;
  };
  const append = (entry: CodeFileGrepEntry | string) => {
    total++;
    if (total <= offset) return;
    if (total - offset > maximum) { stop("result_limit"); return; }
    const bytes = Buffer.byteLength(JSON.stringify(entry), "utf8");
    if (outputBytes + bytes > limits.maxSearchOutputBytes) { stop("output_limit"); return; }
    outputBytes += bytes;
    if (typeof entry === "string") paths.push(entry); else entries.push(entry);
  };
  const directories: {directory: Dir; path: string; depth: number}[] = [];
  let next: {path: string; depth: number} | null = {path: input.target, depth: 0};
  try {
    while (check()) {
      if (!next) {
        const parent = directories.at(-1);
        if (!parent) break;
        let child;
        try { child = await parent.directory.read(); }
        catch { skip(parent.path, "unreadable_directory"); await parent.directory.close(); directories.pop(); continue; }
        if (!child) { await parent.directory.close(); directories.pop(); continue; }
        next = {path: join(parent.path, child.name), depth: parent.depth + 1};
      }
      const current = next; next = null;
      if (scan.entries_visited >= limits.maxSearchEntries) { stop("entry_limit"); break; }
      scan.entries_visited++;
      if (current.depth > limits.maxSearchDepth) { skip(current.path, "depth_limit"); continue; }
      try {
        const stat = await lstat(current.path);
        if (stat.isSymbolicLink()) { skip(current.path, "symbolic_link"); continue; }
        const resolved = await realpath(current.path);
        const rel = relative(input.root, resolved);
        if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) { skip(current.path, "outside_scope"); continue; }
        const targetRelative = relative(input.target, current.path).split(sep).join("/") || ".";
        if (input.operation === "glob" && targetRelative !== "." && matchesGlob(targetRelative, input.pattern)) append(relativePath(current.path));
        if (!check()) break;
        if (stat.isDirectory()) {
          directories.push({directory: await opendir(current.path), path: current.path, depth: current.depth});
          continue;
        }
        if (!stat.isFile() || input.operation === "glob") continue;
        if (input.glob && !matchesGlob(targetRelative === "." ? relativePath(current.path) : targetRelative, input.glob)) continue;
        if (stat.size > limits.maxSearchFileBytes) { skip(current.path, "file_byte_limit"); continue; }
        if (scan.bytes_read + stat.size > limits.maxSearchBytes) { stop("byte_limit"); break; }
        const handle = await open(current.path, "r");
        let bytes: Buffer;
        try {
          const before = await handle.stat();
          if (!sameFileIdentity(stat, before) || before.size !== stat.size) { skip(current.path, "file_changed"); continue; }
          bytes = Buffer.alloc(before.size);
          let read = 0;
          while (read < bytes.length && check()) {
            const result = await handle.read(bytes, read, Math.min(64 * 1024, bytes.length - read), read);
            if (!result.bytesRead) break;
            read += result.bytesRead; scan.bytes_read += result.bytesRead;
          }
          if (!check()) break;
          const after = await handle.stat();
          if (read !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
            skip(current.path, "file_changed"); continue;
          }
        } finally { await handle.close(); }
        const content = decodeUtf8(bytes);
        if (content === null || bytes.includes(0)) { skip(current.path, "unsupported_text"); continue; }
        if (matchWork >= limits.maxSearchMatches) { stop("match_limit"); break; }
        matcher ??= new FileSearchMatcher();
        const result = await matcher.match({content, path: relativePath(current.path), pattern: input.pattern,
          flags: `g${input.caseSensitive ? "" : "i"}${input.multiline ? "ms" : ""}u`,
          mode: input.mode, multiline: input.multiline,
          before: Math.min(input.before, limits.maxGrepContextLines), after: Math.min(input.after, limits.maxGrepContextLines),
          maxMatches: limits.maxSearchMatches - matchWork, maxEntries: Math.min(offset + maximum + 1 - total, limits.maxSearchMatches),
          maxBytes: limits.maxSearchOutputBytes,
        }, signal, Math.max(1, Math.min(limits.maxSearchRegexMs, deadline - performance.now())));
        matchWork += result.matches;
        if (result.stop === null) scan.files_searched++;
        for (const entry of result.entries) { append(entry); if (!check()) break; }
        if (result.stop) { stop(result.stop); break; }
      } catch (error) {
        if (signal.aborted) throw new FileSystemError("file_action_interrupted", "Search was interrupted.");
        if (error instanceof FileSystemError && error.code.startsWith("file_search_")) { stop(error.code); break; }
        skip(current.path, "unreadable_or_changed");
      }
    }
  } finally {
    for (const {directory} of directories.reverse()) await directory.close().catch(() => undefined);
    await matcher?.close();
  }
  const returned = input.operation === "glob" ? paths.length : entries.length;
  return {matches: paths.sort(), entries, output_mode: input.mode,
    truncated: !scan.complete || total > returned,
    omitted_count: scan.complete ? total - returned : null, scan};
}
