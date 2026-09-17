import { afterEach, expect, it, vi } from "vitest";
import { Worker } from "node:worker_threads";
import { InspectionStorageMaintenance } from "./InspectionStorageMaintenance.js";

vi.mock("node:worker_threads", async () => {
  const { EventEmitter } = await import("node:events");
  return { Worker: vi.fn(function () {
    return Object.assign(new EventEmitter(), { terminate: vi.fn(async () => 0) });
  }) };
});
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

it("reports failure to create a scan Worker through the same promise contract", async () => {
  vi.mocked(Worker).mockImplementationOnce(() => { throw new Error("Worker allocation failed"); });
  const maintenance = new InspectionStorageMaintenance("root", "source");
  await expect(maintenance.measure()).rejects.toThrow("inspection_storage_scan_failed");
  maintenance.close();
});

it.each([
  ["idle", "inspection_storage_scan_stalled"],
  ["total", "inspection_storage_scan_timeout"],
  ["error", "inspection_storage_scan_failed"],
  ["exit", "inspection_storage_scan_failed"],
  ["failure", "inspection_path_invalid"],
] as const)("bounds %s reconciliation and terminates the scan Worker", async (mode, code) => {
  vi.useFakeTimers();
  const maintenance = new InspectionStorageMaintenance("root", "source");
  const progress = vi.fn();
  const result = maintenance.measure({ progress }).catch(error => error);
  const worker = vi.mocked(Worker).mock.results.at(-1)!.value as Worker;
  if (mode === "total") {
    for (let i = 1; i <= 6; i++) {
      await vi.advanceTimersByTimeAsync(20_000);
      worker.emit("message", { kind: "progress", completed: i });
    }
  } else if (mode === "idle") {
    worker.emit("message", { kind: "progress", completed: 1 });
    await vi.advanceTimersByTimeAsync(20_000);
    worker.emit("message", { kind: "progress", completed: 1 });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(progress).toHaveBeenCalledTimes(1);
  } else if (mode === "error") worker.emit("error", new Error("disk details"));
  else if (mode === "exit") worker.emit("exit", 0);
  else worker.emit("message", { kind: "failed", code });
  expect((await result).message).toBe(code);
  expect(worker.terminate).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
  maintenance.close();
});

it("delivers a complete measurement and stops all timeout work", async () => {
  vi.useFakeTimers();
  const maintenance = new InspectionStorageMaintenance("root", "source");
  const result = maintenance.measure();
  const worker = vi.mocked(Worker).mock.results.at(-1)!.value as Worker;
  const measurement = { bytes: 123, visited: 2, datasetFiles: [] };
  worker.emit("message", { kind: "measured", measurement });
  expect(await result).toEqual(measurement);
  expect(vi.getTimerCount()).toBe(0);
  maintenance.close();
});
