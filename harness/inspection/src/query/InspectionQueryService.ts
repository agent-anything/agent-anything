import { Worker } from "node:worker_threads";
import { defaultInspectionRoot } from "../sources/index.js";
import { validateInspectionQuery } from "./InspectionDatasetQuery.js";
import type { InspectionQuery, InspectionReadResult } from "./InspectionQuery.js";

interface ReadWorker { worker: Worker; busy: boolean; cancel?: () => void }
export class InspectionQueryService {
  private readonly readers: ReadWorker[] = [];
  private nextId = 0;
  private closed = false;
  constructor(private readonly root = defaultInspectionRoot()) {}
  query(input: InspectionQuery, signal?: AbortSignal): Promise<InspectionReadResult> {
    const query = validateInspectionQuery(input);
    if (this.closed || signal?.aborted) return Promise.reject(new Error("inspection_source_unavailable"));
    let reader = this.readers.find((item) => !item.busy);
    if (!reader && this.readers.length < 2) {
      reader = { worker: new Worker(new URL("./InspectionQueryWorker.js", import.meta.url), { workerData: { root: this.root } }), busy: false };
      reader.worker.unref(); this.readers.push(reader);
    }
    if (!reader) return Promise.reject(new Error("inspection_query_busy"));
    const current = reader; current.busy = true;
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (code?: string, result?: InspectionReadResult, recycle = false) => {
        if (settled) return;
        settled = true; delete current.cancel;
        clearTimeout(timeout); signal?.removeEventListener("abort", abort);
        current.worker.off("message", message); current.worker.off("error", error); current.worker.off("exit", error);
        current.busy = false;
        if (recycle) { const index = this.readers.indexOf(current); if (index >= 0) this.readers.splice(index, 1); void current.worker.terminate(); }
        if (code) reject(new Error(code)); else resolve(result!);
      };
      const message = (reply: { id: number; code?: string; result?: InspectionReadResult }) => { if (reply.id === id) finish(reply.code, reply.result); };
      const error = () => finish("inspection_dataset_corrupt", undefined, true);
      const abort = () => finish("inspection_query_cancelled", undefined, true);
      const timeout = setTimeout(() => finish("inspection_query_timeout", undefined, true), 2000);
      current.cancel = abort;
      signal?.addEventListener("abort", abort, { once: true });
      current.worker.on("message", message); current.worker.once("error", error); current.worker.once("exit", error);
      try { current.worker.postMessage({ id, query }); } catch { error(); }
    });
  }
  async close(): Promise<void> { this.closed = true; for (const reader of this.readers.splice(0)) { reader.cancel?.(); await reader.worker.terminate(); } }
}
