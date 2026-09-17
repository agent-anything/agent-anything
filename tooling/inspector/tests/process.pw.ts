import {expect, test} from "@playwright/test";
import {fileURLToPath} from "node:url";
import {startInspectorServer} from "../dist/server/InspectorServer.js";
import {createTestRecording} from "./recording.js";

test("process lifetime, root exit, observation and recorded output remain independently inspectable", async ({page}, info) => {
  const recording = await createTestRecording();
  const r = recording.recorder;
  const process = r.ref("helarc-command", "process", "command-execution", "root-run");
  const run = r.ref("runtime", "run", "root-run", "root-run");
  const observation = r.ref("helarc-command", "process-observation", "command-observation", "root-run", "1");
  const link = (from:typeof process,to:typeof process,kind:"contains"|"observes") => ({from,to,kind,condition:null,operation:null,sourceLocation:null,targetLocation:null});
  const time = (seconds:number) => `2026-09-09T00:00:${String(seconds).padStart(2,"0")}Z`;
  r.offer({subject:process,occurredAt:time(1),payload:{kind:"lifecycle",revision:"1",states:["running","draining","settled"],transitions:[{id:"exit",from:"running",to:"draining",trigger:"scope empty"},{id:"drained",from:"draining",to:"settled",trigger:"output persisted"}]}});
  r.offer({subject:process,occurredAt:time(1),payload:{kind:"interval",activity:"process",phase:"started",status:null,clock:"test-process"}});
  r.offer({subject:process,occurredAt:time(7),payload:{kind:"process",revision:4,phase:"settled",backend:"windows_job",processId:42,helperProcessId:43,rootExit:{code:0,signal:null,observedAt:time(4)},containment:"empty",capture:"closed",persistence:"complete",outcome:"succeeded"},links:[link(run,process,"contains")],contents:[{name:"Process snapshot",stage:"committed",class:"execution",mediaType:"application/json",value:{processId:42,helperProcessId:43,rootExit:{code:0},scopeEmptyAt:time(6),outputClosedAt:time(7)}}]});
  r.offer({subject:process,occurredAt:time(6),payload:{kind:"transition",from:"running",to:"draining",revision:3,transitionId:"exit",reasonCode:"scope_empty"}});
  r.offer({subject:process,occurredAt:time(7),payload:{kind:"transition",from:"draining",to:"settled",revision:4,transitionId:"drained",reasonCode:"output_settled"}});
  r.offer({subject:process,occurredAt:time(6),payload:{kind:"interval",activity:"process",phase:"settled",status:"empty",clock:"test-process"}});
  r.offer({subject:process,occurredAt:time(6),payload:{kind:"interval",activity:"process-output",phase:"started",status:null,clock:"test-process"}});
  r.offer({subject:process,occurredAt:time(7),payload:{kind:"interval",activity:"process-output",phase:"settled",status:"complete",clock:"test-process"}});
  r.offer({subject:observation,occurredAt:time(7),payload:{kind:"process_observation",executionId:process.id,invocationId:"task-output-call",snapshotRevision:4,disposition:"returned",requestedWaitMs:10000,effectiveWaitMs:10000,elapsedWaitMs:450,returnReason:"process_settled",ranges:[{stream:"stdout",start:0,end:6,omitted:0}]},links:[link(process,observation,"contains"),link(observation,process,"observes")],contents:[{name:"Returned observation",stage:"returned",class:"execution",mediaType:"application/json",value:{stdout:{text:"ready\n",byteStart:0,byteEnd:6},outcome:"succeeded"}}]});
  await r.flush(); expect(r.health().rejected).toBe(0);
  const server = await startInspectorServer({root:recording.root,assets:fileURLToPath(new URL("../dist/renderer",import.meta.url))});
  try {
    const url = new URL(server.launchUrl);
    for(const [key,value] of Object.entries({source:recording.sourceId,dataset:recording.datasetId,area:"Runs",run:"root-run",view:"Timeline"}))url.searchParams.set(key,value);
    await page.goto(url.toString());
    await expect(page.locator(".vis-item").filter({hasText:"Root exit"})).toHaveCount(1);
    await expect(page.locator(".timeline-surface")).toContainText("process-output");
    await expect(page.locator(".vis-group-level-unknown-but-gte1")).toHaveCount(0);
    await page.screenshot({path:info.outputPath("process-timeline-desktop.png"),fullPage:true});
    url.hash="";url.searchParams.set("view","Lifecycle");url.searchParams.set("subject",JSON.stringify(process));
    await page.goto(url.toString());
    await expect(page.locator(".react-flow__node")).toHaveCount(3);
    await expect(page.locator(".react-flow__node").filter({hasText:"draining"})).toBeVisible();
    url.searchParams.set("view","Data Flow");url.searchParams.set("subject",JSON.stringify(observation));
    await page.goto(url.toString());
    await expect(page.locator(".react-flow__node")).not.toHaveCount(0);
    await page.screenshot({path:info.outputPath("process-data-flow-desktop.png"),fullPage:true});
    await page.setViewportSize({width:960,height:700});
    await expect(page.locator(".react-flow")).toBeVisible();
    expect(await page.evaluate(()=>document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({path:info.outputPath("process-data-flow-narrow.png"),fullPage:true});
  } finally { await server.close(); await recording.close(); }
});
