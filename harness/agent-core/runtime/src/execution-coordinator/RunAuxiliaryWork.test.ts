import {expect, it, vi} from "vitest";
import {RunAuxiliaryWork} from "./RunAuxiliaryWork.js";
import {createRunCancellationController} from "../run/RunCancellation.js";
import type {AgentActivityExecutionContext} from "../decision/TaskDecisionActivity.js";
import {AUXILIARY_USAGE_KEY} from "../model-access/AuxiliaryModelUsage.js";
import {ActivityCheckpointError} from "../activity/ActivityCheckpoint.js";

function fixture(saved = new Map<string, unknown>()) {
  const cancellation = createRunCancellationController({runId: "r", createRequestId: () => "cancel", now: () => new Date().toISOString()});
  let authority = "original";
  const writes: {key: string; value: unknown}[][] = [];
  const owner = new RunAuxiliaryWork({runId: "r", cancellation: cancellation.context,
    deadlineAt: new Date(Date.now() + 60000).toISOString(), now: () => new Date().toISOString(), authority: () => authority,
    read: key => saved.get(key) ?? null, assertAdmission: () => {},
    commit: async (_id, values, guard) => {guard?.(); writes.push([...values]); for (const entry of values) saved.set(entry.key, structuredClone(entry.value));},
    context: (_id, scoped, deadlineAt) => ({cancellation: scoped, retry: {
      deadlineAt, events: {emit: async () => {}},
      providerRequest: {} as AgentActivityExecutionContext["retry"]["providerRequest"],
      structuredOutput: {} as AgentActivityExecutionContext["retry"]["structuredOutput"],
    }}),
  });
  const port = owner.port(async () => () => {});
  const registration = {id: "bg", binding: "source", deadlineAt: new Date(Date.now() + 50000).toISOString()};
  return {owner, port, registration, saved, writes, cancel: cancellation, authority: (value: string) => {authority = value; owner.notifyAuthorityChanged();}};
}

it("retains an independent checkpoint namespace and atomically commits known usage", async () => {
  const f = fixture();
  const usage = {attemptId: "attempt", requestId: "request", purpose: "context_generation" as const, outcome: "succeeded" as const, usage: null};
  await f.port.start(f.registration, async context => {
    expect(context.runCheckpoints).toBeUndefined(); expect(context.auxiliaryWork).toBeUndefined();
    expect(context.auxiliaryInvocationId).toBe("bg");
    await context.checkpoints!.commitWithAuxiliaryUsage!("result", {returned: true}, usage);
  });
  await f.port.wait("bg");
  expect(f.port.current()?.status).toBe("completed");
  expect(f.writes.some(values => values.length === 2 && values.some(value => value.key === AUXILIARY_USAGE_KEY + "attempt") &&
    values.some(value => value.key.includes("checkpoint")))).toBe(true);
  const again = vi.fn(); await f.port.start(f.registration, again); expect(again).not.toHaveBeenCalled();
  expect(await f.owner.close(100)).toBe(true);
});

it("cancels incompatible authority without changing a saved result or restarting the same basis", async () => {
  const f = fixture(); let started!: () => void;
  const ready = new Promise<void>(resolve => {started = resolve;});
  await f.port.start(f.registration, async context => {
    started(); await new Promise<void>(resolve => context.cancellation.signal.addEventListener("abort", () => resolve(), {once: true}));
  });
  await ready; f.authority("changed"); await f.port.wait("bg");
  expect(f.port.current()?.status).toBe("cancelled");
  const again = vi.fn(); await f.port.start(f.registration, again); expect(again).not.toHaveBeenCalled();
  await f.owner.close(100);
});

it("bounds cleanup and fences late checkpoint writes after an unconfirmed producer", async () => {
  const f = fixture(); let savedContext!: AgentActivityExecutionContext, finish!: () => void;
  await f.port.start(f.registration, async context => {savedContext = context; await new Promise<void>(resolve => {finish = resolve;});});
  await Promise.resolve();
  expect(await f.owner.close(5)).toBe(false);
  const before = f.writes.length;
  await expect(savedContext.checkpoints!.commit("late", {value: "must not appear"})).rejects.toThrow("closed");
  finish(); await expect(f.port.wait("bg")).rejects.toThrow("closed");
  expect(f.writes).toHaveLength(before);
});

it("cancel-only recovery retires a registration without running its callback", async () => {
  const f = fixture(); let finish!: () => void;
  await f.port.start(f.registration, async () => new Promise<void>(resolve => {finish = resolve;}));
  await Promise.resolve(); const saved = structuredClone(f.saved);
  finish(); await f.port.wait("bg"); await f.owner.close(100);
  const recovered = fixture(saved);
  expect(await recovered.owner.close(100)).toBe(true);
  expect(recovered.port.current()).toMatchObject({status: "cancelled", failure: "auxiliary_retired_on_recovery"});
});

it("does not turn lost durable progress into an ignorable optional preparation failure", async () => {
  const f = fixture(), failure = new ActivityCheckpointError("generation-response");
  await f.port.start(f.registration, async () => {throw failure;});
  await expect(f.port.wait("bg")).rejects.toBe(failure);
  expect(f.port.current()?.status).toBe("failed");
  await expect(f.owner.close(100)).rejects.toBe(failure);
});
