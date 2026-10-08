import { parentPort, workerData } from "node:worker_threads";
import { retireInspectionDatasets } from "./InspectionRetention.js";
import { maintainInspectionStorage, readInspectionStorageInventory } from "./InspectionStorageInventory.js";

try {
  const progress = (completed: number) => parentPort!.postMessage({ kind: "progress", completed });
  let result: unknown;
  if (workerData.kind === "inventory") {
    result = readInspectionStorageInventory(workerData.root, workerData.sourceId, progress);
  } else if (workerData.kind === "retire") {
    if (!Array.isArray(workerData.datasetIds) || workerData.datasetIds.length > 1000) throw new Error("inspection_retention_invalid");
    result = workerData.datasetIds.flatMap((datasetId: string, index: number) => {
      const retired = retireInspectionDatasets(workerData.root, workerData.sourceId, { datasetId, before: new Date().toISOString(), apply: true });
      progress(index + 1);
      return retired.length ? retired : [{ datasetId, status: "unavailable" }];
    });
  } else if (workerData.kind === "measure") {
    result = maintainInspectionStorage(workerData.root, workerData.sourceId, {
      datasetId: workerData.datasetId, retireBefore: workerData.retireBefore,
      targetBytes: workerData.targetBytes, progress,
    });
  } else throw new Error("inspection_storage_scan_failed");
  parentPort!.postMessage({ kind: "completed", result });
} catch (error) {
  const code = error instanceof Error && ["inspection_path_invalid", "inspection_storage_scan_limit"].includes(error.message) ? error.message : "inspection_storage_scan_failed";
  parentPort!.postMessage({ kind: "failed", code });
} finally { parentPort!.close(); }
