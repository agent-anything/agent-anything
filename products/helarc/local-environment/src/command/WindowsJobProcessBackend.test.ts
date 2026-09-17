import { describe, expect, it } from "vitest";
import { dirname, join } from "node:path";
import { WindowsJobProcessBackend, resolveWindowsProcessHelper } from "./WindowsJobProcessBackend.js";
import type { ProcessBackendEvent } from "./ProcessBackend.js";
import {fork} from "node:child_process";
import {fileURLToPath} from "node:url";
import {copyFile, mkdtemp, readFile, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";

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
    return { handle, events, closed };
  }

  it("starts the command, preserves Unicode arguments and separates raw streams", async () => {
    const t = await run(["output", "a \"quoted\" \u4e2d\u6587 value\\"]); await t.closed; await t.handle.close();
    expect(t.handle.processId).not.toBe(t.handle.helperProcessId);
    const text = (stream: string) => Buffer.concat(t.events.flatMap((e) => e.kind === "output" && e.stream === stream ? [Buffer.from(e.bytes)] : [])).toString("utf8");
    expect(text("stdout")).toContain('a "quoted" \u4e2d\u6587 value\\'); expect(text("stderr")).toContain("diagnostic");
    expect(t.events).toContainEqual({ kind: "root_exit", code: 0, signal: null });
    expect(t.events).toContainEqual({ kind: "scope_empty" });
  });

  it("retains Job ownership after root exit until descendants exit", async () => {
    const started = performance.now(); const t = await run(["child", "300"]); await t.closed; await t.handle.close();
    expect(performance.now() - started).toBeGreaterThan(250);
    expect(t.events.findIndex((e) => e.kind === "root_exit")).toBeLessThan(t.events.findIndex((e) => e.kind === "scope_empty"));
  });

  it("terminates a live Job and confirms containment separately from acknowledgement", async () => {
    const t = await run(["sleep", "60000"]);
    expect(await t.handle.terminate()).toBe("forced"); await t.closed; await t.handle.close();
    expect(t.events).toContainEqual({ kind: "scope_empty" });
    expect(t.events).toContainEqual({ kind: "output_closed", incomplete: false });
  });

  it("drains large output through the real framed transport", async () => {
    const t = await run(["flood"]); await t.closed; await t.handle.close();
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
