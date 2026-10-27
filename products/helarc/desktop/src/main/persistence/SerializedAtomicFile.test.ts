import { mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import { AtomicFileError, SerializedAtomicFile, type AtomicFileWriteReport } from "./SerializedAtomicFile.js";

const roots: string[] = [];
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "helarc-atomic-file-"));
  roots.push(root);
  const path = join(root, "data.json");
  await writeFile(path, "old");
  return {root, path};
}
afterEach(async () => {
  for (const root of roots.splice(0)) {
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith("helarc-atomic-file-")) throw new Error("Unsafe cleanup");
    await rm(root, {recursive: true, force: true});
  }
});

it.skipIf(process.platform !== "win32")("retries the same flushed temporary file, without replaying the transaction", async () => {
  const {root, path} = await fixture();
  const sources: string[] = [];
  let transactions = 0, writes = 0, flushes = 0;
  const file = new SerializedAtomicFile(path, {operations: {
    async writeExclusive(source, contents) { writes++; await writeFile(source, contents, {flag: "wx"}); },
    async syncFile() { flushes++; },
    async replace(source, target) {
      sources.push(source);
      expect(await readFile(target, "utf8")).toBe("old");
      if (sources.length < 3) throw Object.assign(new Error("sharing violation"), {code: "EPERM", syscall: "rename", errno: -4048});
      await rename(source, target);
    },
  }});
  let report: AtomicFileWriteReport | undefined;
  await file.transact(async tx => {transactions++; await tx.replaceText("new");}, value => {report = value;});
  expect([transactions, writes, flushes]).toEqual([1, 1, 1]);
  expect(new Set(sources).size).toBe(1);
  expect(report).toMatchObject({replacementAttempts: 3, failures: [{fields: {code: "EPERM"}}, {fields: {syscall: "rename"}}]});
  expect(await readFile(path, "utf8")).toBe("new");
  expect(await readdir(root)).toEqual(["data.json"]);
});

it.skipIf(process.platform !== "win32")("bounds replacement retry and preserves the old file, then accepts a later save", async () => {
  const {root, path} = await fixture();
  let attempts = 0, locked = true;
  const file = new SerializedAtomicFile(path, {operations: {async replace(source, target) {
    attempts++;
    if (locked) throw Object.assign(new Error("locked"), {code: "EPERM", syscall: "rename", path: source, dest: target});
    await rename(source, target);
  }}});
  await expect(file.transact(tx => tx.replaceText("new"))).rejects.toMatchObject({
    stage: "replace", code: "EPERM", writeReport: {replacementAttempts: 6}, cause: {syscall: "rename"},
  });
  expect(attempts).toBe(6);
  expect(await readFile(path, "utf8")).toBe("old");
  expect(await readdir(root)).toEqual(["data.json"]);
  locked = false;
  await file.transact(tx => tx.replaceText("recovered"));
  expect(await readFile(path, "utf8")).toBe("recovered");
});

it("does not retry disk errors or pre-replacement stages; diagnostics cannot reverse a save", async () => {
  const {path} = await fixture();
  let attempts = 0;
  const file = new SerializedAtomicFile(path, {operations: {async syncFile() {
    attempts++;
    throw Object.assign(new Error("flush failed"), {code: "EIO"});
  }}});
  await expect(file.transact(tx => tx.replaceText("new"))).rejects.toBeInstanceOf(AtomicFileError);
  expect(attempts).toBe(1);
  expect(await readFile(path, "utf8")).toBe("old");
  await new SerializedAtomicFile(path).transact(tx => tx.replaceText("new"), () => {throw new Error("observer failed");});
  expect(await readFile(path, "utf8")).toBe("new");
});
