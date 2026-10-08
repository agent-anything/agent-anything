import { afterEach, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { atomicInspectionJson, datasetDirectory, registerInspectionSource } from "../sources/index.js";
import { readInspectionStorageInventory, maintainInspectionStorage } from "./InspectionStorageInventory.js";
import { retireInspectionDatasets } from "./InspectionRetention.js";
import { acquireInspectionReadLease } from "./InspectionDatasetAccess.js";
import { InspectionDatabase } from "./InspectionDatabase.js";
import { closeFailedInspectionRecording } from "../recording/InspectionRecordingFinalization.js";
import { INSPECTION_FORMAT_VERSION } from "../records/index.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) {
  if (!relative(tmpdir(), resolve(root)).startsWith("inspection-inventory-")) throw new Error("Unsafe test cleanup");
  rmSync(root, { recursive: true, force: true });
} });
function setup() {
  const root = mkdtempSync(join(tmpdir(), "inspection-inventory-")); roots.push(root);
  const source = registerInspectionSource(root, "test", "Test");
  const add = (id: string, status: "closed" | "open", createdAt: string) => {
    const directory = datasetDirectory(root, source.sourceId, id);
    mkdirSync(directory, { recursive: true });
    const manifest = { formatVersion: INSPECTION_FORMAT_VERSION, sourceId: source.sourceId, datasetId: id, producerInstanceId: id, createdAt, status };
    atomicInspectionJson(join(directory, "manifest.json"), manifest);
    writeFileSync(join(directory, "content"), "x".repeat(2048));
    return { directory, manifest };
  };
  return { root, sourceId: source.sourceId, add };
}

it("reclaims oldest eligible closed recordings to a target, preserving open and leased recordings", () => {
  const { root, sourceId, add } = setup();
  const open = add("open", "open", "2020-01-01T00:00:00.000Z");
  const leased = add("leased", "closed", "2020-01-02T00:00:00.000Z");
  const oldest = add("old", "closed", "2020-01-03T00:00:00.000Z");
  const recent = add("recent", "closed", "2020-01-04T00:00:00.000Z");
  const inventory = readInspectionStorageInventory(root, sourceId);
  const release = acquireInspectionReadLease(leased.directory);
  try {
    const target = inventory.bytes - inventory.recordings.find(r => r.datasetId === "old")!.bytes;
    expect(maintainInspectionStorage(root, sourceId, { targetBytes: target }).bytes).toBeLessThanOrEqual(target + 512);
    expect(existsSync(open.directory)).toBe(true);
    expect(existsSync(leased.directory)).toBe(true);
    expect(existsSync(oldest.directory)).toBe(false);
    expect(existsSync(recent.directory)).toBe(true);
  } finally { release(); }
});

it("never infers closure from age and rejects corrupt manifest dates", () => {
  const { root, sourceId, add } = setup();
  const open = add("open", "open", "2020-01-01T00:00:00.000Z");
  const corrupt = add("corrupt", "closed", "not-a-date");
  const result = maintainInspectionStorage(root, sourceId, { targetBytes: 0, retireBefore: new Date().toISOString() });
  expect(result.bytes).toBeGreaterThan(0);
  expect(existsSync(open.directory)).toBe(true);
  expect(retireInspectionDatasets(root, sourceId, { datasetId: "corrupt", apply: true, before: new Date().toISOString() })[0]?.status).toBe("unavailable");
  expect(existsSync(corrupt.directory)).toBe(true);
  expect(readInspectionStorageInventory(root, sourceId).recordings.find(r => r.datasetId === "corrupt")?.status).toBe("unavailable");
});

it("closes a failed writer, retains the capture gap and permits deliberate retirement", () => {
  const { root, sourceId } = setup();
  const directory = datasetDirectory(root, sourceId, "failed");
  const manifest = { formatVersion: INSPECTION_FORMAT_VERSION, sourceId, datasetId: "failed", producerInstanceId: "test", createdAt: "2020-01-01T00:00:00.000Z", status: "open" as const };
  const db = new InspectionDatabase(directory, manifest);
  atomicInspectionJson(join(directory, "manifest.json"), manifest);
  closeFailedInspectionRecording(db, directory, manifest, "inspection_storage_budget_exhausted");
  expect(JSON.parse(readFileSync(join(directory, "manifest.json"), "utf8"))).toMatchObject({ status: "closed", captureFailure: "inspection_storage_budget_exhausted" });
  const reader = new InspectionDatabase(directory);
  try { expect(reader.snapshot()).toMatchObject({ status: "closed", limitations: ["storage_budget_exhausted", "capture_tail_unknown"] }); }
  finally { reader.close(); }
  expect(readInspectionStorageInventory(root, sourceId).recordings[0]).toMatchObject({ status: "closed", captureFailure: "inspection_storage_budget_exhausted" });
  expect(retireInspectionDatasets(root, sourceId, { datasetId: "failed", apply: true, before: new Date().toISOString() })[0]?.status).toBe("removed");
});
