import {expect, test, type Page} from "@playwright/test";
import {fileURLToPath} from "node:url";
import {startInspectorServer} from "../dist/server/InspectorServer.js";
import {createTestRecording} from "./recording.js";
import {InspectionRecorder} from "@agent-anything/inspection/recording";
import {InspectionQueryService} from "@agent-anything/inspection/query";
import type {InspectionSubjectRef, InspectionProcessEvidence, InspectionLink} from "@agent-anything/inspection/records";

function fact(r: InspectionRecorder, id: string, category: InspectionProcessEvidence["category"], run = "root-run", status = "recorded", relationCount=0) {
  const subject = r.ref("context-test", "contribution", id, run, "1");
  r.offer({id, subject, occurredAt: null, payload: {kind: "process_evidence", version: "1", origin: {owner: "context-test", id, runId: run, revision: "1"}, digest: "basis-"+id,
    subject, category, name: id, status, purpose: "task", recipient: {runId: run, recipient: "assistant", purpose: "task"}, relationCount,
    ...(category === "decision" ? {judgment: {foreground: "continue", investment: "keep", adoption: null, detailsContentOrdinal: 0}} : {})},
    contents: [{name: "Original "+id, stage: "accepted", class: "agent", mediaType: "application/json", value: {id, preserved: true}}]});
  return subject;
}
function relation(r: InspectionRecorder, id: string, from: InspectionSubjectRef, to: InspectionSubjectRef, kind: InspectionLink["kind"]) {
  r.offer({id, subject: from, occurredAt: null, payload: {kind: "process_relationship",version:"1",evidence:{origin:{owner:"context-test",id:from.id,runId:from.runId,revision:"1"},digest:"basis-"+from.id},ordinal:0,total:1}, links: [{from, to, kind, condition: kind === "prerequisite" ? "result" : null, operation: id, sourceLocation: null, targetLocation: null}]});
}
async function focus(page: Page, name: string) {
  await page.locator(".process-fact-button").filter({hasText: name}).first().click();
  await expect(page.getByRole("dialog", {name: "Process evidence", exact: true})).toBeVisible();
}
test("fixed investigation keeps focus, pagination, refresh and original content independent", async ({page}, info) => {
  const recording = await createTestRecording(), r = recording.recorder;
  const d = fact(r, "keep-without-model-request", "decision","root-run","recorded",1);
  const input = fact(r, "accepted-input-not-yet-dispatched", "input");
  relation(r, "decision-binds-input", d, input, "binding");
  for (let i=0;i<22;i++) fact(r, "decision-"+i, "decision");
  const source = fact(r, "child-original-result", "source", "child-investigation","recorded",1);
  const delivery = fact(r, "parent-pending-delivery", "delivery");
  relation(r, "child-result-to-parent", source, delivery, "delivers");
  const path = fact(r, "professional-method", "method","root-run","recorded",1);
  const wait = fact(r, "dependency-wait", "coordination", "root-run", "waiting");
  relation(r, "wait-for-method-result", path, wait, "prerequisite");
  const recovery = fact(r, "original-result-reused", "recovery","root-run","recorded",1);
  relation(r, "reuse-bound-input", recovery, input, "resume");
  await r.flush();
  const server = await startInspectorServer({root: recording.root, assets: fileURLToPath(new URL("../dist/renderer", import.meta.url))});
  try {
    const url = new URL(server.launchUrl); url.searchParams.set("source", recording.sourceId); url.searchParams.set("dataset", recording.datasetId); url.searchParams.set("area", "Context Process"); url.searchParams.set("run", "root-run");
    await page.goto(url.toString());
    await expect(page.locator(".process-facts-table .ant-table-row")).toHaveCount(20);
    const manifest = new URL(page.url()).searchParams.get("cpManifest");
    await focus(page, "keep-without-model-request");
    await page.getByRole("button", {name: "Original keep-without-model-request", exact: true}).click();
    await expect(page.getByRole("dialog", {name: "Original keep-without-model-request", exact: true})).toBeVisible();
    await page.getByRole("dialog", {name: "Original keep-without-model-request", exact: true}).getByRole("button", {name: "Close", exact: true}).click();
    const drawer = page.getByRole("dialog", {name: "Process evidence", exact: true});
    await drawer.getByRole("tab", {name: "Relationships", exact: true}).click();
    await expect(drawer).toContainText("decision-binds-input");
    await drawer.getByRole("tab", {name: "Local graph", exact: true}).click();
    await expect(drawer.locator(".graph-surface")).toHaveAttribute("data-layout", "ready");
    await page.screenshot({path: info.outputPath("process-graph-desktop.png"), fullPage: true});
    await page.setViewportSize({width: 600, height: 900});
    await page.screenshot({path: info.outputPath("process-graph-narrow.png"), fullPage: true});
    expect(await drawer.evaluate(el=>el.scrollWidth<=el.clientWidth+1)).toBe(true);
    await drawer.getByRole("button", {name: "Close", exact: true}).click();
    await page.setViewportSize({width: 1440, height: 960});
    await page.getByRole("button", {name: "Next evidence page", exact: true}).click();
    await expect(page.locator(".process-facts-table .ant-table-row")).toHaveCount(4);
    const paged = page.url();
    await page.getByRole("tab", {name: "Information Flow", exact: true}).click();
    await expect(page.locator(".process-facts-table")).toContainText("parent-pending-delivery");
    await page.goBack();
    await expect(page).toHaveURL(paged);
    expect(new URL(page.url()).searchParams.get("cpManifest")).toBe(manifest);
    fact(r, "late-decision", "decision"); await r.flush();
    await expect(page.locator(".process-facts-table")).not.toContainText("late-decision");
    await page.getByRole("button", {name: "Refresh", exact: true}).click();
    await expect.poll(()=>new URL(page.url()).searchParams.get("cpManifest")).not.toBe(manifest);
    await page.getByRole("tab", {name: "Methods / Cooperation", exact: true}).click();
    await focus(page, "dependency-wait"); await drawer.getByRole("button",{name:"All facts for this object",exact:true}).click();await drawer.getByRole("tab", {name: "Relationships", exact: true}).click();
    await expect(drawer).toContainText("wait-for-method-result"); await drawer.getByRole("button", {name:"Close",exact:true}).click();
    await page.getByRole("tab", {name: "Adoption / Recovery", exact: true}).click();
    await focus(page, "original-result-reused"); await drawer.getByRole("tab", {name: "Relationships", exact: true}).click();
    await expect(drawer).toContainText("reuse-bound-input");
  } finally {await server.close(); await recording.close();}
});

test("real Electron recovery recordings support five views and exact original evidence", async ({page}, info) => {
  const root = process.env.INSPECTOR_PROCESS_RECORDING;
  test.skip(!root, "Provide an isolated B1-B4 Electron recording, never user production data");
  const queries = new InspectionQueryService(root!);
  const sources = (await queries.query({kind:"list_sources"})).sources;
  const sourceId = sources[0]!.sourceId;
  const datasets = (await queries.query({kind:"list_datasets",sourceId})).datasets;
  const datasetId = datasets[0]!.datasetId;
  const snapshot = (await queries.query({kind:"get_snapshot",sourceId,datasetId})).selection!;
  const runs = (await queries.query({...snapshot,kind:"list_runs",limit:100})).records;
  const runId = runs.find(r=>r.payload.kind==="snapshot"&&r.payload.parentRunId===null)?.subject.id ?? "root";
  const manifest = (await queries.query({kind:"open_process_scope",recordings:[{...snapshot,via:null}]})).process!.manifest;
  const facts = (await queries.query({kind:"list_context_process",manifest,runId,section:"facts",categories:["decision","input"],limit:100})).process!.entries;
  expect(facts.length).toBeGreaterThan(0);
  const server = await startInspectorServer({root:root!,assets:fileURLToPath(new URL("../dist/renderer",import.meta.url))});
  try {
    const url=new URL(server.launchUrl); url.searchParams.set("source",sourceId); url.searchParams.set("dataset",datasetId); url.searchParams.set("area","Context Process");url.searchParams.set("run",runId);
    await page.goto(url.toString());
    await expect(page.locator(".process-fact-button").first()).toBeVisible();
    await page.screenshot({path:info.outputPath("actual-decisions.png"),fullPage:true});
    for(const view of ["Information Flow","Methods / Cooperation","Adoption / Recovery"]) {
      await page.getByRole("tab",{name:view,exact:true}).click();
      await expect(page.getByRole("tab",{name:view,exact:true})).toHaveAttribute("aria-selected","true");
      await expect(page.locator(".process-fact-button").first()).toBeVisible();
      if(view==="Methods / Cooperation")await expect(page.getByRole("button",{name:/^Execution path:/}).first()).toBeVisible();
      await page.screenshot({path:info.outputPath(`actual-${view.replaceAll(/[^a-z]/gi,"-")}.png`),fullPage:true,animations:"disabled"});
    }
    const requests=(await queries.query({...snapshot,kind:"list_records",runId,recordKind:"request",limit:50})).records;
    expect(requests.length).toBeGreaterThan(0);
    const request=requests[0]!;
    const relations=(await queries.query({kind:"get_actual_input",manifest,subject:request.subject,section:"relationships",limit:100})).process!.relationships;
    const inputLink=relations.find(r=>r.link.kind==="materializes"&&r.link.to.id===request.subject.id);
    expect(inputLink).toBeDefined();
    const focused=new URL(page.url());focused.searchParams.set("cpFocus",JSON.stringify(request.subject));focused.searchParams.set("cpView","Decisions / Inputs");focused.searchParams.set("cpTab","relations");
    await page.goto(focused.toString());
    const detail=page.getByRole("dialog",{name:"Process evidence",exact:true});
    await detail.getByRole("button",{name:`contribution: ${inputLink!.link.from.id} / ${inputLink!.link.from.revision ?? "unknown revision"}`,exact:true}).first().click();
    await detail.getByRole("button",{name:"Prepared encoded input (not proof of sending)",exact:true}).first().click();
    await expect(page.getByRole("dialog",{name:"Prepared encoded input (not proof of sending)",exact:true})).toBeVisible();
    await page.getByRole("dialog",{name:"Prepared encoded input (not proof of sending)",exact:true}).getByRole("button",{name:"Close",exact:true}).click();
    await detail.getByRole("button",{name:"Close",exact:true}).click();
    await page.getByRole("tab",{name:"Time / Cost",exact:true}).click();
    await page.getByRole("button",{name:"Calculate fixed scope",exact:true}).click();
    for(let i=0;i<8;i++) {
      await expect(page.locator(".process-metrics")).toHaveAttribute("data-busy","false");
      if(await page.locator(".process-metrics").getAttribute("data-status")==="complete")break;
      await page.getByRole("button",{name:"Continue bounded calculation",exact:true}).click();
    }
    await expect(page.locator(".process-metrics")).toHaveAttribute("data-status","complete");
    await expect(page.locator(".process-metric-table .ant-table-row").first()).toBeVisible();
    await page.locator(".process-metric-table .ant-table-row").first().getByRole("button").click();
    await page.locator(".process-metric-evidence button").first().click();
    await page.locator(".process-metric-evidence button").first().click();
    await expect(page.getByRole("dialog",{name:"Process evidence",exact:true})).toBeVisible();
    await page.getByRole("dialog",{name:"Process evidence",exact:true}).getByRole("button",{name:"Close",exact:true}).click();
    await page.getByRole("combobox",{name:"Metric view",exact:true}).click(); await page.getByText("Recorded intervals",{exact:true}).click();
    await expect(page.locator(".process-metrics")).toHaveAttribute("data-busy","false");
    // Different original recordings may contain timing callbacks; compare this exact page, not a fixture-age assumption.
    const scopeParams=new URL(page.url()).searchParams;
    const intervalRead=(await queries.query({kind:"read_process_metrics",manifest:JSON.parse(scopeParams.get("cpManifest")!),runIds:JSON.parse(scopeParams.get("cpRuns")??JSON.stringify([runId])),cursor:scopeParams.get("cpMetric")!,section:"intervals",limit:30})).measurement!;
    if(!intervalRead.intervals.length)await expect(page.getByText("No recorded closed intervals on this page",{exact:true})).toBeVisible();
    else await expect(page.locator(".process-timeline .vis-range")).toHaveCount(intervalRead.intervals.filter(i=>i.clock===intervalRead.intervals[0]!.clock).length);
    await page.screenshot({path:info.outputPath("actual-time-desktop.png"),fullPage:true});
    await page.setViewportSize({width:600,height:900});
    await page.screenshot({path:info.outputPath("actual-time-narrow.png"),fullPage:true});
    expect(await page.locator(".context-process-workspace").evaluate(e=>e.scrollWidth<=e.clientWidth+1)).toBe(true);
    await page.getByRole("button",{name:"Release calculation",exact:true}).click();
    expect((await queries.query({kind:"get_snapshot",sourceId,datasetId})).selection?.watermark).toBe(snapshot.watermark);
  } finally {await server.close();await queries.close();}
});

test("recorded clock intervals render without joining independent clocks", async ({page},info) => {
  const recording=await createTestRecording(),r=recording.recorder;
  for(const [id,start,end,clock,category] of [["prepare",100,400,"clock-a","work"],["wait",200,500,"clock-a","dependency_wait"],["other",900,1200,"clock-b","work"]] as const) {
    for(const boundary of ["started","finished"] as const)expect(r.offer({subject:r.ref("timing","event",id,"root-run"),occurredAt:null,payload:{kind:"work_timing",version:"1",intervalId:id,owner:"work",runId:"root-run",pathId:"path",stageId:id,attemptId:null,workId:null,purposeDigest:"task",phase:id,boundary,clock:{domain:clock,monotonicMs:boundary==="started"?start:end},durationMs:boundary==="started"?null:end-start,outcome:boundary==="started"?null:"returned",category}})).toBe(true);
  }
  await r.flush(); const server=await startInspectorServer({root:recording.root,assets:fileURLToPath(new URL("../dist/renderer",import.meta.url))});
  try {
    const url=new URL(server.launchUrl);url.searchParams.set("source",recording.sourceId);url.searchParams.set("dataset",recording.datasetId);url.searchParams.set("run","root-run");url.searchParams.set("area","Context Process");url.searchParams.set("cpView","Time / Cost");
    await page.goto(url.toString()); await page.getByRole("button",{name:"Calculate fixed scope",exact:true}).click();
    await expect(page.locator(".process-metrics")).toHaveAttribute("data-status","complete");
    await page.getByRole("combobox",{name:"Metric view",exact:true}).click();await page.getByText("Recorded intervals",{exact:true}).click();
    await page.getByRole("combobox",{name:"Process interval clock",exact:true}).click();await page.locator(".ant-select-item-option-content").filter({hasText:/^clock-a$/}).click();
    await expect(page.locator(".process-timeline .vis-range")).toHaveCount(2);
    await expect(page.locator(".process-timeline")).toContainText("dependency_wait");
    await expect(page.locator(".process-timeline")).not.toContainText("other / 300");
    await expect(page.locator(".ant-select-dropdown:visible")).toHaveCount(0);
    await page.screenshot({path:info.outputPath("intervals-desktop.png"),fullPage:true,animations:"disabled"});
    await page.setViewportSize({width:600,height:900});await page.screenshot({path:info.outputPath("intervals-narrow.png"),fullPage:true,animations:"disabled"});
    expect(await page.locator("body").evaluate(e=>e.scrollWidth<=600)).toBe(true);
    await page.getByRole("combobox",{name:"Process interval clock",exact:true}).click();await page.locator(".ant-select-item-option-content").filter({hasText:/^clock-b$/}).click();
    await expect(page.locator(".process-timeline .vis-range")).toHaveCount(1);
    await expect(page.locator(".process-timeline")).toContainText("other / 300");
    await page.getByRole("button",{name:"Release calculation",exact:true}).click();
  } finally {await server.close();await recording.close();}
});

test("recovery recordings are explicitly included and content access is rechecked", async ({page}) => {
  const original=await createTestRecording();
  const protectedSubject=fact(original.recorder,"protected-original","decision"); await original.recorder.flush();
  const recovered=await InspectionRecorder.create({root:original.root,application:"inspector-ui-test",name:"Recovery UI",policy:{revision:"all",enabled:true,definition:true,agent:true,provider:true,execution:true}});
  recovered.offer({id:"explicit-recovery",subject:recovered.ref("host","event","explicit-recovery","root-run"),occurredAt:null,payload:{kind:"recording_link",stage:"recovery_prepared",target:{sourceId:original.sourceId,datasetId:original.datasetId,runId:"root-run"},limitation:null}});
  const server=await startInspectorServer({root:original.root,assets:fileURLToPath(new URL("../dist/renderer",import.meta.url))});
  await recovered.flush();
  try {
    const url=new URL(server.launchUrl);url.searchParams.set("source",recovered.source.sourceId);url.searchParams.set("dataset",recovered.manifest.datasetId);url.searchParams.set("area","Context Process");url.searchParams.set("run","root-run");url.searchParams.set("cpView","Adoption / Recovery");
    await page.goto(url.toString());
    await page.locator(".process-fact-button").first().click();
    await page.getByRole("button",{name:"Include linked recording",exact:true}).click();
    await expect.poll(()=>JSON.parse(new URL(page.url()).searchParams.get("cpManifest")??"{}").recordings?.length).toBe(2);
    await page.getByRole("dialog",{name:"Process evidence",exact:true}).getByRole("button",{name:"Close",exact:true}).click();
    await page.getByRole("tab",{name:"Decisions / Inputs",exact:true}).click();
    await focus(page,"protected-original");
    await page.getByRole("button",{name:"Original protected-original",exact:true}).click();
    await expect(page.getByRole("dialog",{name:"Original protected-original",exact:true})).toBeVisible();
    await page.getByRole("dialog",{name:"Original protected-original",exact:true}).getByRole("button",{name:"Close",exact:true}).click();
    original.recorder.setPolicy({revision:"revoked",enabled:true,definition:true,agent:false,provider:true,execution:true});await original.recorder.flush();
    await page.getByRole("button",{name:"Original protected-original",exact:true}).click();
    await expect(page.getByText("content_access_denied",{exact:true})).toBeVisible();
    expect(protectedSubject.datasetId).toBe(original.datasetId);
  } finally {await server.close();await recovered.flush(true);await original.close();}
});
