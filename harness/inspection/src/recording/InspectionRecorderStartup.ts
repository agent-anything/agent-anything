import type { Worker } from "node:worker_threads";
import type { RecorderReply } from "./InspectionRecorderProtocol.js";
import { InspectionRecorderError } from "./InspectionRecorderError.js";

type StartupWorker = Pick<Worker, "on" | "off" | "terminate">;
export const INSPECTION_STARTUP_LIMITS = { startMs: 10_000, idleMs: 30_000, totalMs: 120_000 };

export function waitForInspectionReady(worker: StartupWorker, signal?: AbortSignal, limits = INSPECTION_STARTUP_LIMITS): Promise<Extract<RecorderReply, { kind: "ready" }>> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let online = false;
    let completed = -1;
    let idle = setTimeout(() => fail("inspection_start_timeout"), limits.startMs);
    const overall = setTimeout(() => fail("inspection_initialization_timeout"), limits.totalMs);
    const cleanup = () => {
      clearTimeout(idle); clearTimeout(overall);
      worker.off("online", onOnline); worker.off("message", onMessage);
      worker.off("error", onError); worker.off("exit", onExit);
      signal?.removeEventListener("abort", onAbort);
    };
    const resetIdle = () => {
      clearTimeout(idle);
      idle = setTimeout(() => fail("inspection_initialization_stalled"), limits.idleMs);
    };
    const fail = (code: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(idle); clearTimeout(overall);
      const rejectAfterCleanup = () => { cleanup(); reject(new InspectionRecorderError(code)); };
      void worker.terminate().then(rejectAfterCleanup, rejectAfterCleanup);
    };
    const onOnline = () => { if (!online && !settled) { online = true; resetIdle(); } };
    const onError = () => fail("inspection_worker_failed");
    const onExit = () => fail("inspection_worker_exited");
    const onAbort = () => fail("inspection_start_cancelled");
    const onMessage = (reply: RecorderReply) => {
      if (settled) return;
      if (reply.kind === "initializing" && Number.isSafeInteger(reply.completed) && reply.completed > completed) {
        completed = reply.completed; resetIdle();
      } else if (reply.kind === "ready") {
        settled = true; cleanup(); resolve(reply);
      } else if (reply.kind === "failed") fail(reply.code);
    };
    worker.on("online", onOnline); worker.on("message", onMessage);
    worker.on("error", onError); worker.on("exit", onExit);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}
