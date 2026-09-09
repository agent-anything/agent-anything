import { parentPort, workerData } from "node:worker_threads";
import { executeInspectionQuery } from "./InspectionDatasetQuery.js";
import type { InspectionQuery } from "./InspectionQuery.js";

parentPort!.on("message", (message: { id: number; query: InspectionQuery }) => {
  try {
    const result = executeInspectionQuery(workerData.root, message.query);
    if (Buffer.byteLength(JSON.stringify(result)) > 2 * 1024 * 1024) throw new Error("inspection_query_too_large");
    parentPort!.postMessage({ id: message.id, result });
  } catch (error) {
    const code = error instanceof Error && /^inspection_[a-z_]+$/.test(error.message) ? error.message : "inspection_dataset_corrupt";
    parentPort!.postMessage({ id: message.id, code });
  }
});
