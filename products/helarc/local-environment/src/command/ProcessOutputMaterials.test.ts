import {describe,expect,it} from "vitest";
import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {ProcessOutputStore} from "./ProcessOutputStore.js";
import {describeProcessOutput,processOutputViewSegments} from "./ProcessOutputMaterials.js";
import type {ProcessSnapshot} from "./ProcessObservation.js";

function snapshot(capture: "open"|"incomplete"|"closed"="open",persistence:"pending"|"complete"|"failed"="pending") {
  return {ref:{runId:"run",executionId:"command"},output:{capture,persistence}} as ProcessSnapshot;
}
async function capture(work:(output:ProcessOutputStore)=>Promise<void>,limit=100000) {
  const directory=await mkdtemp(join(tmpdir(),"helarc-output-material-"));
  const output=await ProcessOutputStore.create("command",{stdout:join(directory,"out"),stderr:join(directory,"err"),
    stdoutText:join(directory,"out.txt"),stderrText:join(directory,"err.txt"),manifest:join(directory,"manifest")},limit);
  try {await work(output);} finally {await output.close();await rm(directory,{recursive:true,force:true});}
}
describe("immutable command output material views",()=>{
  it("keeps independent stream prefixes readable after growth and checks identity and content",async()=>{
    await capture(async output=>{
      output.append("stdout",Buffer.from("first"));output.append("stderr",Buffer.from("diagnostic"));
      const old=describeProcessOutput(output.checkpoint(),snapshot());
      output.append("stdout",Buffer.from(" second"));
      const current=output.checkpoint(),next=describeProcessOutput(current,snapshot());
      expect(processOutputViewSegments(current,old[0]!,"run").join("")).toBe("first");
      expect(processOutputViewSegments(current,old[1]!,"run").join("")).toBe("diagnostic");
      expect(next[0]!.reference).not.toEqual(old[0]!.reference);
      expect(next[1]).toEqual(old[1]);
      expect(()=>processOutputViewSegments(current,old[0]!,"foreign")).toThrow("identity");
      expect(()=>processOutputViewSegments(current,{...old[0]!,capture:"closed"},"run")).toThrow("identity");
      const corrupt=structuredClone(current);Object.assign(corrupt.streams.stdout.segments[0]!,{text:"other"});
      expect(()=>processOutputViewSegments(corrupt,old[0]!,"run")).toThrow("integrity");
    });
  });
  it("does not promise an incomplete decoder tail as readable text",async()=>{
    await capture(async output=>{
      output.append("stdout",Buffer.from([0xe2,0x82]));
      const pending=describeProcessOutput(output.checkpoint(),snapshot())[0]!;
      expect(pending).toMatchObject({bytes:0,projectionPending:true});
      output.append("stdout",Buffer.from([0xac]));
      const current=output.checkpoint(),view=describeProcessOutput(current,snapshot())[0]!;
      expect(processOutputViewSegments(current,pending,"run")).toEqual([]);
      expect(processOutputViewSegments(current,view,"run").join("")).toBe("\u20ac");
      expect(view).toMatchObject({bytes:3,projectionPending:false});
    });
  });
  it("retains omissions, lossy decoding and failed source capture independently of readable bytes",async()=>{
    await capture(async output=>{
      output.append("stdout",Buffer.from("abcd"));output.checkpoint();
      output.append("stdout",Buffer.from([0xff,0xff,0xff,0xff]));
      await output.close();
      const current=output.checkpoint(),view=describeProcessOutput(current,snapshot("incomplete","failed"))[0]!;
      expect(view).toMatchObject({integrity:"lossy",omittedBytes:2,capture:"incomplete",capturePersistence:"failed"});
      expect(processOutputViewSegments(current,view,"run").join("")).toBe("abcd\ufffd\ufffd");
    },6);
  });
});
