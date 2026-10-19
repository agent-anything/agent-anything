import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, writeFile, rm, stat, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FileBaseline } from "@agent-anything/canonical-action/subject";
import { inspectFileContent } from "./FileContentDigest.js";
import { writeBoundFileContent } from "./FileContentMutation.js";
import { hostFileMutationClaims } from "./FileMutationClaims.js";

const directories: string[] = [];
afterEach(async () => {for (const path of directories.splice(0)) await rm(path, {recursive: true});});
async function file(content?: string) {
  const dir = await mkdtemp(join(tmpdir(), "file-content-mutation-")); directories.push(dir);
  const path = join(dir, "file.txt");
  if (content !== undefined) await writeFile(path, content);
  return path;
}
async function baseline(path: string): Promise<FileBaseline> {
  const content = await inspectFileContent(path);
  return {kind: "present", entryKind: "file", objectIdentity: {kind: "posix", deviceId: String(content.stats.dev), inode: String(content.stats.ino)}, contentDigest: content.digest};
}
const signal = () => new AbortController().signal;

describe("handle-bound file mutation", () => {
  it("retains old bytes before mutation, then truncates, flushes and verifies the requested bytes", async () => {
    const path = await file("earlier content with a long tail"), before = await baseline(path);
    const order: string[] = [];
    const result = await hostFileMutationClaims.execute(path, before, () => writeBoundFileContent({path, before, content: Buffer.from("new"), signal: signal(),
      markEffectStarted: () => order.push("mutate"), retainPreimage: async handle => {
        expect(handle).not.toBeNull(); expect((await handle!.readFile()).toString()).toBe("earlier content with a long tail");
        expect(await readFile(path, "utf8")).toBe("earlier content with a long tail"); order.push("retain");
      }}));
    expect(order).toEqual(["retain", "mutate"]);
    expect(await readFile(path, "utf8")).toBe("new");
    expect(result.byteLength).toBe(3);
    expect(result.digest).toBe((await inspectFileContent(path)).digest);
  });
  it("does not overwrite stale content or a replacement object even if the bytes match", async () => {
    const path = await file("old"), before = await baseline(path), started = vi.fn();
    const input = {path, before, content: Buffer.from("new"), signal: signal(), markEffectStarted: started};
    await writeFile(path, "other");
    await expect(writeBoundFileContent(input)).rejects.toMatchObject({code: "file_target_changed"});
    await writeFile(path, "old");
    await rename(path, `${path}.previous`); await writeFile(path, "old");
    await expect(writeBoundFileContent(input)).rejects.toMatchObject({code: "file_target_changed"});
    expect(started).not.toHaveBeenCalled();
    expect(await readFile(path, "utf8")).toBe("old");
  });
  it("rejects observed change during retention without making the requested write", async () => {
    const path = await file("old"), before = await baseline(path), started = vi.fn();
    await expect(writeBoundFileContent({path, before, content: Buffer.from("new"), signal: signal(), markEffectStarted: started,
      retainPreimage: async () => {await writeFile(path, "external change");}})).rejects.toMatchObject({code: "file_target_changed"});
    expect(started).not.toHaveBeenCalled();
    expect(await readFile(path, "utf8")).toBe("external change");
  });
  it("retains absence before exclusive creation and supports explicit empty content", async () => {
    const path = await file();
    await writeBoundFileContent({path, before: {kind: "absent"}, content: Buffer.alloc(0), signal: signal(), markEffectStarted: () => {},
      retainPreimage: async handle => {expect(handle).toBeNull(); await expect(stat(path)).rejects.toMatchObject({code: "ENOENT"});}});
    expect((await readFile(path)).length).toBe(0);
    await expect(writeBoundFileContent({path, before: {kind: "absent"}, content: Buffer.from("bad"), signal: signal(), markEffectStarted: () => {}})).rejects.toMatchObject({code: "EEXIST"});
    expect((await readFile(path)).length).toBe(0);
  });
  it("does not mutate after cancellation or mandatory material storage failure", async () => {
    const path = await file("old"), before = await baseline(path), started = vi.fn();
    const controller = new AbortController();
    await expect(writeBoundFileContent({path, before, content: Buffer.from("new"), signal: controller.signal, markEffectStarted: started,
      retainPreimage: async () => {controller.abort();}})).rejects.toMatchObject({code: "file_action_interrupted"});
    await expect(writeBoundFileContent({path, before, content: Buffer.from("new"), signal: signal(), markEffectStarted: started,
      retainPreimage: async () => {throw new Error("execution_storage_acknowledgement_unknown");}})).rejects.toThrow("execution_storage_acknowledgement_unknown");
    expect(started).not.toHaveBeenCalled(); expect(await readFile(path, "utf8")).toBe("old");
  });
});
