import { afterEach, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, rmdirSync, symlinkSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { scanInspectionSource } from "./InspectionStorageScan.js";
import { InspectionStorageMaintenance } from "../../dist/storage/InspectionStorageMaintenance.js";
import { InspectionStorageUsage } from "./InspectionStorageUsage.js";
import { InspectionDatabase } from "./InspectionDatabase.js";
import { registerInspectionSource, datasetDirectory, atomicInspectionJson } from "../sources/index.js";
import { INSPECTION_FORMAT_VERSION, type InspectionRecord } from "../records/index.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    if (!relative(tmpdir(), resolve(root)).startsWith("inspection-accounting-")) throw new Error("Invalid cleanup target");
    rmSync(root, { recursive: true, force: true });
  }
});
function setup() {
  const root = mkdtempSync(join(tmpdir(), "inspection-accounting-")); roots.push(root);
  const source = registerInspectionSource(root, "test", "Test");
  const sourcePath = join(root, "sources", source.sourceId);
  return { root, source, sourcePath };
}

it("measures all file kinds and reports bounded completed-work progress", () => {
  const { root, source, sourcePath } = setup();
  const directory = datasetDirectory(root, source.sourceId, "active");
  mkdirSync(join(directory, "staging"), { recursive: true });
  let expected = statSync(join(sourcePath, "source.json")).size;
  for (let i = 0; i < 300; i++) { writeFileSync(join(directory, "staging", String(i)), "abc"); expected += 3; }
  writeFileSync(join(directory, "inspection.sqlite-wal"), "wal"); expected += 3;
  const progress: number[] = [];
  const result = scanInspectionSource(root, source.sourceId, "active", count => progress.push(count));
  expect(result.bytes).toBe(expected);
  expect(result.datasetFiles).toHaveLength(301);
  expect(progress.length).toBeGreaterThan(2);
  expect(progress.at(-1)).toBe(result.visited);
});

it("rejects directory links, a replaced ancestor, and excessive depth", () => {
  const { root, source, sourcePath } = setup();
  const outside = join(root, "outside"); mkdirSync(outside); writeFileSync(join(outside, "secret"), "private");
  const link = join(sourcePath, "linked"); symlinkSync(outside, link, "junction");
  expect(() => scanInspectionSource(root, source.sourceId)).toThrow();
  rmdirSync(link);
  const content = join(sourcePath, "content"); mkdirSync(content);
  for (let i = 0; i < 140; i++) writeFileSync(join(content, String(i)), "x");
  let replaced = false;
  expect(() => scanInspectionSource(root, source.sourceId, undefined, () => {
    if (!replaced) { replaced = true; rmSync(content, { recursive: true }); symlinkSync(outside, content, "junction"); }
  })).toThrow();
  rmdirSync(content);
  let deep = sourcePath;
  for (let i = 0; i < 34; i++) { deep = join(deep, "d"); mkdirSync(deep); }
  expect(() => scanInspectionSource(root, source.sourceId)).toThrow("inspection_storage_scan_limit");
});

it("scans off-thread, disallows overlap, supports cancellation, and observes other writers and removal", async () => {
  const { root, source, sourcePath } = setup();
  const maintenance = new InspectionStorageMaintenance(root, source.sourceId);
  try {
    const first = maintenance.measure();
    await expect(maintenance.measure()).rejects.toThrow("inspection_storage_scan_overlap");
    const baseline = await first;
    const external = join(sourcePath, "other-writer"); writeFileSync(external, "new data");
    expect((await maintenance.measure()).bytes).toBe(baseline.bytes + 8);
    rmSync(external);
    expect((await maintenance.measure()).bytes).toBe(baseline.bytes);
    const pending = maintenance.measure();
    maintenance.close();
    await expect(pending).rejects.toThrow("inspection_storage_scan_cancelled");
    await expect(maintenance.measure()).rejects.toThrow("inspection_storage_scan_cancelled");
  } finally { maintenance.close(); }
});

it("accounts duplicates, rollback orphans, staged aborts and actual database/checkpoint sizes", () => {
  const { root, source } = setup();
  const usage = new InspectionStorageUsage(scanInspectionSource(root, source.sourceId));
  const directory = datasetDirectory(root, source.sourceId, "active");
  const manifest = { formatVersion: INSPECTION_FORMAT_VERSION, sourceId: source.sourceId, datasetId: "active", producerInstanceId: "test", createdAt: new Date().toISOString(), status: "open" as const };
  let abortStaging = false;
  const db = new InspectionDatabase(directory, manifest, (path, bytes) => {
    usage.physicalFileChanged(path, bytes);
    if (abortStaging && path.startsWith("staging") && bytes) throw new Error("staged write aborted");
  });
  const descriptor = { id: "body", name: "body", class: "agent" as const, stage: "test", mediaType: "text/plain" as const, availability: "present" as const, retainedBytes: 5, originalBytes: 5, digest: null, redacted: false, truncated: false };
  const record: InspectionRecord = { id: "r1", subject: { sourceId: source.sourceId, datasetId: "active", owner: "runtime", kind: "run", id: "run", runId: "run", revision: null }, payload: { kind: "event", name: "test", sequence: null, code: null }, occurredAt: null, capturedAt: manifest.createdAt, ownerSequence: null, captureSequence: 1, commitSequence: 0, policyRevision: "test", contents: [descriptor], links: [] };
  try {
    atomicInspectionJson(join(directory, "manifest.json"), manifest);
    db.write(record, [{ descriptor, text: "hello" }]);
    usage.refreshDatabase(directory);
    const beforeDuplicate = usage.datasetBytes;
    expect(db.write(record, [{ descriptor, text: "hello" }]).duplicate).toBe(true);
    usage.refreshDatabase(directory);
    expect(usage.datasetBytes).toBe(beforeDuplicate);
    const orphan = { ...descriptor, id: "orphan" };
    expect(() => db.writeBatch(() => {
      db.write({ ...record, id: "r2", contents: [orphan] }, [{ descriptor: orphan, text: "hello" }]);
      throw new Error("rollback");
    })).toThrow("rollback");
    expect(db.record("r2", db.snapshot().watermark)).toBeNull();
    expect(readFileSync(join(directory, "content", "orphan"), "utf8")).toBe("hello");
    abortStaging = true;
    const staged = { ...descriptor, id: "staged" };
    expect(() => db.write({ ...record, id: "r3", contents: [staged] }, [{ descriptor: staged, text: "hello" }])).toThrow("staged write aborted");
    expect(readFileSync(join(directory, "staging", "staged"), "utf8")).toBe("hello");
    db.checkpoint(); usage.refreshDatabase(directory);
    expect(usage.sourceBytes).toBe(scanInspectionSource(root, source.sourceId).bytes);
    db.close(); usage.refreshDatabase(directory);
    expect(usage.sourceBytes).toBe(scanInspectionSource(root, source.sourceId).bytes);
  } finally { try { db.close(); } catch { /* Already closed for the checkpoint test. */ } }
});
