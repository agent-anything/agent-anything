import { createRunCancellationController } from "../run/index.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  OperationSettlementTimeoutError,
  RunInterruptionCoordinator,
} from "./RunInterruptionCoordinator.js";

const now = "2026-08-04T00:00:00.000Z";

describe("RunInterruptionCoordinator", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("reports cancellation while leaving Run transition meaning to its owner", async () => {
    const cancellation = createRunCancellationController({
      runId: "run-1",
      now: () => now,
    });
    const observed: string[] = [];
    const gate = deferred<string>();
    const coordinator = new RunInterruptionCoordinator({
      cancellation: cancellation.context,
      operationSettlementTimeoutMs: 1_000,
      now: () => now,
      onCancellationObserved: (request) => observed.push(request.id),
    });
    coordinator.start();

    const operation = coordinator.execute("controller", () => gate.promise);
    await Promise.resolve();
    cancellation.requestCancellation({
      origin: "user",
      reasonCode: "user_requested",
    });
    gate.resolve("settled");

    await expect(operation).resolves.toBe("settled");
    expect(observed).toEqual(["run-1:cancellation"]);
    expect(coordinator.isActive("controller")).toBe(false);
    coordinator.dispose();
  });

  it("bounds an active operation that does not settle after cancellation", async () => {
    vi.useFakeTimers();
    const cancellation = createRunCancellationController({
      runId: "run-1",
      now: () => now,
    });
    const coordinator = new RunInterruptionCoordinator({
      cancellation: cancellation.context,
      operationSettlementTimeoutMs: 25,
      now: () => now,
      onCancellationObserved: () => undefined,
    });
    coordinator.start();

    const operation = coordinator.execute(
      "tool",
      () => new Promise<never>(() => undefined),
    );
    const caught = operation.catch((error: unknown) => error);
    await Promise.resolve();
    cancellation.requestCancellation({
      origin: "host",
      reasonCode: "host_requested",
    });
    await vi.advanceTimersByTimeAsync(25);

    const error = await caught;
    expect(error).toBeInstanceOf(OperationSettlementTimeoutError);
    expect(error).toMatchObject({
      operation: "tool",
      interruptionKind: "run_cancellation",
      timeoutMs: 25,
    });
    coordinator.dispose();
  });
});

function deferred<TValue>() {
  let resolve!: (value: TValue) => void;
  const promise = new Promise<TValue>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
