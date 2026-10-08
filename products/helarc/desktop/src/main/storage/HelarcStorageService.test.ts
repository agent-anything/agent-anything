import { afterEach, expect, it } from "vitest";
import { mkdir, mkdtemp, writeFile, rm, access, symlink } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { registerInspectionSource, datasetDirectory, atomicInspectionJson } from "@agent-anything/inspection/sources";
import { INSPECTION_FORMAT_VERSION } from "@agent-anything/inspection/records";
import { HelarcStorageService } from "./HelarcStorageService.js";
import { measureHelarcStorage } from "./HelarcStorageUsage.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) {
  if (!relative(tmpdir(), resolve(root)).startsWith("helarc-storage-")) throw new Error("Unsafe test cleanup");
  await rm(root, { recursive: true, force: true });
} });
async function setup() { const root = await mkdtemp(join(tmpdir(), "helarc-storage-")); roots.push(root); return root; }

it("lists local categories and cleans only selected closed Helarc recordings", async () => {
  const root = await setup(); const userData = join(root, "user-data"); const inspection = join(root, "inspection");
  await mkdir(userData); await writeFile(join(userData, "threads.json"), "thread content");
  await mkdir(join(userData, "command-output")); await writeFile(join(userData, "command-output", "stdout.txt"), "output");
  const source = registerInspectionSource(inspection, "helarc-desktop", "Helarc");
  const other = registerInspectionSource(inspection, "another-app", "Other");
  for (const [id, status, sourceId] of [["closed", "closed", source.sourceId], ["open", "open", source.sourceId], ["other", "closed", other.sourceId]] as const) {
    const directory = datasetDirectory(inspection, sourceId, id); await mkdir(directory, { recursive: true });
    atomicInspectionJson(join(directory, "manifest.json"), { formatVersion: INSPECTION_FORMAT_VERSION, datasetId: id, sourceId, status, producerInstanceId: "test", createdAt: "2020-01-01T00:00:00.000Z" });
    await writeFile(join(directory, "content.txt"), "diagnostic data");
  }
  const service = new HelarcStorageService(userData, () => ({ available: true, queued: 0, dropped: 0, rejected: 0, code: null }), inspection);
  try {
    const before = await service.snapshot();
    expect(before.categories.find(c => c.id === "conversations")?.bytes).toBe(14);
    expect(before.inspection.recordings).toHaveLength(2);
    expect(await service.cleanup(["closed", "open"])).toEqual({ recordings: [{ id: "closed", status: "removed" }, { id: "open", status: "protected" }] });
    const after = await service.snapshot();
    expect(after.inspection.recordings.map(r => r.id)).toEqual(["open"]);
    expect(after.inspection.bytes!).toBeLessThan(before.inspection.bytes!);
    await access(join(userData, "threads.json")); await access(datasetDirectory(inspection, other.sourceId, "other"));
    expect(() => service.cleanup(["../outside"])).toThrow();
  } finally { service.close(); }
});

it("reports unavailable linked data rather than traversing or deleting it", async () => {
  const root = await setup(); const userData = join(root, "user-data"); const external = join(root, "external");
  await mkdir(userData); await mkdir(external); await writeFile(join(external, "secret"), "private");
  await symlink(external, join(userData, "command-output"), "junction");
  const result = await measureHelarcStorage(userData);
  expect(result.categories.find(c => c.id === "command-output")).toMatchObject({ bytes: null, files: 0 });
  expect(result.issues).toHaveLength(1);
});
