import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile, rm, lstat, rename, link } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, basename, resolve } from "node:path";
import { inspectFileContent } from "./FileContentDigest.js";
import { FILE_MATERIAL_POLICY, type FileMaterialPreparation, type FileMaterialRecord } from "./FileMaterial.js";
import { restoreBoundFileContent, type FileContentRestorationInput } from "./FileContentRestoration.js";

const directories: string[] = [];
afterEach(async () => {
  for (const path of directories.splice(0)) {
    const target = resolve(path);
    if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith("file-content-restoration-")) throw new Error("Invalid test cleanup target");
    await rm(target, {recursive: true});
  }
});
const digest = (bytes: Uint8Array) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

async function fixture(original: Buffer | null = Buffer.from("old content")) {
  const directory = await mkdtemp(join(tmpdir(), "file-content-restoration-")); directories.push(directory);
  const path = join(directory, "file.txt");
  await writeFile(path, "changed content");
  const state = await inspectFileContent(path);
  const identity = {kind: "posix" as const, deviceId: String(state.stats.dev), inode: String(state.stats.ino)};
  const material: FileMaterialPreparation = {
    ref: {owner: "helarc-files", kind: "material", id: "original-material", revision: "1"},
    policyRevision: FILE_MATERIAL_POLICY.revision, runId: "original-run",
    invocation: {id: "original-invocation", operation: {operation: {namespace: "files", name: "write"}, revision: "1"}},
    attempt: {id: "original-attempt", action: {id: "original-action"}, ordinal: 1},
    target: {canonicalPath: path, rootIdentity: "root-1", ancestryIdentity: "ancestry-1"},
    before: original === null ? {kind: "absent"} : {kind: "present", entryKind: "file", objectIdentity: identity, contentDigest: digest(original)},
    byteLength: original?.length ?? 0, readAuthorityRef: "historical-read-grant-not-current-authority", preparedAt: "2026-10-16T00:00:00.000Z",
  };
  let record: FileMaterialRecord = {preparation: material, state: "available", digest: digest(original ?? Buffer.alloc(0)),
    finishedAt: material.preparedAt, reason: null, pins: ["original-run"], expiresAt: null};
  const records = {
    readFileMaterialRecord: vi.fn(async () => structuredClone(record)),
    pinFileMaterial: vi.fn(async (_ref, runId: string) => {record = {...record, pins: [...record.pins, runId]};}),
    readFileMaterialRange: vi.fn(async (_ref, offset: number, length: number) => ({reference: material.ref, offset,
      byteLength: length, totalBytes: material.byteLength, digest: record.digest!, base64: original!.subarray(offset, offset + length).toString("base64")})),
  };
  const input: FileContentRestorationInput = {material, after: {kind: "present", entryKind: "file", objectIdentity: identity, contentDigest: state.digest},
    runId: "restoring-run", records, signal: new AbortController().signal, revalidateTarget: vi.fn(async () => {}), markEffectStarted: vi.fn()};
  return {directory, path, input, records, setRecord: (value: FileMaterialRecord) => {record = value;}, getRecord: () => record};
}

describe("file-owner conditional restoration", () => {
  it.each(["readFileMaterialRecord", "readFileMaterialRange", "pinFileMaterial"] as const)("preserves uncertain %s acknowledgement as an owner failure", async stage => {
    const test = await fixture();
    test.records[stage].mockRejectedValueOnce(new Error("lost storage acknowledgement"));
    await expect(restoreBoundFileContent(test.input)).rejects.toMatchObject({name: "OperationCommitError"});
    expect(test.input.markEffectStarted).not.toHaveBeenCalled();
    expect((await readFile(test.path)).toString()).toBe("changed content");
  });
  it("can restore the known absence produced by an earlier restoration", async () => {
    const test = await fixture();
    await rm(test.path);
    await expect(restoreBoundFileContent({...test.input, after: {kind: "absent"}})).resolves.toMatchObject({kind: "content"});
    expect((await readFile(test.path)).toString()).toBe("old content");
  });
  it("verifies bounded material completely before restoring and retains the active recovery pin", async () => {
    const bytes = Buffer.alloc(FILE_MATERIAL_POLICY.readBytes * 2 + 17, 0xAB);
    const test = await fixture(bytes);
    const order: string[] = [];
    test.records.pinFileMaterial.mockImplementation(async (_ref, runId) => {test.setRecord({...test.getRecord(), pins: [runId]}); order.push("pin");});
    const read = test.records.readFileMaterialRange.getMockImplementation()!;
    test.records.readFileMaterialRange.mockImplementation(async (...args) => {order.push("read"); return read(...args);});
    const result = await restoreBoundFileContent({...test.input, markEffectStarted: () => order.push("mutate"),
      retainPreimage: async handle => {expect((await handle!.readFile()).toString()).toBe("changed content"); order.push("retain");}});
    expect(result).toMatchObject({kind: "content", byteLength: bytes.length, digest: digest(bytes), after: {kind: "present", contentDigest: digest(bytes)}});
    expect(await readFile(test.path)).toEqual(bytes);
    expect(order).toEqual(["pin", "read", "read", "read", "retain", "mutate"]);
    expect(test.getRecord().pins).toContain("restoring-run");
  });

  it.each([false, true])("distinguishes empty prior content from prior absence (%s)", async absent => {
    const test = await fixture(absent ? null : Buffer.alloc(0));
    const result = await restoreBoundFileContent(test.input);
    if (absent) {
      expect(result).toEqual({kind: "absence"});
      await expect(lstat(test.path)).rejects.toMatchObject({code: "ENOENT"});
      expect((await lstat(test.directory)).isDirectory()).toBe(true);
    } else {
      expect(result).toMatchObject({kind: "content", byteLength: 0, digest: digest(Buffer.alloc(0)), after: {kind: "present", contentDigest: digest(Buffer.alloc(0))}});
      expect(await readFile(test.path)).toEqual(Buffer.alloc(0));
    }
    expect(test.records.readFileMaterialRange).not.toHaveBeenCalled();
  });

  it.each(["content", "identity", "hardlink"] as const)("does not restore an observed %s conflict", async conflict => {
    const test = await fixture();
    if (conflict === "content") await writeFile(test.path, "new external content");
    if (conflict === "identity") {await rename(test.path, `${test.path}.previous`); await writeFile(test.path, "changed content");}
    if (conflict === "hardlink") await link(test.path, `${test.path}.alias`);
    const before = await readFile(test.path);
    await expect(restoreBoundFileContent(test.input)).rejects.toMatchObject({code: "file_target_changed"});
    expect(test.input.markEffectStarted).not.toHaveBeenCalled();
    expect(await readFile(test.path)).toEqual(before);
  });

  it("serializes competing restorations and rejects the second stale receipt", async () => {
    const test = await fixture();
    const results = await Promise.allSettled([restoreBoundFileContent(test.input), restoreBoundFileContent(test.input)]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
    expect(test.input.markEffectStarted).toHaveBeenCalledTimes(1);
    expect((await readFile(test.path)).toString()).toBe("old content");
  });

  it.each(["digest", "range", "source", "unavailable", "pin"] as const)("rejects %s material before any target mutation", async fault => {
    const test = await fixture();
    if (fault === "digest") test.records.readFileMaterialRange.mockImplementation(async () => ({reference: test.input.material.ref, offset: 0,
      byteLength: 11, totalBytes: 11, digest: test.getRecord().digest!, base64: Buffer.from("bad content").toString("base64")}));
    if (fault === "range") test.records.readFileMaterialRange.mockImplementation(async () => ({reference: test.input.material.ref, offset: 1,
      byteLength: 11, totalBytes: 11, digest: test.getRecord().digest!, base64: Buffer.from("old content").toString("base64")}));
    if (fault === "source") test.setRecord({...test.getRecord(), preparation: {...test.input.material, runId: "other-run"}});
    if (fault === "unavailable") test.setRecord({...test.getRecord(), state: "expired"});
    if (fault === "pin") test.records.pinFileMaterial.mockRejectedValue(new Error("execution_storage_acknowledgement_unknown"));
    await expect(restoreBoundFileContent(test.input)).rejects.toThrow();
    expect(test.input.markEffectStarted).not.toHaveBeenCalled();
    expect((await readFile(test.path)).toString()).toBe("changed content");
  });

  it.each([false, true])("rechecks ancestry and bytes after retention, before write or removal (%s)", async absent => {
    const test = await fixture(absent ? null : Buffer.from("old content"));
    const check = vi.fn(async () => {});
    check.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("ancestry_changed"));
    await expect(restoreBoundFileContent({...test.input, revalidateTarget: check})).rejects.toThrow("ancestry_changed");
    expect(test.input.markEffectStarted).not.toHaveBeenCalled();
    await expect(restoreBoundFileContent({...test.input, retainPreimage: async () => {await writeFile(test.path, "overlapping change");}}))
      .rejects.toMatchObject({code: "file_target_changed"});
    expect(test.input.markEffectStarted).not.toHaveBeenCalled();
    expect((await readFile(test.path)).toString()).toBe("overlapping change");
  });
});
