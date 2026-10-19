import { describe, expect, it } from "vitest";
import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { FileMutationClaims } from "./FileMutationClaims.js";
import { inspectFileContent, inspectFileHandleContent } from "./FileContentDigest.js";

const absent = {kind: "absent"} as const;
const present = {kind: "present", entryKind: "file", objectIdentity: {kind: "posix", deviceId: "1", inode: "2"}, contentDigest: "sha256:a"} as const;

describe("Host file mutation claims", () => {
  it("serializes aliases and the absent-to-existing path across capability instances", async () => {
    const owner = new FileMutationClaims();
    let release!: () => void;
    const barrier = new Promise<void>(resolve => {release = resolve;});
    const order: string[] = [];
    const first = owner.execute(join(tmpdir(), "a"), absent, async () => {order.push("create"); await barrier; order.push("created");});
    const second = owner.execute(join(tmpdir(), "a"), present, async () => {order.push("edit");});
    const alias = owner.execute(join(tmpdir(), "alias"), present, async () => {order.push("alias");});
    await Promise.resolve();
    expect(order).toEqual(["create"]);
    release();
    await first; await second; await alias;
    expect(order).toEqual(["create", "created", "edit", "alias"]);
  });
  it("lets unrelated files progress and releases a failed claim", async () => {
    const owner = new FileMutationClaims();
    let release!: () => void;
    const barrier = new Promise<void>(resolve => {release = resolve;});
    const held = owner.execute(join(tmpdir(), "a"), absent, async () => {await barrier;});
    expect(await owner.execute(join(tmpdir(), "b"), absent, async () => "independent")).toBe("independent");
    release(); await held;
    await expect(owner.execute(join(tmpdir(), "a"), absent, async () => {throw new Error("write failed");})).rejects.toThrow("write failed");
    expect(await owner.execute(join(tmpdir(), "a"), absent, async () => "next")).toBe("next");
  });
  it("hashes large and empty content without whole-file allocation or moving a caller handle position", async () => {
    const root = await mkdtemp(join(tmpdir(), "file-digest-"));
    try {
      const path = join(root, "large.bin");
      const block = Buffer.alloc(64 * 1024, 0xab);
      const expected = createHash("sha256");
      const handle = await open(path, "w+");
      try {
        for (let index = 0; index < 257; index++) {await handle.write(block); expected.update(block);}
        const result = await inspectFileHandleContent(handle);
        expect(result).toMatchObject({byteLength: 257 * block.length, digest: `sha256:${expected.digest("hex")}`});
        expect((await handle.read(Buffer.alloc(1), 0, 1, null)).bytesRead).toBe(0);
        expect(await inspectFileContent(path)).toMatchObject({digest: result.digest, byteLength: result.byteLength});
      } finally {await handle.close();}
      await writeFile(path, "");
      expect(await inspectFileContent(path)).toMatchObject({byteLength: 0, digest: `sha256:${createHash("sha256").digest("hex")}`});
    } finally {await rm(root, {recursive: true});}
  });
});
