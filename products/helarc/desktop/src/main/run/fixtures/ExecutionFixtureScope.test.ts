import {describe, it, expect, vi} from "vitest";
import {ExecutionFixtureScope} from "./ExecutionFixtureScope.js";
import type {HelarcHostRunComposition, PreparedHelarcHostRun} from "../HelarcHostRunComposition.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => {resolve = done;});
  return {promise, resolve};
}

describe("execution fixture ownership", () => {
  it("awaits actual settlement after a cancellation receipt before closing the store", async () => {
    const scope = new ExecutionFixtureScope(), outcome = deferred<never>(), started = deferred<void>();
    const events: string[] = [];
    const run = {result: outcome.promise, activeRun: {cancel: vi.fn(async () => {events.push("cancel");})}} as unknown as HelarcHostRunComposition;
    const body = scope.run(async () => {
      await scope.open(async () => ({close: async () => {events.push("close");}}));
      const prepared = await scope.prepare(async () => ({start: () => run}) as PreparedHelarcHostRun);
      const active = prepared.start(); started.resolve();
      await active.result;
    });
    await started.promise;
    const cleanup = scope.close();
    await vi.waitFor(() => expect(events).toEqual(["cancel"]));
    outcome.resolve(undefined as never);
    await body; await cleanup;
    expect(events).toEqual(["cancel", "close"]);
    expect(scope.close()).toBe(cleanup);
  });

  it("owns a store whose creation finishes after timeout and prevents late Run start", async () => {
    const scope = new ExecutionFixtureScope(), created = deferred<{close(): Promise<void>}>(), close = vi.fn(async () => {});
    const body = scope.run(async () => {await scope.open(() => created.promise); throw new Error("late body continued");});
    void body.catch(() => undefined);
    await Promise.resolve();
    const cleanup = scope.close();
    created.resolve({close});
    await expect(body).rejects.toThrow("execution_fixture_closed");
    await cleanup;
    expect(close).toHaveBeenCalledTimes(1);
    expect(() => scope.prepare(async () => ({}) as PreparedHelarcHostRun)).toThrow("execution_fixture_closed");
  });

  it("cancels and joins a recovery that finishes creating its Run after timeout", async () => {
    const scope = new ExecutionFixtureScope(), recovered = deferred<HelarcHostRunComposition>(), settled = deferred<never>();
    const cancel = vi.fn(async () => {settled.resolve(undefined as never);});
    const recovering = deferred<void>();
    const body = scope.run(async () => {
      const prepared = await scope.prepare(async () => ({recover: () => {recovering.resolve(); return recovered.promise;}}) as unknown as PreparedHelarcHostRun);
      await prepared.recover("continue");
    });
    void body.catch(() => undefined);
    await recovering.promise;
    const cleanup = scope.close();
    recovered.resolve({result: settled.promise, activeRun: {cancel}} as unknown as HelarcHostRunComposition);
    await expect(body).rejects.toThrow("execution_fixture_closed");
    await cleanup;
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});
