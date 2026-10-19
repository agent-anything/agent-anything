import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { open, writeFile, readFile } from "node:fs/promises";
import Database from "better-sqlite3";
import { captureFilePreimage, restoreBoundFileContent, FILE_MATERIAL_POLICY, type FileMaterialPreparation, type FileMaterialRecord, type FileMaterialRecordPort, type FileMaterialObservation } from "@agent-anything/helarc-local-environment/filesystem";
import type { InspectionRecorder } from "@agent-anything/inspection/recording";
import { FileMaterialInspectionAdapter } from "../inspection/FileMaterialInspectionAdapter.js";
import { ExecutionDatabase } from "./ExecutionDatabase.js";
import { HelarcExecutionStore } from "./HelarcExecutionStore.js";

const directories: string[] = [];
const stores: {close(): void | Promise<void>}[] = [];
afterEach(async () => {for (const store of stores.splice(0).reverse()) await store.close(); for (const path of directories.splice(0)) rmSync(path, {recursive: true});});
function directory() {const path = mkdtempSync(join(tmpdir(), "file-material-")); directories.push(path); return path;}
const at = "2026-10-15T00:00:00.000Z";
const later = "2026-10-25T00:00:00.000Z";
function digest(bytes: Uint8Array) {return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;}
function preparation(bytes: Uint8Array, id = "material-1", absent = false): FileMaterialPreparation {
  return {ref: {owner: "helarc-files", kind: "material", id, revision: "1"}, policyRevision: FILE_MATERIAL_POLICY.revision,
    runId: "run-1", invocation: {id: "invocation-1", operation: {operation: {namespace: "files", name: "write"}, revision: "1"}},
    attempt: {id: "attempt-1", action: {id: "action-1"}, ordinal: 1},
    target: {canonicalPath: "C:/workspace/file.txt", rootIdentity: "root-1", ancestryIdentity: "ancestry-1"},
    before: absent ? {kind: "absent"} : {kind: "present", entryKind: "file", objectIdentity: {kind: "win32", volumeId: "1", fileId: "2"}, contentDigest: digest(bytes)},
    byteLength: bytes.byteLength, readAuthorityRef: "permission-read-1", preparedAt: at};
}

// Includes process restart and durable chunk writes through the actual Worker.
describe("file material owner persistence", {timeout: 20_000}, () => {
  it("restores retained bytes after Worker restart and keeps the compensating Run pin", async () => {
    const root = directory(), path = join(root, "restored.bin"), bytes = Buffer.alloc(150_000, 0xAD);
    await writeFile(path, bytes);
    const worker = pathToFileURL(join(process.cwd(), "dist/main/execution-storage/ExecutionStoreWorker.js"));
    const first = await HelarcExecutionStore.open(join(root, "store"), worker); stores.push(first);
    const handle = await open(path, "r+");
    let actual: FileMaterialPreparation;
    try {
      const info = await handle.stat(), prep = preparation(bytes);
      actual = {...prep, target: {...prep.target, canonicalPath: path}, before: {kind: "present", entryKind: "file",
        objectIdentity: {kind: "posix", deviceId: String(info.dev), inode: String(info.ino)}, contentDigest: digest(bytes)}};
      await captureFilePreimage({preparation: actual, handle, records: first, interruption: new AbortController().signal, now: () => at});
      await handle.write(Buffer.from("changed"), 0, 7, 0);
      await handle.truncate(7);
      await handle.sync();
    } finally {await handle.close();}
    await first.close();
    const restored = await HelarcExecutionStore.open(join(root, "store"), worker); stores.push(restored);
    const started = vi.fn(), revalidateTarget = vi.fn(async () => {});
    const before = actual!.before;
    if (before.kind !== "present") throw new Error("This test requires an existing original file.");
    const result = await restoreBoundFileContent({material: actual!, after: {...before, contentDigest: digest(Buffer.from("changed"))},
      runId: "restoring-run", records: restored, signal: new AbortController().signal, revalidateTarget, markEffectStarted: started});
    expect(result).toMatchObject({kind: "content", byteLength: bytes.length, digest: digest(bytes), after: {kind: "present", contentDigest: digest(bytes)}});
    expect(await readFile(path)).toEqual(bytes);
    expect(started).toHaveBeenCalledTimes(1);
    expect(revalidateTarget).toHaveBeenCalledTimes(2);
    await restored.close();
    const final = new ExecutionDatabase(join(root, "store")); stores.push(final);
    expect(final.fileMaterialCommand(final.generation, {kind: "read", reference: actual!.ref})).toMatchObject({state: "available", pins: ["run-1", "restoring-run"]});
  }, 20_000);

  it("expires retained material in bounded batches without dropping later candidates", () => {
    const store = new ExecutionDatabase(directory()); stores.push(store);
    const bytes = Buffer.alloc(0);
    for (let index = 0; index < FILE_MATERIAL_POLICY.expiryBatchSize + 1; index++) {
      const prep = preparation(bytes, `expiry-${index}`);
      store.fileMaterialCommand(store.generation, {kind: "reserve", preparation: prep});
      store.fileMaterialCommand(store.generation, {kind: "publish", reference: prep.ref, digest: digest(bytes), at});
      store.fileMaterialCommand(store.generation, {kind: "release", reference: prep.ref, ownerId: "run-1", at});
    }
    expect(store.fileMaterialCommand(store.generation, {kind: "expire", at: later})).toHaveLength(FILE_MATERIAL_POLICY.expiryBatchSize);
    expect(store.fileMaterialCommand(store.generation, {kind: "expire", at: later})).toHaveLength(1);
    expect(store.fileMaterialCommand(store.generation, {kind: "expire", at: later})).toHaveLength(0);
  });

  it("stages bounded chunks and only publishes complete, verified bytes", () => {
    const store = new ExecutionDatabase(directory()); stores.push(store);
    const command = (value: Parameters<ExecutionDatabase["fileMaterialCommand"]>[1]) => store.fileMaterialCommand(store.generation, value);
    const bytes = Buffer.alloc(FILE_MATERIAL_POLICY.chunkBytes + 57, 0xAD), prep = preparation(bytes);
    expect(command({kind: "reserve", preparation: prep})).toMatchObject({status: "reserved", record: {state: "staging"}});
    expect(() => command({kind: "read_range", reference: prep.ref, offset: 0, length: 1})).toThrow("file_material_content_unavailable");
    const first = bytes.subarray(0, FILE_MATERIAL_POLICY.chunkBytes).toString("base64");
    command({kind: "append", reference: prep.ref, offset: 0, base64: first});
    command({kind: "append", reference: prep.ref, offset: 0, base64: first});
    expect(() => command({kind: "publish", reference: prep.ref, digest: digest(bytes), at})).toThrow("file_material_incomplete");
    command({kind: "append", reference: prep.ref, offset: FILE_MATERIAL_POLICY.chunkBytes, base64: bytes.subarray(FILE_MATERIAL_POLICY.chunkBytes).toString("base64")});
    expect(command({kind: "publish", reference: prep.ref, digest: digest(bytes), at})).toMatchObject({state: "available", digest: digest(bytes)});
    expect(command({kind: "read_range", reference: prep.ref, offset: FILE_MATERIAL_POLICY.chunkBytes - 3, length: 60})).toMatchObject({base64: bytes.subarray(-60).toString("base64"), byteLength: 60});
    expect(() => command({kind: "read_range", reference: prep.ref, offset: 0, length: FILE_MATERIAL_POLICY.readBytes + 1})).toThrow("file_material_range_invalid");
    expect(() => command({kind: "abort", reference: prep.ref, reason: "cleanup", at})).toThrow("file_material_stage_invalid");
  });

  it("persists zero-byte content and absence as distinct material, neither inferred from missing bytes", () => {
    const store = new ExecutionDatabase(directory()); stores.push(store);
    for (const absent of [false, true]) {
      const prep = preparation(Buffer.alloc(0), String(absent), absent);
      store.fileMaterialCommand(store.generation, {kind: "reserve", preparation: prep});
      store.fileMaterialCommand(store.generation, {kind: "publish", reference: prep.ref, digest: digest(Buffer.alloc(0)), at});
      const read = () => store.fileMaterialCommand(store.generation, {kind: "read_range", reference: prep.ref, offset: 0, length: 10});
      if (absent) expect(read).toThrow("file_material_content_unavailable"); else expect(read()).toMatchObject({byteLength: 0, base64: ""});
    }
  });

  it("bounds optional capture, preserves pins, and expires only explicitly released material", () => {
    const store = new ExecutionDatabase(directory()); stores.push(store);
    const command = (value: Parameters<ExecutionDatabase["fileMaterialCommand"]>[1]) => store.fileMaterialCommand(store.generation, value);
    const bytes = Buffer.from("original bytes"), prep = preparation(bytes);
    expect(command({kind: "reserve", preparation: {...prep, byteLength: FILE_MATERIAL_POLICY.maxFileBytes + 1}})).toEqual({status: "unavailable", reason: "file_size_limit"});
    command({kind: "reserve", preparation: prep});
    for (let i = 1; i < 4; i++) command({kind: "reserve", preparation: preparation(bytes, `extra-${i}`)});
    expect(command({kind: "reserve", preparation: preparation(bytes, "overflow")})).toEqual({status: "unavailable", reason: "capture_capacity"});
    command({kind: "append", reference: prep.ref, offset: 0, base64: bytes.toString("base64")});
    command({kind: "publish", reference: prep.ref, digest: digest(bytes), at});
    command({kind: "pin", reference: prep.ref, ownerId: "restoring-run"});
    expect(command({kind: "expire", at: later})).toEqual([]);
    command({kind: "release", reference: prep.ref, ownerId: "run-1", at});
    expect(command({kind: "expire", at: later})).toEqual([]);
    command({kind: "release", reference: prep.ref, ownerId: "restoring-run", at});
    expect(command({kind: "expire", at: later})).toHaveLength(1);
    expect(command({kind: "read", reference: prep.ref})).toMatchObject({state: "expired", reason: "retention_expired", preparation: prep});
    expect(() => command({kind: "pin", reference: prep.ref, ownerId: "late-reader"})).toThrow("file_material_content_unavailable");
    expect(store.listRetentionPins()).toContainEqual({ownerId: "run-1", reason: "file_material"});
  });

  it("rejects altered pre-state, out-of-order chunks and damaged retained bytes", () => {
    const path = directory(), store = new ExecutionDatabase(path); stores.push(store);
    const bytes = Buffer.from("before"), prep = preparation(bytes);
    store.fileMaterialCommand(store.generation, {kind: "reserve", preparation: prep});
    expect(() => store.fileMaterialCommand(store.generation, {kind: "reserve", preparation: {...prep, readAuthorityRef: "another-grant"}})).toThrow("file_material_identity_conflict");
    expect(() => store.fileMaterialCommand(store.generation, {kind: "append", reference: prep.ref, offset: 1, base64: bytes.toString("base64")})).toThrow();
    store.fileMaterialCommand(store.generation, {kind: "append", reference: prep.ref, offset: 0, base64: bytes.toString("base64")});
    store.fileMaterialCommand(store.generation, {kind: "publish", reference: prep.ref, digest: digest(bytes), at});
    const database = new Database(join(path, "execution.sqlite"));
    database.prepare("UPDATE file_material_chunks SET bytes=?").run(Buffer.from("broken")); database.close();
    expect(() => store.fileMaterialCommand(store.generation, {kind: "read_range", reference: prep.ref, offset: 0, length: 2})).toThrow("file_material_corrupt");
  });

  it("recovers published and interrupted staging through a real Worker restart without silently unpinning", async () => {
    const path = directory();
    const worker = pathToFileURL(join(process.cwd(), "dist/main/execution-storage/ExecutionStoreWorker.js"));
    const first = await HelarcExecutionStore.open(path, worker); stores.push(first);
    const bytes = Buffer.from("durable original"), prep = preparation(bytes), unfinished = preparation(bytes, "unfinished");
    await first.reserveFileMaterial(prep);
    await first.appendFileMaterial(prep.ref, 0, bytes.toString("base64"));
    await first.publishFileMaterial(prep.ref, digest(bytes), at);
    await first.reserveFileMaterial(unfinished);
    await first.appendFileMaterial(unfinished.ref, 0, bytes.subarray(0, 3).toString("base64"));
    await first.close();
    const restored = await HelarcExecutionStore.open(path, worker); stores.push(restored);
    expect(await restored.readFileMaterialRange(prep.ref, 0, 64)).toMatchObject({base64: bytes.toString("base64")});
    expect(await restored.readFileMaterialRecord(unfinished.ref)).toMatchObject({state: "staging", pins: ["run-1"]});
    await expect(restored.readFileMaterialRange(unfinished.ref, 0, 64)).rejects.toMatchObject({code: "file_material_content_unavailable"});
    await restored.abortFileMaterial(unfinished.ref, "owner_confirmed_no_mutation", later);
    expect((await restored.readFileMaterialRecord(unfinished.ref)) as FileMaterialRecord).toMatchObject({state: "aborted", pins: [], reason: "owner_confirmed_no_mutation"});
  });

  it("streams a real preimage into the Worker and observes metadata without disclosing its protected bytes", async () => {
    const root = directory(), path = join(root, "file.txt");
    const bytes = Buffer.alloc(150_000, 0x9F);
    await writeFile(path, bytes);
    const handle = await open(path, "r+");
    const offer = vi.fn();
    const observer = new FileMaterialInspectionAdapter({offer, ref: (owner: string, kind: string, id: string, runId: string | null, revision?: string) =>
      ({owner, kind, id, runId, revision: revision ?? null})} as unknown as InspectionRecorder);
    const worker = pathToFileURL(join(process.cwd(), "dist/main/execution-storage/ExecutionStoreWorker.js"));
    const store = await HelarcExecutionStore.open(join(root, "owner-store"), worker, undefined, observer); stores.push(store);
    try {
      const info = await handle.stat();
      const prep = preparation(bytes);
      const actual: FileMaterialPreparation = {...prep, target: {...prep.target, canonicalPath: path},
        before: {kind: "present", entryKind: "file", objectIdentity: {kind: "posix", deviceId: String(info.dev), inode: String(info.ino)}, contentDigest: digest(bytes)}};
      expect(await captureFilePreimage({preparation: actual, handle, records: store, interruption: new AbortController().signal, now: () => at})).toMatchObject({status: "available"});
      expect(await readFile(path)).toEqual(bytes);
      expect((await store.readFileMaterialRange(prep.ref, 65_000, 500)).base64).toBe(bytes.subarray(65_000, 65_500).toString("base64"));
      expect(offer.mock.calls.map(([event]) => event.payload.name)).toEqual(["file.material.reserved.acknowledged", "file.material.published.acknowledged"]);
      expect(offer.mock.calls[1]![0].links[1].from.id).toBe("action-1:attempt-1");
      const content = offer.mock.calls[1]![0].contents[0].value;
      expect(content).toMatchObject({state: "available", byteLength: bytes.length, digest: digest(bytes), pinCount: 1});
      expect(content).not.toHaveProperty("base64"); expect(content).not.toHaveProperty("target");
      expect(await captureFilePreimage({preparation: actual, handle, records: store, interruption: new AbortController().signal, now: () => at}))
        .toMatchObject({status: "available"});
      await handle.write(Buffer.from([0x00]), 0, 1, 0);
      await expect(captureFilePreimage({preparation: actual, handle, records: store, interruption: new AbortController().signal, now: () => at}))
        .rejects.toMatchObject({code: "file_target_changed"});
      expect(await store.readFileMaterialRecord(prep.ref)).toMatchObject({state: "available", digest: digest(bytes)});
      expect((await store.readFileMaterialRange(prep.ref, 0, 1)).base64).toBe(bytes.subarray(0, 1).toString("base64"));
    } finally {await handle.close();}
  });

  it("does not swallow storage failure as optional capture unavailability or publish a changed preimage", async () => {
    const root = directory(), path = join(root, "file.txt"), bytes = Buffer.from("original");
    await writeFile(path, bytes);
    const handle = await open(path, "r+");
    const worker = pathToFileURL(join(process.cwd(), "dist/main/execution-storage/ExecutionStoreWorker.js"));
    const observed: FileMaterialObservation[] = [];
    const store = await HelarcExecutionStore.open(join(root, "store"), worker, undefined, {observe: value => {observed.push(value); throw new Error("observer failure");}}); stores.push(store);
    try {
      const info = await handle.stat(), prep = preparation(bytes);
      const actual: FileMaterialPreparation = {...prep, target: {...prep.target, canonicalPath: path},
        before: {kind: "present", entryKind: "file", objectIdentity: {kind: "posix", deviceId: String(info.dev), inode: String(info.ino)}, contentDigest: digest(bytes)}};
      const fault = new Error("execution_storage_acknowledgement_unknown");
      const failing = {reserveFileMaterial: store.reserveFileMaterial.bind(store), appendFileMaterial: async () => {throw fault;}} as unknown as FileMaterialRecordPort;
      await expect(captureFilePreimage({preparation: actual, handle, records: failing, interruption: new AbortController().signal, now: () => at})).rejects.toBe(fault);
      expect(await store.readFileMaterialRecord(prep.ref)).toMatchObject({state: "staging", pins: ["run-1"]});
      await store.abortFileMaterial(prep.ref, "pre_effect_capture_not_completed", at);
      const next = {...actual, ref: {...actual.ref, id: "changed-during-capture"}};
      const changed = {reserveFileMaterial: store.reserveFileMaterial.bind(store), abortFileMaterial: store.abortFileMaterial.bind(store),
        appendFileMaterial: async (...args: Parameters<FileMaterialRecordPort["appendFileMaterial"]>) => {await store.appendFileMaterial(...args); await handle.write(Buffer.from("modified"), 0, 8, 0);}} as unknown as FileMaterialRecordPort;
      await expect(captureFilePreimage({preparation: next, handle, records: changed, interruption: new AbortController().signal, now: () => at})).rejects.toMatchObject({code: "file_target_changed"});
      expect(await store.readFileMaterialRecord(next.ref)).toMatchObject({state: "aborted", reason: "file_target_changed"});
      expect(observed.some(value => value.kind === "published")).toBe(false);
    } finally {await handle.close();}
  });
});
