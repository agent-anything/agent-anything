import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { containedInspectionPath, type InspectionDatasetManifest, validateOpaqueId } from "../sources/index.js";
import { INSPECTION_FORMAT_VERSION } from "../records/index.js";
import { scanInspectionSource, type InspectionStorageMeasurement } from "./InspectionStorageScan.js";
import { retireInspectionDatasets } from "./InspectionRetention.js";

export interface InspectionRecordingUsage {
  readonly datasetId: string;
  readonly createdAt: string | null;
  readonly bytes: number;
  readonly status: "open" | "closed" | "unavailable";
  readonly captureFailure: string | null;
}
export interface InspectionStorageInventory {
  readonly sourceId: string;
  readonly bytes: number;
  readonly recordings: readonly InspectionRecordingUsage[];
}

export function readInspectionStorageInventory(root: string, sourceId: string, progress?: (visited: number) => void): InspectionStorageInventory {
  validateOpaqueId(sourceId);
  const source = containedInspectionPath(root, "sources", sourceId);
  if (!existsSync(source)) return { sourceId, bytes: 0, recordings: [] };
  return inventoryFromMeasurement(root, sourceId, scanInspectionSource(root, sourceId, undefined, progress));
}

function inventoryFromMeasurement(root: string, sourceId: string, measurement: InspectionStorageMeasurement): InspectionStorageInventory {
  const path = containedInspectionPath(root, "sources", sourceId, "datasets");
  const entries = existsSync(path) ? readdirSync(path) : [];
  if (entries.length > 1000) throw new Error("inspection_storage_scan_limit");
  const sizes = new Map(measurement.datasetBytes);
  const recordings = entries.map((datasetId): InspectionRecordingUsage => {
    const bytes = sizes.get(datasetId) ?? 0;
    try {
      validateOpaqueId(datasetId);
      const file = containedInspectionPath(path, datasetId, "manifest.json");
      if (statSync(file).size > 64 * 1024) throw new Error("inspection_manifest_invalid");
      const manifest = JSON.parse(readFileSync(file, "utf8")) as InspectionDatasetManifest;
      if (manifest.formatVersion !== INSPECTION_FORMAT_VERSION || manifest.sourceId !== sourceId ||
          manifest.datasetId !== datasetId || !Number.isFinite(Date.parse(manifest.createdAt)) ||
          !["open", "closed"].includes(manifest.status)) throw new Error("inspection_manifest_invalid");
      return { datasetId, bytes, createdAt: manifest.createdAt, status: manifest.status,
        captureFailure: typeof manifest.captureFailure === "string" && /^inspection_[a-z_]{1,80}$/.test(manifest.captureFailure) ? manifest.captureFailure : null };
    } catch { return { datasetId, bytes, createdAt: null, status: "unavailable", captureFailure: null }; }
  });
  return { sourceId, bytes: measurement.bytes, recordings: recordings.sort((a, b) =>
    (b.createdAt === null ? 0 : Date.parse(b.createdAt)) - (a.createdAt === null ? 0 : Date.parse(a.createdAt)) || a.datasetId.localeCompare(b.datasetId)) };
}

export function maintainInspectionStorage(root: string, sourceId: string, options: {
  readonly datasetId?: string; readonly retireBefore?: string; readonly targetBytes?: number;
  readonly progress?: (completed: number) => void;
}): InspectionStorageMeasurement {
  let completed = 0;
  let measurement = scanInspectionSource(root, sourceId, options.datasetId, options.progress);
  completed += measurement.visited;
  const inventory = inventoryFromMeasurement(root, sourceId, measurement);
  let remaining = measurement.bytes;
  let removed = false;
  for (const recording of [...inventory.recordings].reverse()) {
    if (recording.datasetId === options.datasetId || recording.status !== "closed") continue;
    const expired = options.retireBefore !== undefined && Date.parse(recording.createdAt!) < Date.parse(options.retireBefore);
    const pressure = options.targetBytes !== undefined && remaining > options.targetBytes;
    if (!expired && !pressure) continue;
    const result = retireInspectionDatasets(root, sourceId, { datasetId: recording.datasetId, before: new Date().toISOString(), apply: true });
    if (result[0]?.status === "removed") { remaining -= recording.bytes; removed = true; }
    options.progress?.(++completed);
  }
  if (removed) measurement = scanInspectionSource(root, sourceId, options.datasetId, visited => options.progress?.(completed + visited));
  return measurement;
}
