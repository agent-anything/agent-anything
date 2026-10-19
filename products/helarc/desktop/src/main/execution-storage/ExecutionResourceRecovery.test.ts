import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { RunProcessManager, type ShellSessionCommit } from "@agent-anything/helarc-local-environment/command";
import type { AgentHookInvocationCheckpoint } from "@agent-anything/agent-hooks/execution";
import { HelarcExecutionStore } from "./HelarcExecutionStore.js";
import {openExecutionStoreFixture} from "./fixtures/ExecutionEnvironmentFixture.js";
import { reconcileInterruptedHooks } from "./reconcileInterruptedHooks.js";

const directories: string[] = [];
const stores: HelarcExecutionStore[] = [];
const worker = pathToFileURL(join(process.cwd(), "dist/main/execution-storage/ExecutionStoreWorker.js"));
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close().catch(() => {});
  for (const directory of directories.splice(0)) await rm(directory, {recursive: true, force: true});
});
async function open(path: string) {
  const store = await openExecutionStoreFixture(path, worker);
  stores.push(store);
  return store;
}
async function directory() {
  const path = await mkdtemp(join(tmpdir(), "helarc-resource-recovery-"));
  directories.push(path);
  return path;
}

describe("execution resource recovery", () => {
  it("rejects overlapping Root activation and makes lease release idempotent", async () => {
    const store = await open(await directory());
    const release = store.acquireRun("root");
    expect(() => store.acquireRun("root")).toThrow("execution_run_already_active");
    release();
    const next = store.acquireRun("root");
    release();
    expect(() => store.acquireRun("root")).toThrow("execution_run_already_active");
    next();
  });

  it("retains Shell cwd transitions and settles interrupted Hooks once after Worker restart", async () => {
    const path = await directory();
    const first = await open(path);
    const cwd: ShellSessionCommit = {runId: "run", executionId: "process", before: {
      revision: 0, rootName: "workspace", relativePath: ".", canonicalPath: path}, after: {
      revision: 1, rootName: "workspace", relativePath: "sub", canonicalPath: join(path, "sub")}};
    await first.commitShellSession(cwd);
    await first.commitShellSession(cwd);
    const event: AgentHookInvocationCheckpoint["event"] = {
      ref: {run: {id: "run"}, id: "stop-failure", sequence: 1, revision: "1"}, point: "StopFailure",
      run: {id: "run"}, runKind: "root", agent: {id: "agent", revision: "1"},
      task: {id: "task", kind: "inspect", createdAt: "2026-10-15T00:00:00Z", metadata: {}, input: {prompt: "Inspect"}}, controllerRequestId: "request", iteration: 1,
      failure: {name: "Error", code: null, message: "Request interrupted"}, emittedAt: "2026-10-15T00:00:00Z",
    };
    const registration: AgentHookInvocationCheckpoint["registration"] = {ref: {owner: "product", id: "observer", revision: "1"},
      point: "StopFailure", mode: "background", runKinds: ["root"], handler: {id: "observer", revision: "1"},
      timeoutMs: 1000, maximumResultBytes: 1024};
    const hook: AgentHookInvocationCheckpoint = {id: JSON.stringify([event.ref.id, registration.ref, registration.mode]), version: 1, event,
      registration, startedAt: event.emittedAt, outcome: null};
    await first.commitHookInvocation(hook);
    await first.close();
    const reopened = await open(path);
    expect(await reopened.readShellSession("run")).toEqual(cwd);
    await expect(reopened.commitShellSession({...cwd, executionId: "other"})).rejects.toThrow("execution_shell_session_conflict");
    const observe = vi.fn();
    await reconcileInterruptedHooks(reopened, observe, () => "2026-10-15T00:00:01Z");
    await reconcileInterruptedHooks(reopened, observe);
    expect(observe).toHaveBeenCalledTimes(1);
    expect(await reopened.listUnsettledHooks()).toEqual([]);
    expect(await reopened.readHookInvocation(hook.id)).toMatchObject({outcome: {status: "failed", message: expect.stringContaining("not replayed")}});
    await expect(reopened.commitHookInvocation({...hook, outcome: {status: "completed", value: null,
      startedAt: hook.startedAt, completedAt: "2026-10-15T00:00:02Z"}})).rejects.toThrow();
  });

  it("retains exact output delivery and removes the process pin only after acknowledged settlement", async () => {
    const path = await directory();
    const storePath = join(path, "execution");
    const store = await open(storePath);
    type Backend = ConstructorParameters<typeof RunProcessManager>[0]["backend"];
    let publish!: Parameters<Backend["launch"]>[1];
    const finish = () => {
      publish({kind: "root_exit", code: 0, signal: null});
      publish({kind: "scope_empty"});
      publish({kind: "output_closed", incomplete: false});
    };
    const launch = vi.fn<Backend["launch"]>(async (_request, listener) => {
      publish = listener;
      return {processId: 42, helperProcessId: null, startIdentity: "test-start",
        async terminate() {finish(); return "forced";}, async close() {}};
    });
    const backend: Backend = {descriptor: {kind: "windows_job", revision: "test", limitations: []}, launch};
    const make = (records: HelarcExecutionStore) => new RunProcessManager({backend, records, scopeId: "manager",
      maximumActive: 2, maximumSettled: 2});
    const manager = make(store);
    const paths = {stdout: join(path, "stdout.raw"), stderr: join(path, "stderr.raw"), stdoutText: join(path, "stdout.txt"),
      stderrText: join(path, "stderr.txt"), manifest: join(path, "manifest.json")};
    const runId = "run", executionId = "process";
    const finalize = () => manager.finalizeRun({runId, deadlineAt: new Date(Date.now() + 5000).toISOString(), signal: new AbortController().signal});
    let closed = false;
    try {
      await manager.start({runId, executionId, actionId: "action", environmentId: "test", executable: "test", args: [],
        cwd: path, environment: {}, timeoutMs: 60_000, deadlineAt: new Date(Date.now() + 120_000).toISOString(),
        runSignal: new AbortController().signal, paths, maximumOutputBytes: 10_000, background: false,
        origin: {invocationId: "call", runActionId: "run-action", attemptId: "attempt"}});
      publish({kind: "output", stream: "stdout", bytes: Buffer.from("first")});
      const observation = {runId, executionId, invocationId: "observe", initial: true, waitMs: 0, signal: new AbortController().signal};
      const initial = await manager.observe(observation);
      await manager.commitInitialDelivery({runId, runActionId: "run-action", settlementId: "settlement",
        observationId: initial.id, cursor: initial.nextCursor});
      expect(await store.listRetentionPins()).toContainEqual({ownerId: executionId, reason: "unsettled_process"});
      publish({kind: "output", stream: "stdout", bytes: Buffer.from("second")});
      finish();
      await finalize();
      await manager.flushRun(runId);
      const notifications = manager.readInputNotifications(runId, 0);
      expect(await store.listRetentionPins()).toEqual([]);
      const retainedCheckpoint = (await store.readProcesses(runId))[0]!;
      await store.close();
      closed = true;
      const reopened = await open(storePath);
      // A fresh cipher produces a new ciphertext, but the same checkpoint is a replay.
      await reopened.commitProcess(retainedCheckpoint);
      await expect(reopened.commitProcess({...retainedCheckpoint, input: {...retainedCheckpoint.input,
        environment: {...retainedCheckpoint.input.environment, CHANGED: "not-the-original-environment"}}})).rejects.toThrow("execution_process_record_conflict");
      const restored = make(reopened);
      await restored.restoreRun(runId);
      expect(await restored.observe(observation)).toEqual(initial);
      expect(restored.readOutput(runId, executionId, initial.nextCursor).stdout.text).toBe("second");
      expect(restored.readInputNotifications(runId, 0)).toEqual(notifications);
      await restored.commitInitialDelivery({runId, runActionId: "run-action", settlementId: "settlement",
        observationId: initial.id, cursor: initial.nextCursor});
      expect(launch).toHaveBeenCalledTimes(1);
    } finally {if (!closed) await finalize();}
  }, 15_000);
});
