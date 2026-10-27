import { Worker } from "node:worker_threads";
import type { CodeFileGrepEntry } from "@agent-anything/helarc-code-agent/source";
import { FileSystemError } from "./FileSystemError.js";

export interface FileMatchRequest {
  content: string; path: string; pattern: string; flags: string;
  mode: "content" | "files_with_matches" | "count";
  multiline: boolean; before: number; after: number;
  maxMatches: number; maxEntries: number; maxBytes: number;
}
export interface FileMatchResult {
  entries: CodeFileGrepEntry[]; matches: number;
  stop: "match_limit" | "result_limit" | "output_limit" | null;
}

/** A regex may block synchronously; cancellation must not depend on that event loop. */
export class FileSearchMatcher {
  private readonly worker = new Worker(`const {parentPort}=require('node:worker_threads');
    const scan=${matchFileText.toString()};
    parentPort.on('message', input => parentPort.postMessage(scan(input)));`, {
    eval: true, resourceLimits: {maxOldGenerationSizeMb: 64, stackSizeMb: 4},
  });
  private failure = false;
  constructor() { this.worker.on("error", () => { this.failure = true; }); }

  async match(input: FileMatchRequest, signal: AbortSignal, timeoutMs: number): Promise<FileMatchResult> {
    if (this.failure) throw new FileSystemError("file_search_matcher_failed", "The bounded regex worker failed.");
    return new Promise((resolve, reject) => {
      const finish = (error: Error | null, value?: FileMatchResult) => {
        clearTimeout(timer); signal.removeEventListener("abort", abort);
        this.worker.off("message", receive); this.worker.off("error", failed); this.worker.off("exit", exited);
        if (error) reject(error); else resolve(value!);
      };
      const receive = (value: FileMatchResult) => finish(null, value);
      const failed = () => finish(new FileSystemError("file_search_matcher_failed", "The bounded regex worker failed."));
      const exited = () => failed();
      const abort = () => finish(new FileSystemError("file_action_interrupted", "Search was interrupted."));
      const timer = setTimeout(() => finish(new FileSystemError("file_search_regex_timeout", "Regex matching exceeded its time budget.")), timeoutMs);
      this.worker.once("message", receive); this.worker.once("error", failed); this.worker.once("exit", exited);
      signal.addEventListener("abort", abort, {once: true});
      if (signal.aborted) abort(); else this.worker.postMessage(input);
    });
  }
  async close(): Promise<void> { await this.worker.terminate(); }
}

// Self-contained so the worker executes the same typed algorithm without loader hooks.
function matchFileText(input: FileMatchRequest): FileMatchResult {
  const expression = new RegExp(input.pattern, input.flags);
  const lines = input.content.split(/\r?\n/u);
  const entries: CodeFileGrepEntry[] = [];
  let matches = 0;
  let bytes = 0;
  let stop: FileMatchResult["stop"] = null;
  let lineNumber = 0;
  let lineStart = 0;
  const sources = input.multiline ? [input.content] : lines;
  for (let index = 0; index < sources.length; index++) {
    expression.lastIndex = 0;
    for (const match of sources[index]!.matchAll(expression)) {
      if (matches >= input.maxMatches) { stop = "match_limit"; break; }
      matches++;
      if (input.mode === "files_with_matches") return {entries: [{file_path: input.path}], matches, stop: null};
      if (input.mode === "count") continue;
      if (entries.length >= input.maxEntries) { stop = "result_limit"; break; }
      if (input.multiline) {
        while (true) {
          const next = input.content.indexOf("\n", lineStart);
          if (next < 0 || next >= match.index) break;
          lineNumber++; lineStart = next + 1;
        }
      } else { lineNumber = index; lineStart = 0; }
      const entry = {file_path: input.path, line: lineNumber + 1, column: match.index - lineStart + 1,
        text: lines[lineNumber] ?? "", before: lines.slice(Math.max(0, lineNumber - input.before), lineNumber),
        after: lines.slice(lineNumber + 1, lineNumber + 1 + input.after)};
      const size = Buffer.byteLength(JSON.stringify(entry), "utf8");
      if (bytes + size > input.maxBytes) { stop = "output_limit"; break; }
      entries.push(entry); bytes += size;
    }
    if (stop) break;
  }
  if (input.mode === "count" && !stop && matches) entries.push({file_path: input.path, count: matches});
  return {entries, matches, stop};
}
