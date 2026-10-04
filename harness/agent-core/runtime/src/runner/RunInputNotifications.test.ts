import { describe, expect, it } from "vitest";
import { RunInputNotifications, type RunInputNotification, type RunInputNotificationSource } from "./RunInputNotifications.js";

function fact(sequence = 1): RunInputNotification {
  return {runId: "run-1", sequence, source: {owner: "test", kind: "finished", id: "work-1", revision: String(sequence)},
    occurredAt: "2026-10-03T00:00:00.000Z", data: {exitCode: 2}};
}

describe("RunInputNotifications", () => {
  it("snapshots facts and only acknowledges the input actually delivered", () => {
    const inbox = new RunInputNotifications();
    const first = fact();
    inbox.collect("run-1", {read: () => [first]}, 10_000);
    const checkpoint = inbox.checkpoint;
    (first.data as {exitCode: number}).exitCode = 0;
    inbox.collect("run-1", {read: () => [fact(2)]}, 10_000);
    expect(inbox.undelivered).toBe(2);
    const contribution = inbox.contribution("run-1")!;
    expect(inbox.contribution("run-1")).toEqual(contribution);
    expect(contribution.handling).toMatchObject({necessity: "mandatory", allowedTransformations: []});
    expect(JSON.stringify(contribution.payload)).toContain('"exitCode":2');
    inbox.delivered(checkpoint);
    expect(inbox.undelivered).toBe(1);
    expect(inbox.contribution("run-1")!.ref.revision).not.toBe(contribution.ref.revision);
    inbox.delivered(2);
    expect(inbox.contribution("run-1")).toBeNull();
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
});
