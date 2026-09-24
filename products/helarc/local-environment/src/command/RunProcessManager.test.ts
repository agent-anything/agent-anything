import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunProcessManager, type ManagedProcessStart, type RunProcessManagerOptions } from "./RunProcessManager.js";
import type { ProcessBackend, ProcessBackendEvent, ProcessBackendHandle } from "./ProcessBackend.js";
import { ProcessOutputStore, type ProcessOutputPaths } from "./ProcessOutputStore.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

async function setup(options: { instant?: boolean; observerThrows?: boolean; retainOutput?: RunProcessManagerOptions["retainOutput"] } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "helarc-process-test-")); directories.push(directory);
  const paths: ProcessOutputPaths = { stdout: join(directory, "stdout.raw"), stderr: join(directory, "stderr.raw"),
    stdoutText: join(directory, "stdout.txt"), stderrText: join(directory, "stderr.txt"), manifest: join(directory, "manifest.json") };
  let publish!: (event: ProcessBackendEvent) => void;
  const finish = (code = 0) => {
    publish({ kind: "root_exit", code, signal: null });
    publish({ kind: "scope_empty" }); publish({ kind: "output_closed", incomplete: false });
  };
  const handle: ProcessBackendHandle = { processId: 42, helperProcessId: null, startIdentity: "process-42-start-1",
    terminate: vi.fn(async () => { finish(1); return "forced" as const; }), close: vi.fn(async () => {}) };
  const backend: ProcessBackend = { descriptor: { kind: "windows_job", revision: "test", limitations: [] },
    launch: vi.fn(async (_request, listener) => { publish = listener; if (options.instant) finish(); return handle; }) };
  const controller = new AbortController();
  const input: ManagedProcessStart = { runId: "run-1", executionId: "process-1", actionId: "action-1", environmentId: "test",
    executable: "test", args: [], cwd: directory, environment: {}, timeoutMs: 60_000,
    deadlineAt: new Date(Date.now() + 120_000).toISOString(), runSignal: controller.signal, paths,
    maximumOutputBytes: 100_000, background: false };
  const manager = new RunProcessManager({ backend, maximumActive: 2, maximumSettled: 2,
    retainOutput: options.retainOutput,
    terminationTimeoutMs: 100, observer: options.observerThrows ? () => { throw new Error("observer"); } : undefined });
  const observe = (extra: Partial<Parameters<RunProcessManager["observe"]>[0]> = {}) => manager.observe({
    runId: input.runId, executionId: input.executionId, invocationId: "observation-1", waitMs: 0,
    signal: new AbortController().signal, ...extra });
  const cleanup = () => manager.finalizeRun({ runId: input.runId, deadlineAt: new Date(Date.now() + 1000).toISOString(), signal: new AbortController().signal });
  return { directory, paths, manager, input, observe, cleanup, handle, backend, finish, controller,
    emit: (event: ProcessBackendEvent) => publish(event) };
}

describe("RunProcessManager", () => {
  it("awaits historical registration before settlement", async () => {
    let release!: () => void;
    let entered!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const registering = new Promise<void>(resolve => { entered = resolve; });
    const retainOutput = vi.fn(async () => { entered(); await pending; });
    const t = await setup({ instant: true, retainOutput });
    await t.manager.start(t.input); await registering;
    expect(t.manager.get(t.input.runId, t.input.executionId).phase).toBe("draining");
    release(); await t.cleanup();
    expect(retainOutput).toHaveBeenCalledTimes(1);
    expect(t.manager.get(t.input.runId, t.input.executionId)).toMatchObject({ phase: "settled", output: { persistence: "complete" } });
  });
  it("records registration failure without replay or rewriting a successful exit", async () => {
    const t = await setup({ instant: true, retainOutput: async () => { throw new Error("disk failure"); } });
    await t.manager.start(t.input);
    const cleanup = await t.cleanup();
    expect(cleanup.completed).toBe(false);
    expect(t.backend.launch).toHaveBeenCalledTimes(1);
    expect(t.manager.get(t.input.runId, t.input.executionId)).toMatchObject({ phase: "settled", outcome: "succeeded",
      rootExit: { code: 0 }, output: { persistence: "failed" }, limitations: expect.arrayContaining(["process_output_retention_failed"]) });
  });
  it("keeps Desktop reads independent of observation, cwd and process control", async () => {
    const t = await setup();
    const commit = vi.fn(async (path: string) => path);
    await t.manager.start({ ...t.input, consumeFinalCwd: async () => t.directory, commitFinalCwd: commit });
    t.emit({ kind: "output", stream: "stdout", bytes: Buffer.from("hello") });
    const before = t.manager.get(t.input.runId, t.input.executionId);
    const first = t.manager.readOutput(t.input.runId, t.input.executionId);
    const second = t.manager.readOutput(t.input.runId, t.input.executionId);
    expect(first.stdout.text).toBe("hello");
    expect(second).toEqual(first);
    expect(t.manager.readOutput(t.input.runId, t.input.executionId, first.nextCursor).stdout.text).toBe("");
    expect(t.manager.get(t.input.runId, t.input.executionId)).toEqual(before);
    expect(commit).not.toHaveBeenCalled();
    expect(t.handle.terminate).not.toHaveBeenCalled();
    expect((await t.observe({ initial: true })).stdout.text).toBe("hello");
    expect(t.backend.launch).toHaveBeenCalledTimes(1);
    t.finish();
    await t.cleanup();
  });

  it("records settled retention expiry without losing live ownership or reconnecting", async () => {
    const t = await setup({instant:true});
    const facts: string[] = [];
    const manager = new RunProcessManager({backend:t.backend,maximumActive:2,maximumSettled:1,
      observer:fact=>{facts.push(fact.kind);}});
    await manager.start(t.input);
    await expect.poll(() => manager.get(t.input.runId, t.input.executionId).phase).toBe("settled");
    const paths=Object.fromEntries(Object.entries(t.paths).map(([key,path])=>[key,path+".second"])) as unknown as ProcessOutputPaths;
    await manager.start({...t.input,executionId:"process-2",paths});
    await expect.poll(() => manager.get(t.input.runId, "process-2").phase).toBe("settled");
    expect(()=>manager.get(t.input.runId,t.input.executionId)).toThrow("process_execution_expired");
    expect(()=>manager.get("other",t.input.executionId)).toThrow("process_execution_foreign_run");
    expect(manager.getRunAvailability(t.input.runId).retainedTaskCount).toBe(1);
    expect(facts).toContain("retention_expired");
    expect(t.backend.launch).toHaveBeenCalledTimes(2);
    await manager.finalizeRun({runId:t.input.runId,deadlineAt:t.input.deadlineAt,signal:new AbortController().signal});
  });

  it("returns continuing observations without relaunching or killing, and retains final output", async () => {
    const t = await setup(); await t.manager.start(t.input);
    const first = await t.observe({ initial: true });
    const availability = t.manager.getRunAvailability(t.input.runId);
    expect(first.snapshot.phase).toBe("running"); expect(first.snapshot.cwdDisposition).toBe("detached");
    expect(t.handle.terminate).not.toHaveBeenCalled();
    t.emit({ kind: "output", stream: "stdout", bytes: Buffer.from("hello") });
    expect(t.manager.getRunAvailability(t.input.runId)).toEqual(availability);
    const second = await t.observe({ cursor: first.nextCursor }); expect(second.stdout.text).toBe("hello");
    expect((await t.observe({ cursor: first.nextCursor })).stdout.text).toBe("hello");
    t.finish(); await t.cleanup();
    expect((await t.observe({ cursor: second.nextCursor })).snapshot.phase).toBe("settled");
    expect(t.backend.launch).toHaveBeenCalledTimes(1); expect(t.handle.close).toHaveBeenCalledTimes(1);
  });

  it("owns immediate exit events that arrive before launch returns", async () => {
    const t = await setup({ instant: true }); await t.manager.start(t.input); await t.cleanup();
    expect((await t.observe()).snapshot.outcome).toBe("succeeded"); expect(t.handle.close).toHaveBeenCalledTimes(1);
  });

  it("never renews the execution deadline when observations repeat", async () => {
    const t=await setup(); await t.manager.start({...t.input,timeoutMs:150});
    const deadline=(await t.observe()).snapshot.deadlineAt;
    await t.observe({waitMs:20}); await t.observe({waitMs:20});
    expect((await t.observe()).snapshot.deadlineAt).toBe(deadline);
    await expect.poll(()=>t.manager.get(t.input.runId,t.input.executionId).phase,{timeout:2000}).toBe("settled");
    const result=await t.observe();
    expect(result.snapshot).toMatchObject({outcome:"timed_out",termination:{reason:"execution_timeout"}});
    expect(t.backend.launch).toHaveBeenCalledTimes(1); expect(t.handle.terminate).toHaveBeenCalledTimes(1);
  });

  it("retains cancellation ownership while launch acknowledgement is pending", async () => {
    const t=await setup(); const launch=t.backend.launch;
    let finishLaunch!:()=>void;
    const gate=new Promise<void>(resolve=>{finishLaunch=resolve;});
    const backend:ProcessBackend={descriptor:t.backend.descriptor,launch:async (request,publish)=>{
      const handle=await launch(request,publish); await gate; return handle;
    }};
    const manager=new RunProcessManager({backend,maximumActive:1,maximumSettled:1,terminationTimeoutMs:100});
    const starting=manager.start(t.input);
    await expect.poll(()=>vi.mocked(launch).mock.calls.length).toBe(1);
    t.controller.abort(); finishLaunch(); await starting;
    const cleanup=await manager.finalizeRun({runId:t.input.runId,deadlineAt:t.input.deadlineAt,signal:new AbortController().signal});
    expect(cleanup.completed).toBe(true); expect(t.handle.terminate).toHaveBeenCalledTimes(1);
    expect(cleanup.executions[0]).toMatchObject({outcome:"cancelled",containment:{disposition:"empty"}});
  });

  it("keeps root exit, scope empty and output drain distinct", async () => {
    const t = await setup(); await t.manager.start(t.input);
    t.emit({ kind: "root_exit", code: 0, signal: null });
    expect((await t.observe()).snapshot.phase).toBe("running");
    t.emit({ kind: "scope_empty" });
    expect((await t.observe()).snapshot.phase).toBe("draining");
    t.emit({ kind: "output_closed", incomplete: false }); await t.cleanup();
    expect((await t.observe()).snapshot.phase).toBe("settled");
  });

  it("cancels an observation without terminating its process; Run cancellation does terminate", async () => {
    const t = await setup(); await t.manager.start(t.input);
    const cancel = new AbortController(); const waiting = t.observe({ waitMs: 1000, signal: cancel.signal });
    cancel.abort(); await expect(waiting).rejects.toMatchObject({ code: "process_observation_cancelled" });
    expect(t.handle.terminate).not.toHaveBeenCalled();
    t.controller.abort(); await t.cleanup(); expect(t.handle.terminate).toHaveBeenCalledTimes(1);
    expect((await t.observe()).snapshot.termination?.reason).toBe("run_cancelled");
  });

  it("waits without lost output wakeups and reports a quiet wait as expiry", async () => {
    const t = await setup(); await t.manager.start(t.input);
    const quiet = await t.observe({ waitMs: 5 }); expect(quiet.returnReason).toBe("observation_wait_limit");
    const next = t.observe({ waitMs: 1000 });
    t.emit({ kind: "output", stream: "stderr", bytes: Buffer.from("diagnostic") });
    expect((await next).stderr.text).toBe("diagnostic"); await t.cleanup();
  });

  it("rejects cross-Run access, duplicate launches and starts after finalization", async () => {
    const t = await setup(); await t.manager.start(t.input);
    await expect(t.manager.start(t.input)).rejects.toMatchObject({ code: "process_execution_duplicate" });
    await expect(t.observe({ runId: "another" })).rejects.toMatchObject({ code: "process_execution_foreign_run" });
    await t.cleanup(); await expect(t.manager.start({ ...t.input, executionId: "new" })).rejects.toMatchObject({ code: "process_run_closed" });
  });

  it("retains unresolved ownership across finalization and accepts late facts", async () => {
    const t = await setup(); vi.mocked(t.handle.terminate).mockResolvedValue("forced"); await t.manager.start(t.input);
    const summary = await t.cleanup(); expect(summary.completed).toBe(false);
    expect(t.manager.getRunAvailability(t.input.runId).activeTaskCount).toBe(1);
    t.finish(); expect((await t.cleanup()).completed).toBe(true);
  });

  it("cannot commit late cwd and observer failure does not change execution", async () => {
    const t = await setup({ observerThrows: true }); const commit = vi.fn(async (path: string) => path);
    await t.manager.start({ ...t.input, consumeFinalCwd: async () => "final", commitFinalCwd: commit });
    await t.observe({ initial: true }); t.finish(); await t.cleanup();
    const result = await t.observe(); expect(result.snapshot.finalCwd).toBe("final");
    expect(commit).not.toHaveBeenCalled(); expect(result.snapshot.outcome).toBe("succeeded");
  });
});

describe("ProcessOutputStore", () => {
  it("retains split decoder state and reports an incomplete final sequence without corrupting prior slices", async () => {
    const t = await setup(); const store = await ProcessOutputStore.create("split", t.paths, 10000);
    store.append("stdout", Buffer.concat([Buffer.alloc(4095, 65), Buffer.from([0xe2])]));
    const first = store.read();
    expect(first.stdout.projectionPending).toBe(true);
    expect(first.stdout.text).toBe("A".repeat(4095));
    store.append("stdout", Buffer.from([0x82, 0xac, 0xe2]));
    const second = store.read(first.nextCursor);
    expect(second.stdout.text).toBe("\u20ac"); expect(second.stdout.projectionPending).toBe(true);
    await store.close();
    const final = store.read(second.nextCursor);
    expect(final.stdout.integrity).toBe("lossy"); expect(final.stdout.text).toBe("\ufffd");
    expect(final.stdout.projectionPending).toBe(false);
    expect(first.stdout.integrity).toBe("exact");
  });

  it("detects a split UTF-16 BOM and reports persistence failures", async () => {
    const t = await setup(); const store = await ProcessOutputStore.create("utf16", t.paths, 10000);
    store.append("stdout", Buffer.from([0xff])); expect(store.read().stdout.projectionPending).toBe(true);
    store.append("stdout", Buffer.from([0xfe, 65, 0, 66]));
    const first = store.read(); expect(first.stdout.encoding).toBe("utf-16le"); expect(first.stdout.text).toBe("A");
    store.append("stdout", Buffer.from([0]));
    expect(store.read(first.nextCursor).stdout.text).toBe("B");
    const sync = vi.spyOn((store as unknown as {manifest:{sync():Promise<void>}}).manifest,"sync").mockRejectedValue(new Error("disk failure"));
    await expect(store.close()).rejects.toThrow("disk failure"); expect(store.status.failure).toBe("disk failure"); sync.mockRestore();
  });
  it("preserves independent cursors, streams, split UTF-8 and a shared cap", async () => {
    const t = await setup(); const store = await ProcessOutputStore.create("output-1", t.paths, 12);
    store.append("stdout", Buffer.from([0xe2])); store.append("stdout", Buffer.from([0x82, 0xac]));
    store.append("stderr", Buffer.from("warning"));
    const first = store.read(); expect(first.stdout.text).toBe("\u20ac"); expect(first.stderr.text).toBe("warning");
    expect(store.read().stdout.text).toBe(first.stdout.text);
    store.append("stdout", Buffer.from("123456"));
    const next = store.read(first.nextCursor); expect(next.stdout.text).toBe("12"); expect(next.stdout.omittedBytes).toBe(4);
    const closing = store.close(); expect(store.close()).toBe(closing); await closing;
    expect(() => store.read("invalid")).toThrow("process_output_cursor_invalid");
  });
});
