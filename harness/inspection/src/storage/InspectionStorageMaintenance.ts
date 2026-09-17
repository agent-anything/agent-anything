import { Worker } from "node:worker_threads";
import type { InspectionStorageMeasurement } from "./InspectionStorageScan.js";

export class InspectionStorageMaintenance {
  private worker: Worker | null = null;
  private cancel: (() => void) | null = null;
  private closed = false;
  constructor(private readonly root: string, private readonly sourceId: string) {}

  measure(options: { datasetId?: string; retireBefore?: string; progress?: (completed: number) => void } = {}): Promise<InspectionStorageMeasurement> {
    if (this.closed) return Promise.reject(new Error("inspection_storage_scan_cancelled"));
    if (this.worker) return Promise.reject(new Error("inspection_storage_scan_overlap"));
    let worker: Worker;
    try {
      worker = new Worker(new URL("./InspectionStorageScanWorker.js", import.meta.url), {
        workerData: { root: this.root, sourceId: this.sourceId, datasetId: options.datasetId, retireBefore: options.retireBefore },
      });
    } catch { return Promise.reject(new Error("inspection_storage_scan_failed")); }
    this.worker = worker;
    return new Promise((resolve, reject) => {
      let settled = false;
      let completed = -1;
      let idle = setTimeout(() => finish(undefined, "inspection_storage_scan_stalled"), 30_000);
      const total = setTimeout(() => finish(undefined, "inspection_storage_scan_timeout"), 120_000);
      const finish = (measurement?: InspectionStorageMeasurement, code?: string) => {
        if (settled) return;
        settled = true; clearTimeout(idle); clearTimeout(total); this.cancel = null;
        void worker.terminate().then(() => {
          this.worker = null;
          if (measurement) resolve(measurement); else reject(new Error(code));
        }, () => { this.worker = null; reject(new Error("inspection_storage_scan_failed")); });
      };
      this.cancel = () => finish(undefined, "inspection_storage_scan_cancelled");
      worker.on("message", (reply: { kind: string; completed: number; measurement: InspectionStorageMeasurement; code: string }) => {
        if (settled) return;
        if (reply.kind === "progress" && Number.isSafeInteger(reply.completed) && reply.completed > completed) {
          completed = reply.completed;
          clearTimeout(idle); idle = setTimeout(() => finish(undefined, "inspection_storage_scan_stalled"), 30_000);
          options.progress?.(completed);
        } else if (reply.kind === "measured") finish(reply.measurement);
        else if (reply.kind === "failed") finish(undefined, reply.code);
      });
      worker.on("error", () => finish(undefined, "inspection_storage_scan_failed"));
      worker.on("exit", () => { if (!settled) finish(undefined, "inspection_storage_scan_failed"); });
    });
  }

  close(): void { this.closed = true; this.cancel?.(); }
}
