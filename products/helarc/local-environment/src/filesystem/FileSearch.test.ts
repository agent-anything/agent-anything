import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { searchWorkspaceFiles, type FileSearchRequest } from "./FileSearch.js";
import { resolveFileSystemLimits } from "./FileSystemLimits.js";
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, {recursive: true, force: true}); });
async function fixture() { const root = await realpath(await mkdtemp(join(tmpdir(), "helarc-search-"))); roots.push(root); return root; }
function request(root: string, overrides: Partial<FileSearchRequest> = {}): FileSearchRequest {
  return {operation: "grep", root, target: root, pattern: "needle", glob: null, mode: "content", offset: 1,
    limit: 100, caseSensitive: true, multiline: false, before: 0, after: 0, ...overrides};
}
const signal = () => new AbortController().signal;
describe("bounded Workspace search coverage", () => {
  it("reports complete negative and positive searches", async () => {
    const root = await fixture(); await writeFile(join(root, "a.txt"), "needle\nneedle");
    expect(await searchWorkspaceFiles(request(root), resolveFileSystemLimits(undefined), signal())).toMatchObject({
      entries: [{line: 1, text: "needle"}, {line: 2, text: "needle"}], truncated: false, omitted_count: 0,
      scan: {complete: true, files_searched: 1, skipped_count: 0}});
    expect(await searchWorkspaceFiles(request(root, {pattern: "absent"}), resolveFileSystemLimits(undefined), signal())).toMatchObject({
      entries: [], truncated: false, scan: {complete: true}});
    expect(await searchWorkspaceFiles(request(root, {offset: 10}), resolveFileSystemLimits(undefined), signal())).toMatchObject({
      entries: [], omitted_count: 2, truncated: true, scan: {complete: true}});
  });
  it("reports skipped oversized and unsupported files instead of false absence", async () => {
    const root = await fixture(); await writeFile(join(root, "big.txt"), "needle".repeat(20));
    await writeFile(join(root, "bad.txt"), Buffer.from([0xff]));
    const result = await searchWorkspaceFiles(request(root), resolveFileSystemLimits({maxSearchFileBytes: 10}), signal());
    expect(result).toMatchObject({entries: [], omitted_count: null, truncated: true, scan: {complete: false, skipped_count: 2}});
    expect(result.scan.skipped.map(item => item.reason).sort()).toEqual(["file_byte_limit", "unsupported_text"]);
  });
  it("bounds pages, traversal, count work and response bytes", async () => {
    const root = await fixture(); await writeFile(join(root, "a.txt"), "needle\n".repeat(20));
    const result = await searchWorkspaceFiles(request(root, {limit: 2}), resolveFileSystemLimits(undefined), signal());
    expect(result.entries).toHaveLength(2); expect(result.scan).toMatchObject({complete: false, stop_reason: "result_limit"});
    expect(await searchWorkspaceFiles(request(root, {mode: "count"}), resolveFileSystemLimits({maxSearchMatches: 2}), signal())).toMatchObject({
      entries: [], scan: {complete: false, stop_reason: "match_limit"}});
    expect(await searchWorkspaceFiles(request(root), resolveFileSystemLimits({maxSearchEntries: 1}), signal())).toMatchObject({scan: {stop_reason: "entry_limit"}});
    expect(await searchWorkspaceFiles(request(root), resolveFileSystemLimits({maxSearchOutputBytes: 10}), signal())).toMatchObject({scan: {stop_reason: "output_limit"}});
    expect(await searchWorkspaceFiles(request(root), resolveFileSystemLimits({maxSearchBytes: 1}), signal())).toMatchObject({scan: {stop_reason: "byte_limit"}});
  });
  it("terminates pathological regex execution without blocking the caller", async () => {
    const root = await fixture(); await writeFile(join(root, "a.txt"), "a".repeat(100_000) + "!");
    const result = await searchWorkspaceFiles(request(root, {pattern: "(a+)+$"}), resolveFileSystemLimits({maxSearchRegexMs: 150}), signal());
    expect(result.scan).toMatchObject({complete: false, stop_reason: "file_search_regex_timeout"});
  });
  it("supports multiline, exact count and files-only modes", async () => {
    const root = await fixture(); await writeFile(join(root, "a.txt"), "needle\r\nsecond\nneedle");
    const limits = resolveFileSystemLimits(undefined);
    expect((await searchWorkspaceFiles(request(root, {pattern: "needle\\r?\\nsecond", multiline: true}), limits, signal())).entries).toMatchObject([{line: 1, column: 1}]);
    expect((await searchWorkspaceFiles(request(root, {mode: "count"}), limits, signal())).entries).toEqual([{file_path: "a.txt", count: 2}]);
    expect((await searchWorkspaceFiles(request(root, {mode: "files_with_matches"}), limits, signal())).entries).toEqual([{file_path: "a.txt"}]);
  });
  it("bounds directory depth and honours cancellation", async () => {
    const root = await fixture(); await mkdir(join(root, "a", "b"), {recursive: true});
    const result = await searchWorkspaceFiles(request(root, {operation: "glob", pattern: "**/*"}), resolveFileSystemLimits({maxSearchDepth: 1}), signal());
    expect(result.scan).toMatchObject({complete: false, skipped: [{reason: "depth_limit"}]});
    await expect(searchWorkspaceFiles(request(root), resolveFileSystemLimits(undefined), AbortSignal.abort())).rejects.toMatchObject({code: "file_action_interrupted"});
  });
  it("does not follow a directory link outside the admitted root", async () => {
    const root = await fixture(); const outside = await fixture();
    await writeFile(join(outside, "private.txt"), "needle");
    await symlink(outside, join(root, "linked"), process.platform === "win32" ? "junction" : "dir");
    expect(await searchWorkspaceFiles(request(root), resolveFileSystemLimits(undefined), signal())).toMatchObject({
      entries: [], omitted_count: null, scan: {complete: false, skipped: [{file_path: "linked", reason: "symbolic_link"}]}});
  });
  it("cancels a running regex worker and leaves later searches usable", async () => {
    const root = await fixture(); await writeFile(join(root, "a.txt"), "a".repeat(100_000) + "!");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 100);
    try {
      await expect(searchWorkspaceFiles(request(root, {pattern: "(a+)+$"}), resolveFileSystemLimits(undefined), controller.signal))
        .rejects.toMatchObject({code: "file_action_interrupted"});
    } finally { clearTimeout(timer); }
    expect((await searchWorkspaceFiles(request(root, {pattern: "absent"}), resolveFileSystemLimits(undefined), signal())).scan.complete).toBe(true);
  });
});
