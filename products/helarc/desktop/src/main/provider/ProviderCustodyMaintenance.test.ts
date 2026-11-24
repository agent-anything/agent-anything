import { describe, expect, it, vi } from "vitest";
import { ProviderCustodyMaintenance } from "./ProviderCustodyMaintenance.js";

describe("Host custody maintenance", () => {
  it("coalesces requests, pages once through unresolved intents, and observes without blocking mutation", async () => {
    const reconcileUpdates = vi.fn(async (after: string) => ({ resolved: 0, retained: 1, next: after ? null : "second-page" }));
    const collect = vi.fn(async () => ({ examined: 1, deleted: 0, failed: 0, next: null }));
    const observe = vi.fn(async () => {});
    const maintenance = new ProviderCustodyMaintenance({ reconcileUpdates, collect }, observe);
    for (let i = 0; i < 20; i++) maintenance.request();
    expect(reconcileUpdates).not.toHaveBeenCalled();
    await maintenance.idle();
    expect(reconcileUpdates.mock.calls).toEqual([["", 25], ["second-page", 25]]);
    expect(collect).toHaveBeenCalledTimes(1);
    expect(observe).toHaveBeenCalledTimes(1);
    await maintenance.close();
  });
  it("finishes the active protected operation on close without scheduling another page", async () => {
    let release!: (value: { examined: number; deleted: number; failed: number; next: string }) => void;
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const collect = vi.fn(() => { entered(); return new Promise<{ examined: number; deleted: number; failed: number; next: string }>(resolve => { release = resolve; }); });
    const maintenance = new ProviderCustodyMaintenance({ reconcileUpdates: async () => ({ resolved: 0, retained: 0, next: null }), collect });
    maintenance.request(); await started;
    let closed = false; const closing = maintenance.close().then(() => { closed = true; });
    await Promise.resolve(); expect(closed).toBe(false);
    release({ examined: 1, deleted: 1, failed: 0, next: "next-page" }); await closing;
    maintenance.request(); await maintenance.idle();
    expect(collect).toHaveBeenCalledTimes(1);
  });
  it("records failures and retries only on a later explicit maintenance request", async () => {
    const reconcileUpdates = vi.fn(async () => { throw new Error("registry unavailable"); });
    const collect = vi.fn(async () => ({ examined: 0, deleted: 0, failed: 0, next: null }));
    const observer = vi.fn();
    const maintenance = new ProviderCustodyMaintenance({ reconcileUpdates, collect }, async () => { throw new Error("inspection unavailable"); }, observer);
    maintenance.request(); await maintenance.idle();
    expect(reconcileUpdates).toHaveBeenCalledTimes(1); expect(collect).not.toHaveBeenCalled();
    expect(observer).toHaveBeenCalledWith(expect.objectContaining({ stage: "maintenance", outcome: "rejected" }));
    maintenance.request(); await maintenance.idle(); expect(reconcileUpdates).toHaveBeenCalledTimes(2);
    await maintenance.close();
  });
});
