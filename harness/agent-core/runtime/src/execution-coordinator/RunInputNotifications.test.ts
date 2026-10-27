import { describe, expect, it } from "vitest";
import { RunInputNotifications, type RunInputNotification, type RunInputNotificationSource } from "./RunInputNotifications.js";
import { createControllerInputDeliveryReceipt } from "../decision/DecisionInputDelivery.js";

function fact(sequence = 1): RunInputNotification {
  return {runId: "run-1", sequence, source: {owner: "test", kind: "finished", id: "work-1", revision: String(sequence)},
    occurredAt: "2026-10-03T00:00:00.000Z", data: {exitCode: 2}};
}

describe("RunInputNotifications", () => {
  it("keeps external cursors independent from Run-owned admission ordering", () => {
    const inbox = new RunInputNotifications();
    const {runId, sequence, ...owned} = fact();
    expect(inbox.admitOwned(runId, owned, 10_000).sequence).toBe(1);
    const first = inbox.collect(runId, {read: (_run, after) => {
      expect(after).toBe(0);
      return [fact(10)];
    }}, 10_000);
    expect(first[0]).toMatchObject({sequence: 2, sourceSequence: 10});
    const batch = inbox.prepare(runId, "turn-1")!;
    expect(inbox.admitOwned(runId, {...owned, source: {...owned.source, revision: "2"}}, 10_000).sequence).toBe(3);
    inbox.accepted(batch, createControllerInputDeliveryReceipt(batch, "turn-1"));
    expect(inbox.collect(runId, {read: (_run, after) => {
      expect(after).toBe(10);
      return [fact(20)];
    }}, 10_000)[0]).toMatchObject({sequence: 4, sourceSequence: 20});
    expect(inbox.pendingEntries.map(entry => entry.sequence)).toEqual([3, 4]);
    expect(inbox.checkpoint).toBe(20);
    expect(() => inbox.admitOwned(runId, {...owned, data: "oversized"}, 1)).toThrow();
    expect(inbox.admitOwned(runId, owned, 10_000).sequence).toBe(5);
  });

  it("snapshots facts and only acknowledges the input actually delivered", () => {
    const inbox = new RunInputNotifications();
    const first = fact();
    inbox.collect("run-1", {read: () => [first]}, 10_000);
    const batch = inbox.prepare("run-1", "turn-1")!;
    (first.data as {exitCode: number}).exitCode = 0;
    inbox.collect("run-1", {read: () => [fact(2)]}, 10_000);
    expect(inbox.undelivered).toBe(2);
    expect(JSON.stringify(batch.entries)).toContain('"exitCode":2');
    expect(batch.entries).toHaveLength(1);
    inbox.accepted(batch, createControllerInputDeliveryReceipt(batch, "turn-1"));
    expect(inbox.undelivered).toBe(1);
    const next = inbox.prepare("run-1", "turn-2")!;
    expect(next.entries.map(entry => entry.sequence)).toEqual([2]);
    inbox.accepted(next, createControllerInputDeliveryReceipt(next, "turn-2"));
    expect(inbox.prepare("run-1", "turn-3")).toBeNull();
  });

  it.each([
    [fact(1), fact(1)],
    [fact(2), fact(1)],
    [{...fact(), runId: "another-run"}],
    [{...fact(), occurredAt: "unknown"}],
    [{...fact(), data: {invalid: undefined}}],
  ])("rejects an invalid batch atomically: %j", (...facts) => {
    const inbox = new RunInputNotifications();
    expect(() => inbox.collect("run-1", {read: () => facts}, 10_000)).toThrow();
    expect(inbox.checkpoint).toBe(0);
    expect(inbox.undelivered).toBe(0);
  });

  it("never treats source failure or overflow as an empty inbox", () => {
    const inbox = new RunInputNotifications();
    expect(() => inbox.collect("run-1", {read: () => {throw new Error("source failed");}}, 10_000)).toThrow("source failed");
    expect(() => inbox.collect("run-1", {read: () => null} as unknown as RunInputNotificationSource, 10_000)).toThrow("must return an array");
    expect(() => inbox.collect("run-1", {read: () => [fact()]}, 1)).toThrow("exceeds");
    expect(inbox.checkpoint).toBe(0);
  });

  it("admits only the owner's explicit minimum-safe representation when content cannot fit", () => {
    const inbox = new RunInputNotifications();
    const {runId, sequence, ...owned} = fact();
    const minimum = {status: "completed", effectStatus: "known", presentation: "unavailable", sourceRef: "result-1"};
    const admitted = inbox.admitOwned(runId, {...owned, data: "x".repeat(10_000)}, 1_000, minimum);
    expect(admitted.data).toEqual(minimum);
    expect(admitted.sequence).toBe(1);
    expect(() => inbox.admitOwned(runId, {...owned, source: {...owned.source, id: ""}}, 1_000, minimum)).toThrow("identity");
    expect(() => inbox.admitOwned(runId, owned, 1, minimum)).toThrow("bound");
    expect(inbox.pendingEntries).toEqual([admitted]);
  });
});
