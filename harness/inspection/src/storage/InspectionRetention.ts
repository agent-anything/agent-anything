import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync } from "node:fs";
import { scanInspectionSource } from "./InspectionStorageScan.js";
import { atomicInspectionJson, containedInspectionPath, datasetDirectory, validateOpaqueId, type InspectionDatasetManifest } from "../sources/index.js";
import { acquireInspectionRetirement } from "./InspectionDatasetAccess.js";
import { INSPECTION_FORMAT_VERSION } from "../records/index.js";

export interface InspectionRetirement { readonly datasetId: string; readonly status: "removed" | "eligible" | "active" | "unavailable" }

// Only a writer's closed manifest authorizes retirement. A stale heartbeat does not.
export function retireInspectionDatasets(root: string, sourceId: string, options: { readonly before: string; readonly apply: boolean; readonly datasetId?: string }): InspectionRetirement[] {
  validateOpaqueId(sourceId);
  if (!Number.isFinite(Date.parse(options.before))) throw new Error("inspection_retention_invalid");
  const path = containedInspectionPath(root, "sources", sourceId, "datasets");
  if (!existsSync(path)) return [];
  const entries = options.datasetId ? [options.datasetId] : readdirSync(path).slice(0, 1000);
  return entries.map((datasetId) => {
    try {
      const directory = datasetDirectory(root, sourceId, datasetId);
      const manifestPath = containedInspectionPath(root, "sources", sourceId, "datasets", datasetId, "manifest.json");
      if (statSync(manifestPath).size > 64 * 1024) throw new Error("inspection_manifest_invalid");
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as InspectionDatasetManifest;
      if (manifest.formatVersion !== INSPECTION_FORMAT_VERSION || manifest.sourceId !== sourceId || manifest.datasetId !== datasetId) throw new Error("inspection_manifest_invalid");
      if (manifest.status !== "closed") return { datasetId, status: "active" as const };
      if (Date.parse(manifest.createdAt) >= Date.parse(options.before)) return { datasetId, status: "unavailable" as const };
      if (!options.apply) return { datasetId, status: "eligible" as const };
      // The absolute directory was validated under the configured Inspection root.
      // Removal failure (including a live reader lock) is reported, never retried forcefully.
      const release = acquireInspectionRetirement(directory);
      if (!release) return { datasetId, status: "active" as const };
      try { rmSync(directory, { recursive: true, force: false, maxRetries: 0 }); }
      finally { release(); }
      recordRetirement(root, sourceId, datasetId);
      return { datasetId, status: "removed" as const };
    } catch { return { datasetId, status: "unavailable" as const }; }
  });
}

function recordRetirement(root: string, sourceId: string, datasetId: string): void {
  const directory = containedInspectionPath(root, "sources", sourceId, "retirements");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  atomicInspectionJson(containedInspectionPath(directory, datasetId + ".json"), { sourceId, datasetId, retiredAt: new Date().toISOString() });
  const receipts = readdirSync(directory).filter((name) => /^[a-zA-Z0-9_-]{1,128}\.json$/.test(name))
    .map((name) => ({ path: containedInspectionPath(directory, name), time: statSync(containedInspectionPath(directory, name)).mtimeMs }))
    .sort((left, right) => right.time - left.time);
  for (const receipt of receipts.slice(1000)) unlinkSync(receipt.path);
}

export function wasInspectionDatasetRetired(root: string, sourceId: string, datasetId: string): boolean {
  validateOpaqueId(sourceId); validateOpaqueId(datasetId);
  try {
    const file = containedInspectionPath(root, "sources", sourceId, "retirements", datasetId + ".json");
    if (statSync(file).size > 1024) return false;
    const receipt = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    return receipt.sourceId === sourceId && receipt.datasetId === datasetId && typeof receipt.retiredAt === "string" && Number.isFinite(Date.parse(receipt.retiredAt));
  } catch { return false; }
}

export function inspectionSourceBytes(root: string, sourceId: string): number {
  return scanInspectionSource(root, sourceId).bytes;
}
