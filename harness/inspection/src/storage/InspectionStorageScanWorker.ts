import { parentPort, workerData } from "node:worker_threads";
import { existsSync, readdirSync } from "node:fs";
import { containedInspectionPath } from "../sources/index.js";
import { retireInspectionDatasets } from "./InspectionRetention.js";
import { scanInspectionSource } from "./InspectionStorageScan.js";

try {
  let completed = 0;
  if (workerData.retireBefore) {
    const directory = containedInspectionPath(workerData.root, "sources", workerData.sourceId, "datasets");
    const entries = existsSync(directory) ? readdirSync(directory).slice(0, 1000) : [];
    for (const datasetId of entries) {
      retireInspectionDatasets(workerData.root, workerData.sourceId, { before: workerData.retireBefore, apply: true, datasetId });
      parentPort!.postMessage({ kind: "progress", completed: ++completed });
    }
  }
  const measurement = scanInspectionSource(workerData.root, workerData.sourceId, workerData.datasetId,
    (visited) => parentPort!.postMessage({ kind: "progress", completed: completed + visited }));
  parentPort!.postMessage({ kind: "measured", measurement });
} catch (error) {
  const code = error instanceof Error && ["inspection_path_invalid", "inspection_storage_scan_limit"].includes(error.message) ? error.message : "inspection_storage_scan_failed";
  parentPort!.postMessage({ kind: "failed", code });
} finally { parentPort!.close(); }
