import { EventEmitter } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import { waitForInspectionReady } from "./InspectionRecorderStartup.js";

class StartupWorker extends EventEmitter {
  terminate = vi.fn(async () => 0);
}
const limits = { startMs: 10, idleMs: 30, totalMs: 120 };
afterEach(() => vi.useRealTimers());

it("waits for readiness while real progress continues beyond the old startup window", async () => {
  vi.useFakeTimers();
  const worker = new StartupWorker();
  const ready = waitForInspectionReady(worker as never, undefined, limits);
  worker.emit("online");
  for (let completed = 1; completed <= 4; completed++) {
    await vi.advanceTimersByTimeAsync(20);
    worker.emit("message", { kind: "initializing", completed });
  }
  worker.emit("message", { kind: "ready", source: {}, manifest: {} });
  await expect(ready).resolves.toMatchObject({ kind: "ready" });
  expect(worker.terminate).not.toHaveBeenCalled();
  expect(worker.eventNames()).toEqual([]);
  expect(vi.getTimerCount()).toBe(0);
});

it.each([
  ["not-online", "inspection_start_timeout"],
  ["idle", "inspection_initialization_stalled"],
  ["duplicate-progress", "inspection_initialization_stalled"],
  ["overall", "inspection_initialization_timeout"],
  ["error", "inspection_worker_failed"],
  ["exit", "inspection_worker_exited"],
  ["cancel", "inspection_start_cancelled"],
  ["storage", "inspection_storage_budget_exhausted"],
] as const)("cleans up %s and preserves the cause", async (scenario, code) => {
  vi.useFakeTimers();
  const worker = new StartupWorker();
  const controller = new AbortController();
  const result = waitForInspectionReady(worker as never, controller.signal, limits).catch(error => error);
  if (scenario !== "not-online") worker.emit("online");
  if (scenario === "duplicate-progress") {
    worker.emit("message", { kind: "initializing", completed: 1 });
    await vi.advanceTimersByTimeAsync(20);
    worker.emit("message", { kind: "initializing", completed: 1 });
  } else if (scenario === "overall") {
    for (let completed = 1; completed <= 6; completed++) {
      await vi.advanceTimersByTimeAsync(20);
      worker.emit("message", { kind: "initializing", completed });
    }
  } else if (scenario === "error") worker.emit("error", new Error("sensitive local details"));
  else if (scenario === "exit") worker.emit("exit", 0);
  else if (scenario === "cancel") controller.abort();
  else if (scenario === "storage") worker.emit("message", { kind: "failed", code });
  await vi.advanceTimersByTimeAsync(31);
  expect(await result).toMatchObject({ code, message: code });
  expect(worker.terminate).toHaveBeenCalledTimes(1);
  expect(worker.eventNames()).toEqual([]);
  expect(vi.getTimerCount()).toBe(0);
});
