import { Worker } from "node:worker_threads";
import type { InspectionStorageMeasurement } from "./InspectionStorageScan.js";
import type { InspectionStorageInventory } from "./InspectionStorageInventory.js";
import type { InspectionRetirement } from "./InspectionRetention.js";

export class InspectionStorageMaintenance {
  private worker: Worker | null = null;
  private cancel: (() => void) | null = null;
  private closed = false;
  constructor(private readonly root: string, private readonly sourceId: string) {}

  measure(options: { datasetId?: string; retireBefore?: string; targetBytes?: number; progress?: (completed: number) => void } = {}): Promise<InspectionStorageMeasurement> {
    const { progress, ...request } = options;
    return this.run({ kind: "measure", ...request }, progress);
  }

  inventory(): Promise<InspectionStorageInventory> { return this.run({ kind: "inventory" }); }

  retire(datasetIds: readonly string[]): Promise<readonly InspectionRetirement[]> {
    return this.run({ kind: "retire", datasetIds });
  }

  private run<T>(request: object, progress?: (completed: number) => void): Promise<T> {
    if (this.closed) return Promise.reject(new Error("inspection_storage_scan_cancelled"));
    if (this.worker) return Promise.reject(new Error("inspection_storage_scan_overlap"));
    let worker: Worker;
    try {
      worker = new Worker(new URL("./InspectionStorageScanWorker.js", import.meta.url), {
        workerData: { root: this.root, sourceId: this.sourceId, ...request },
      });
    } catch { return Promise.reject(new Error("inspection_storage_scan_failed")); }
    this.worker = worker;
    return new Promise((resolve, reject) => {
      let settled = false;
      let completed = -1;
      let idle = setTimeout(() => finish(undefined, "inspection_storage_scan_stalled"), 30_000);
      const total = setTimeout(() => finish(undefined, "inspection_storage_scan_timeout"), 120_000);
      const finish = (result?: T, code?: string) => {
        if (settled) return;
        settled = true; clearTimeout(idle); clearTimeout(total); this.cancel = null;
        void worker.terminate().then(() => {
          this.worker = null;
          if (result !== undefined) resolve(result); else reject(new Error(code));
        }, () => { this.worker = null; reject(new Error("inspection_storage_scan_failed")); });
      };
      this.cancel = () => finish(undefined, "inspection_storage_scan_cancelled");
      worker.on("message", (reply: { kind: string; completed: number; result: T; code: string }) => {
        if (settled) return;
        if (reply.kind === "progress" && Number.isSafeInteger(reply.completed) && reply.completed > completed) {
          completed = reply.completed;
          clearTimeout(idle); idle = setTimeout(() => finish(undefined, "inspection_storage_scan_stalled"), 30_000);
          progress?.(completed);
        } else if (reply.kind === "completed") finish(reply.result);
        else if (reply.kind === "failed") finish(undefined, reply.code);
      });
      worker.on("error", () => finish(undefined, "inspection_storage_scan_failed"));
      worker.on("exit", () => { if (!settled) finish(undefined, "inspection_storage_scan_failed"); });
    });
  }

  close(): void { this.closed = true; this.cancel?.(); }
}
