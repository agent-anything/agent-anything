import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { readFileTextPage } from "./FileTextRead.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, {recursive: true, force: true}); });
async function page(content: string | Buffer, overrides: Partial<Parameters<typeof readFileTextPage>[0]> = {}) {
  const root = await mkdtemp(join(tmpdir(), "helarc-read-")); roots.push(root);
  const path = join(root, "text.txt"); await writeFile(path, content);
  return readFileTextPage({path, offset: 1, limit: 2000, maxBytes: 1_000_000,
    maxInspectionBytes: 4_000_000, signal: new AbortController().signal, ...overrides});
}
describe("lossless bounded file pages", () => {
  it("preserves BOM, mixed endings and trailing newline", async () => {
    const content = "\uFEFFfirst\r\nsecond\nthird\r\n";
    expect(await page(content)).toMatchObject({content, total_lines: 4, next_offset: null, truncated: false,
      content_digest: `sha256:${createHash("sha256").update(content).digest("hex")}`});
    expect(await page(content, {offset: 2, limit: 1})).toMatchObject({content: "second\n", start_line: 2, end_line: 2, next_offset: 3});
  });
  it("reads a later page of a file larger than its response budget", async () => {
    const content = "abc\r\n".repeat(300_000);
    expect(await page(content, {offset: 299_999, limit: 2, maxBytes: 10})).toMatchObject({content: "abc\r\nabc\r\n", end_line: 300_000, next_offset: 300_001});
    expect(await page("first\nsecond\n", {maxBytes: 8})).toMatchObject({content: "first\n", next_offset: 2});
  });
  it("does not invent partial lines or accept malformed text/baselines", async () => {
    await expect(page("oversized line", {maxBytes: 3})).rejects.toMatchObject({code: "file_read_line_limit_exceeded"});
    await expect(page(Buffer.from([0xc3]))).rejects.toMatchObject({code: "file_content_unsupported"});
    await expect(page("changed", {expectedDigest: "sha256:old"})).rejects.toMatchObject({code: "file_target_changed"});
    await expect(page("too big", {maxInspectionBytes: 3})).rejects.toMatchObject({code: "file_read_inspection_limit_exceeded"});
  });
  it("handles empty files, end offsets, cancellation and UTF-8 across chunks", async () => {
    expect(await page("")).toMatchObject({content: "", total_lines: 0, next_offset: null});
    expect(await page("abc", {offset: 9})).toMatchObject({content: "", end_line: 0, next_offset: null});
    const text = "a".repeat(65535) + "\u4e2d\r\nlast";
    expect(await page(text)).toMatchObject({content: text});
    await expect(page("abc", {signal: AbortSignal.abort()})).rejects.toMatchObject({code: "file_action_interrupted"});
  });
});
