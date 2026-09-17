import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join,relative} from "node:path";
import {expect,it} from "vitest";
import {InspectionQueryService} from "@agent-anything/inspection/query";
import {RunProcessManager} from "@agent-anything/helarc-local-environment/command";
import {HelarcInspection} from "./HelarcInspection.js";

it("records independent process lifetimes and immutable observations before Run finalization",async()=>{
  const directory=await mkdtemp(join(tmpdir(),"helarc-process-inspection-"));
  const root=join(directory,"inspection");
  const inspection=await HelarcInspection.create(join(directory,"settings.json"),root);
  const queries=new InspectionQueryService(root);
  type Backend=ConstructorParameters<typeof RunProcessManager>[0]["backend"];
  type Publish=Parameters<Backend["launch"]>[1];
  const publishers=new Map<string,Publish>();
  const backend:Backend={descriptor:{kind:"windows_job",revision:"test",limitations:[]},async launch(request,publish){
    publishers.set(request.executionId,publish);
    return {processId:100+publishers.size,helperProcessId:200+publishers.size,startIdentity:request.executionId,
      async terminate(){publish({kind:"root_exit",code:1,signal:null});publish({kind:"scope_empty"});publish({kind:"output_closed",incomplete:false});return "forced";},async close(){}};
  }};
  const manager=new RunProcessManager({backend,maximumActive:4,maximumSettled:8,observer:inspection.processObserver});
  const controller=new AbortController();
  const start=(id:string)=>manager.start({runId:"run",executionId:id,actionId:`${id}-action`,origin:{invocationId:`${id}-start`,runActionId:`${id}-run-action`,attemptId:`${id}-attempt`},
    environmentId:"local",executable:"fixture",args:[],cwd:directory,environment:{},timeoutMs:10000,deadlineAt:new Date(Date.now()+20000).toISOString(),runSignal:controller.signal,
    paths:{stdout:join(directory,`${id}.raw`),stderr:join(directory,`${id}.err`),stdoutText:join(directory,`${id}.txt`),stderrText:join(directory,`${id}.err.txt`),manifest:join(directory,`${id}.json`)},
    displayFiles:{stdout:`${id}.txt`,stderr:`${id}.err.txt`},maximumOutputBytes:65536,background:true});
  try {
    await start("a");await start("b");
    const observed=await manager.observe({runId:"run",executionId:"a",invocationId:"initial",waitMs:0,signal:controller.signal,initial:true});
    expect(observed.snapshot.phase).toBe("running");
    const r=inspection.recorder!;
    await r.flush();
    expect(r.health().available,JSON.stringify(r.health())).toBe(true);
    const ids={sourceId:r.source.sourceId,datasetId:r.manifest.datasetId};
    const before=(await queries.query({kind:"get_snapshot",...ids})).selection!;
    const subject=r.ref("helarc-command","process","a","run");
    const finish=publishers.get("a")!;
    finish({kind:"output",stream:"stdout",bytes:Buffer.from("captured-output")});
    finish({kind:"root_exit",code:0,signal:null});finish({kind:"scope_empty"});finish({kind:"output_closed",incomplete:false});
    await expect.poll(()=>manager.get("run","a").phase).toBe("settled");
    const returned=await manager.observe({runId:"run",executionId:"a",invocationId:"later",waitMs:0,signal:controller.signal});
    expect(returned.stdout.text).toBe("captured-output");
    await r.flush();
    const current=(await queries.query({kind:"get_snapshot",...ids})).selection!;
    expect((await queries.query({kind:"get_subject",...before,subject})).records[0]?.payload).toMatchObject({kind:"process",phase:"running"});
    expect((await queries.query({kind:"get_subject",...current,subject})).records[0]?.payload).toMatchObject({kind:"process",phase:"settled"});
    const lifetime=await queries.query({kind:"get_timeline",...current,runId:"run",limit:500});
    expect(lifetime.intervals.filter(i=>i.activity === "process")).toHaveLength(2);
    expect(lifetime.intervals.find(i=>i.activity === "process" && i.subject.id === "a")?.end).not.toBeNull();
    expect(lifetime.intervals.find(i=>i.activity === "process" && i.subject.id === "a")?.markers).toEqual([
      expect.objectContaining({label:"Root exit 0",occurredAt:returned.snapshot.rootExit!.observedAt}),
    ]);
    expect(lifetime.intervals.find(i=>i.activity === "process" && i.subject.id === "b")?.end).toBeNull();
    expect(lifetime.intervals.filter(i=>i.activity === "wait")).toHaveLength(2);
    const observation=r.ref("helarc-command","process-observation",returned.id,"run","1");
    const data=await queries.query({kind:"get_data_flow",...current,subject:observation});
    expect(data.graph?.links).toContainEqual(expect.objectContaining({kind:"observes",to:expect.objectContaining({id:"a",revision:String(returned.snapshot.revision)})}));
    const included=data.graph?.links.filter(link=>link.kind === "includes" && link.to.id === returned.id);
    expect(included).toHaveLength(2);
    expect(included?.every(link=>link.sourceLocation?.contentId && link.targetLocation?.contentId)).toBe(true);
    const lifecycle=await queries.query({kind:"get_lifecycle",...current,subject});
    expect(lifecycle.records.filter(record=>record.payload.kind === "transition").map(record=>record.payload.kind === "transition" ? record.payload.to:null)).toEqual(["starting","running","draining","settled"]);
    expect(lifecycle.relatedRecords?.length).toBeGreaterThan(0);
    const flows=await queries.query({kind:"get_execution_flow",...current,runId:"run"});
    expect(JSON.stringify(flows)).toContain("process-lifetime");
    expect(r.health().rejected).toBe(0);
    expect((await manager.finalizeRun({runId:"run",deadlineAt:new Date(Date.now()+3000).toISOString(),signal:controller.signal})).completed).toBe(true);
    await r.flush();
    expect(r.health().rejected).toBe(0);
  } finally {
    controller.abort();
    await manager.finalizeRun({runId:"run",deadlineAt:new Date(Date.now()+3000).toISOString(),signal:new AbortController().signal});
    await inspection.close();await queries.close();
    if(!relative(tmpdir(),directory).startsWith("helarc-process-inspection-"))throw Error("Unsafe test cleanup");
    await rm(directory,{recursive:true,force:true});
  }
},30000);
