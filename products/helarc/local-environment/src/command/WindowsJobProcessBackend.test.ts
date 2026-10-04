import { describe, expect, it } from "vitest";
import { dirname, join } from "node:path";
import { WindowsJobProcessBackend, resolveWindowsProcessHelper } from "./WindowsJobProcessBackend.js";
import type { ProcessBackendEvent } from "./ProcessBackend.js";
import {fork} from "node:child_process";
import {fileURLToPath} from "node:url";
import {copyFile, mkdtemp, readFile, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {RunProcessManager} from "./RunProcessManager.js";

describe.skipIf(process.platform !== "win32")("Windows Job process backend", () => {
  async function run(args: string[]) {
    const helper = await resolveWindowsProcessHelper();
    const backend = new WindowsJobProcessBackend(helper);
    const events: ProcessBackendEvent[] = [];
    let resolve!: () => void; let reject!: (error: Error) => void;
    const closed = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
    const handle = await backend.launch({ executionId: "native-test", executable: join(dirname(helper), "process-fixture.exe"),
      args, cwd: dirname(helper), environment: Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
      signal: new AbortController().signal, startupTimeoutMs: 3000 }, (event) => {
      events.push(event); if (event.kind === "output_closed") resolve();
      if (event.kind === "failure") reject(new Error(event.code));
    });
    const finish = async () => {
      await closed;
      await expect.poll(() => events.some(event => event.kind === "scope_empty")).toBe(true);
      await handle.close();
    };
    return { handle, events, closed, finish };
  }

  it("starts the command, preserves Unicode arguments and separates raw streams", async () => {
    const t = await run(["output", "a \"quoted\" \u4e2d\u6587 value\\"]); await t.finish();
    expect(t.handle.processId).not.toBe(t.handle.helperProcessId);
    const text = (stream: string) => Buffer.concat(t.events.flatMap((e) => e.kind === "output" && e.stream === stream ? [Buffer.from(e.bytes)] : [])).toString("utf8");
    expect(text("stdout")).toContain('a "quoted" \u4e2d\u6587 value\\'); expect(text("stderr")).toContain("diagnostic");
    expect(t.events).toContainEqual({ kind: "root_exit", code: 0, signal: null });
    expect(t.events).toContainEqual({ kind: "scope_empty" });
  });

  it("retains Job ownership after root exit until descendants exit", async () => {
    const started = performance.now(); const t = await run(["child", "300"]); await t.finish();
    expect(performance.now() - started).toBeGreaterThan(250);
    expect(t.events.findIndex((e) => e.kind === "root_exit")).toBeLessThan(t.events.findIndex((e) => e.kind === "scope_empty"));
  });

  it("terminates a live Job and confirms containment separately from acknowledgement", async () => {
    const t = await run(["sleep", "60000"]);
    expect(await t.handle.terminate()).toBe("forced"); await t.finish();
    expect(t.events).toContainEqual({ kind: "root_exit", code: 1, signal: null });
    expect(t.events.findIndex(event => event.kind === "root_exit")).toBeLessThan(t.events.findIndex(event => event.kind === "scope_empty"));
    expect(t.events).toContainEqual({ kind: "scope_empty" });
    expect(t.events).toContainEqual({ kind: "output_closed", incomplete: false });
  });

  it("keeps the helper and Job alive after pipe EOF and reports remaining executable identities", async () => {
    const t = await run(["child-closed", "60000"]);
    try {
      await t.closed;
      expect(t.events.some(event => event.kind === "scope_empty")).toBe(false);
      expect(alive(t.handle.helperProcessId!)).toBe(true);
      await expect.poll(() => t.events.some(event => event.kind === "scope_members" && event.snapshot.members.length > 0)).toBe(true);
      const members = t.events.flatMap(event => event.kind === "scope_members" ? event.snapshot.members : []);
      expect(members.some(member => member.pid !== t.handle.processId && member.identity !== null && member.executable?.endsWith("process-fixture.exe"))).toBe(true);
      expect(await t.handle.terminate()).toBe("forced");
      await expect.poll(() => t.events.some(event => event.kind === "scope_empty")).toBe(true);
      expect(t.events.some(event => event.kind === "failure")).toBe(false);
    } finally {await t.handle.close();}
  });

  it("reports helper loss even after the streams have closed while its Job was still active", async () => {
    const t = await run(["child-closed", "60000"]);
    try {
      await t.closed;
      process.kill(t.handle.helperProcessId!);
      await expect.poll(() => t.events.some(event => event.kind === "failure" && event.code === "process_backend_lost")).toBe(true);
      expect(t.events.some(event => event.kind === "scope_empty")).toBe(false);
    } finally {await t.handle.close();}
  });

  it("returns a real root result without waiting for inherited pipes or timing out the surviving Job", async () => {
    const helper = await resolveWindowsProcessHelper();
    const directory = await mkdtemp(join(tmpdir(), "helarc-native-result-"));
    const manager = new RunProcessManager({backend: new WindowsJobProcessBackend(helper), maximumActive: 1, maximumSettled: 1});
    try {
      await manager.start({runId: "native-run", executionId: "native-result", actionId: "native-action", environmentId: "test",
        executable: join(dirname(helper), "process-fixture.exe"), args: ["child", "60000"], cwd: directory,
        environment: Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
        timeoutMs: 200, deadlineAt: new Date(Date.now() + 10_000).toISOString(), runSignal: new AbortController().signal,
        paths: {stdout: join(directory, "out.raw"), stderr: join(directory, "err.raw"), stdoutText: join(directory, "out.txt"),
          stderrText: join(directory, "err.txt"), manifest: join(directory, "manifest.json")}, maximumOutputBytes: 10_000, background: false});
      const observation = await manager.observe({runId: "native-run", executionId: "native-result", invocationId: "initial",
        initial: true, waitMs: 350, signal: new AbortController().signal});
      expect(observation).toMatchObject({returnReason: "command_completed", snapshot: {outcome: "succeeded", rootExit: {code: 0},
        phase: "running", termination: null, containment: {disposition: "active"}, output: {capture: "open"}}});
      const cleanup = await manager.finalizeRun({runId: "native-run", deadlineAt: new Date(Date.now() + 3000).toISOString(), signal: new AbortController().signal});
      expect(cleanup.completed).toBe(true);
      expect(cleanup.executions[0]).toMatchObject({outcome: "succeeded", termination: {reason: "run_finalization"}});
    } finally {
      await manager.finalizeRun({runId: "native-run", deadlineAt: new Date(Date.now() + 3000).toISOString(), signal: new AbortController().signal});
      await rm(directory, {recursive: true, force: true});
    }
  });

  it("drains large output through the real framed transport", async () => {
    const t = await run(["flood"]); await t.finish();
    expect(t.events.reduce((sum, event) => sum + (event.kind === "output" ? event.bytes.length : 0), 0)).toBe(4096 * 4096);
  });

  it("does not substitute another backend for an absent artifact", async () => {
    await expect(resolveWindowsProcessHelper(join(process.cwd(), "absent-artifact"))).rejects.toMatchObject({ code: "process_helper_unavailable" });
  });

  it("resolves a deployed package artifact and rejects a changed binary", async () => {
    const original=await resolveWindowsProcessHelper();
    const directory=await mkdtemp(join(tmpdir(),"helarc-native-package-"));
    try {
      await copyFile(original,join(directory,"helarc-process-helper.exe"));
      await copyFile(join(dirname(original),"manifest.json"),join(directory,"manifest.json"));
      const deployed=await resolveWindowsProcessHelper(directory);
      const cancelled=new AbortController();cancelled.abort();
      await expect(new WindowsJobProcessBackend(deployed).launch({executionId:"cancelled",executable:deployed,args:[],cwd:directory,environment:{},signal:cancelled.signal,startupTimeoutMs:1000},()=>{}))
        .rejects.toMatchObject({code:"process_start_cancelled",effectState:"none"});
      const binary=await readFile(deployed);binary[0]=0;
      await writeFile(deployed,binary);
      await expect(resolveWindowsProcessHelper(directory)).rejects.toMatchObject({code:"process_helper_unavailable",effectState:"none"});
    } finally {await rm(directory,{recursive:true,force:true});}
  });

  it("Host death releases Job ownership and kills the command", async () => {
    const host = fork(fileURLToPath(new URL("./fixtures/process-host.mjs", import.meta.url)), [], {stdio:"ignore"});
    const message = await new Promise<{pid:number;helperPid:number}>((resolve,reject)=>{
      host.once("message",resolve as (value:unknown)=>void); host.once("error",reject);
      host.once("exit",()=>reject(new Error("Host exited before launch")));
    });
    host.kill();
    await expect.poll(()=>alive(message.pid),{timeout:4000}).toBe(false);
    await expect.poll(()=>alive(message.helperPid),{timeout:4000}).toBe(false);
  });

  it("helper loss kills its Job without fabricating scope-empty confirmation", async () => {
    const t = await run(["sleep","60000"]);
    const failure = t.closed.catch(error=>error);
    process.kill(t.handle.helperProcessId!);
    await expect.poll(()=>alive(t.handle.processId),{timeout:4000}).toBe(false);
    expect(await failure).toBeInstanceOf(Error);
    expect(t.events.some(event=>event.kind === "scope_empty")).toBe(false);
    await t.handle.close();
  });
});

function alive(pid:number):boolean { try {process.kill(pid,0);return true;} catch {return false;} }
