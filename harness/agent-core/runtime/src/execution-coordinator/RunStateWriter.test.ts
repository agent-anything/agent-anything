import {describe, expect, it, vi} from "vitest";
import type {RunState} from "../run/index.js";
import {RunStateWriter} from "./RunStateWriter.js";

function initial(): RunState<unknown> {
  return {run: {id: "run-1"}, revision: 0, status: "running", items: [],
    counters: {controllerTurns: 0, runActions: 0, observations: 0, consecutiveActionFailures: 0}} as unknown as RunState<unknown>;
}

describe("Run state commit ordering", () => {
  it("prepares against the last committed revision and publishes only after acknowledgement", async () => {
    let release!: () => void;
    const ack = new Promise<void>(resolve => {release = resolve;});
    const published = vi.fn();
    const prepared: number[] = [];
    const writer = new RunStateWriter(initial(), () => "2026-10-14T00:00:00Z",
      ({sequence}) => `item-${sequence}`, published, async next => {
        prepared.push(next.revision);
        if (next.revision === 1) await ack;
      });
    const first = writer.commitState(current => ({counters: {...current.counters, runActions: current.counters.runActions + 1}}));
    const second = writer.commitState(current => ({counters: {...current.counters, runActions: current.counters.runActions + 1}}));
    await Promise.resolve();
    expect(prepared).toEqual([1]);
    expect(writer.getSnapshot().revision).toBe(0);
    expect(published).not.toHaveBeenCalled();
    release();
    expect((await first).revision).toBe(1);
    expect((await second).revision).toBe(2);
    expect(writer.getSnapshot().counters.runActions).toBe(2);
    expect(published).toHaveBeenCalledTimes(2);
  });

  it("retains the last acknowledged state and closes later mutation on unknown commit outcome", async () => {
    const failure = new Error("acknowledgement unknown");
    const publish = vi.fn();
    const persist = vi.fn(async () => {throw failure;});
    const writer = new RunStateWriter(initial(), () => "2026-10-14T00:00:00Z", () => "id", publish, persist);
    const first = writer.commitState(() => ({status: "waiting"}));
    const second = writer.commitState(() => ({status: "suspended"}));
    await expect(first).rejects.toBe(failure);
    await expect(second).rejects.toBe(failure);
    expect(writer.getSnapshot()).toMatchObject({revision: 0, status: "running"});
    expect(persist).toHaveBeenCalledOnce();
    expect(publish).not.toHaveBeenCalled();
  });

  it("revalidates competing controls inside the commit queue without inventing a revision for rejection", async () => {
    const persist = vi.fn(async () => {});
    const writer = new RunStateWriter(initial(), () => "2026-10-14T00:00:00Z", () => "id", () => {}, persist);
    const submit = () => writer.transaction(current => current.revision === 0
      ? {value: "accepted", payloads: [], patch: {status: "suspended" as const}}
      : {value: "stale"});
    expect(await Promise.all([submit(), submit()])).toEqual(["accepted", "stale"]);
    expect(writer.getSnapshot().revision).toBe(1);
    expect(persist).toHaveBeenCalledOnce();
  });
});
