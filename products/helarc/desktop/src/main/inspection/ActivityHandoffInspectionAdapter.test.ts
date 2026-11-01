import {mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {expect, it} from "vitest";
import type {ActivityStageState} from "@agent-anything/agent-runtime/activity";
import {InspectionQueryService} from "@agent-anything/inspection/query";
import {HelarcInspection} from "./HelarcInspection.js";
import {ActivityHandoffInspectionAdapter} from "./ActivityHandoffInspectionAdapter.js";

it("links a retained Product source to its shared stage without inventing a sent request",async()=>{
  const directory=await mkdtemp(join(tmpdir(),"helarc-task-source-inspection-")),root=join(directory,"inspection");
  const inspection=await HelarcInspection.create(join(directory,"settings.json"),root),queries=new InspectionQueryService(root);
  try {
    const r=inspection.recorder!,observer=new ActivityHandoffInspectionAdapter(r);
    observer.observeStage("run",{request:{id:"task:source",pathId:"task",stageKind:"source",input:{kind:"task_model_source",
      request:{requestId:"original-source",messages:[]}}},status:"submitted",attempt:null,result:null,receipt:null} as unknown as ActivityStageState);
    await r.flush();
    const scope=(await queries.query({kind:"get_snapshot",sourceId:r.source.sourceId,datasetId:r.manifest.datasetId})).selection!;
    const source=r.ref("model-input","contribution","original-source","run");
    const detail=await queries.query({kind:"get_subject",...scope,subject:source});
    expect(detail.records[0]?.payload).toMatchObject({executionKind:"task_input_source",status:"retained"});
    const stage=await queries.query({kind:"get_execution",...scope,subject:r.ref("activity","contribution","task:source","run")});
    expect(stage.graph?.links.some(link=>link.kind==="binding"&&link.from.id===source.id)).toBe(true);
    const phantom=await queries.query({kind:"get_subject",...scope,subject:r.ref("model-interaction","request","original-source","run")});
    expect(phantom.records).toHaveLength(0);
    expect(r.health()).toMatchObject({dropped:0,rejected:0});
  } finally {await inspection.close();await queries.close();await rm(directory,{recursive:true,force:true});}
},30000);

it.each([{kind:"scheduling_paths_sealed",checked:false},{kind:"scheduling_closed",checked:false},{kind:"scheduling_closed",checked:true}] as const)("distinguishes scheduling state from settlement (%j)",async ({kind,checked})=>{
  const directory=await mkdtemp(join(tmpdir(),"helarc-schedule-closure-inspection-")),root=join(directory,"inspection");
  const inspection=await HelarcInspection.create(join(directory,"settings.json"),root),queries=new InspectionQueryService(root);
  try {
    const r=inspection.recorder!,observer=new ActivityHandoffInspectionAdapter(r);
    observer.observe({sequence:1,runId:"child",pathId:"work",requestId:null,kind,occurredAt:"2026-10-31T00:00:00.000Z",
      details:{basis:"original-exit",revision:3,pathsSealed:true,...(kind==="scheduling_closed"?{settlementChecked:checked}:{})}});
    await r.flush();expect(r.health().rejected).toBe(0);expect(r.health().dropped).toBe(0);
    const selection=(await queries.query({kind:"get_snapshot",sourceId:r.source.sourceId,datasetId:r.manifest.datasetId})).selection!;
    const detail=await queries.query({kind:"get_subject",...selection,subject:r.ref("activity-scheduling","contribution","work","child")});
    expect(detail.records[0]?.payload).toMatchObject({executionKind:"scheduled_work",status:kind==="scheduling_closed"?(checked?"closed":"service_closed"):"paths_sealed",phase:checked?"settled":"pending"});
    expect(detail.records[0]?.contents).toHaveLength(1);
    expect(detail.records.flatMap(record=>record.links).some(link=>link.kind==="delivers")).toBe(false);
  } finally {await inspection.close();await queries.close();await rm(directory,{recursive:true,force:true});}
},30000);

it("records a bounded scheduling delegation without inventing created paths or execution",async()=>{
  const directory=await mkdtemp(join(tmpdir(),"helarc-scheduling-scope-inspection-")),root=join(directory,"inspection");
  const inspection=await HelarcInspection.create(join(directory,"settings.json"),root),queries=new InspectionQueryService(root);
  try {
    const r=inspection.recorder!,observer=new ActivityHandoffInspectionAdapter(r),pathIds=Array.from({length:256},(_,i)=>`allowed-${i}`);
    observer.observe({sequence:1,runId:"child",pathId:"work",requestId:null,kind:"scheduling_accepted",occurredAt:"2026-10-31T00:00:00.000Z",
      details:{acceptance:{intent:{id:"original-schedule",workId:"work",owner:"context-representation",decisionId:"decision",resources:[],allowedPathIds:pathIds},service:"guaranteed"}}});
    await r.flush();expect(r.health().rejected).toBe(0);expect(r.health().dropped).toBe(0);
    const selection=(await queries.query({kind:"get_snapshot",sourceId:r.source.sourceId,datasetId:r.manifest.datasetId})).selection!;
    const detail=await queries.query({kind:"list_records",...selection,runId:"child",limit:500});
    const delegated=detail.records.filter(record=>record.payload.kind==="execution"&&record.payload.executionKind==="scheduling_path_delegation");
    expect(delegated).toHaveLength(256);
    expect(delegated.flatMap(record=>record.links).filter(link=>link.to.owner==="activity").map(link=>link.to.id).sort()).toEqual(pathIds.sort());
    expect(delegated.every(record=>record.links.every(link=>link.kind==="binding"))).toBe(true);
    const original=await queries.query({kind:"get_subject",...selection,subject:r.ref("activity-scheduling","contribution","original-schedule","child")});
    expect(original.records[0]?.contents).toHaveLength(1);
  } finally {await inspection.close();await queries.close();await rm(directory,{recursive:true,force:true});}
},30000);

it("links independent source closure without claiming material release or Parent delivery",async()=>{
  const directory=await mkdtemp(join(tmpdir(),"helarc-source-lifecycle-inspection-")),root=join(directory,"inspection");
  const inspection=await HelarcInspection.create(join(directory,"settings.json"),root),queries=new InspectionQueryService(root);
  try {
    const r=inspection.recorder!,observer=new ActivityHandoffInspectionAdapter(r);
    observer.observeStage("child",{request:{id:"publication:capture",pathId:"publication",input:{kind:"source_material_publication",
      lifecycle:{revision:"1",scheduling:{workId:"source-work"}}}},status:"accepted",result:null,receipt:null} as unknown as ActivityStageState);
    observer.observe({sequence:1,runId:"child",pathId:"publication:source-lifecycle",requestId:null,kind:"reconsideration_accepted",
      occurredAt:"2026-10-31T00:00:00.000Z",details:{receipt:{id:"source-close",subscriptionId:"publication:source-lifecycle",factIds:[],
        decision:{owner:"material-source",kind:"source_publication_closed",id:"publication",revision:"1"},close:true}}});
    await r.flush();expect(r.health().rejected).toBe(0);
    const selection=(await queries.query({kind:"get_snapshot",sourceId:r.source.sourceId,datasetId:r.manifest.datasetId})).selection!;
    const subject=r.ref("material-source","contribution","publication","child","1");
    const detail=await queries.query({kind:"get_subject",...selection,subject});
    expect(detail.records.map(record=>record.payload)).toContainEqual(expect.objectContaining({executionKind:"source_publication_lifecycle",status:"closed",phase:"settled"}));
    const flow=await queries.query({kind:"get_data_flow",...selection,subject});
    const execution=await queries.query({kind:"get_execution",...selection,subject});
    expect(execution.graph?.links).toContainEqual(expect.objectContaining({kind:"settles",from:expect.objectContaining({owner:"shared_acceptance",id:"source-close"})}));
    expect(flow.graph?.links.some(link=>link.kind==="delivers")).toBe(false);
    const capture=await queries.query({kind:"get_execution",...selection,subject:r.ref("activity","contribution","publication:capture","child")});
    expect(capture.graph?.links).toContainEqual(expect.objectContaining({kind:"binding",to:expect.objectContaining({owner:"activity-scheduling",id:"source-work"})}));
  }finally{await inspection.close();await queries.close();await rm(directory,{recursive:true,force:true});}
},30000);

it.each([false,true])("records input limitation submission and acceptance without inventing a model request (accepted=%s)",async accepted=>{
  const directory=await mkdtemp(join(tmpdir(),"helarc-input-limitation-inspection-")),root=join(directory,"inspection");
  const inspection=await HelarcInspection.create(join(directory,"settings.json"),root),queries=new InspectionQueryService(root);
  try {
    const r=inspection.recorder!,observer=new ActivityHandoffInspectionAdapter(r),occurredAt="2026-10-31T00:00:00.000Z";
    observer.observe({sequence:1,runId:"run",pathId:"task",requestId:"limitation",kind:"stage_submitted",occurredAt,details:{inputNeedId:"need",inputOutcome:"unavailable"}});
    observer.observeStage("run",{request:{id:"limitation",input:{kind:"context_input_unavailable",needId:"need",supplier:"context-representation",boundary:"B",reason:"original_reception_unsupported",
      evidence:[{owner:"context-representation",kind:"decision",id:"decision",revision:"4"}]}},status:accepted?"accepted":"submitted",
      result:accepted?{id:"raw",outcome:"returned",recordedAt:occurredAt}:null,
      receipt:accepted?{id:"accepted",owner:"task-decision",requestId:"limitation",resultId:"raw",progress:{kind:"task_input_unavailable"}}:null} as unknown as ActivityStageState);
    await r.flush();expect(r.health().rejected).toBe(0);
    const selection=(await queries.query({kind:"get_snapshot",sourceId:r.source.sourceId,datasetId:r.manifest.datasetId})).selection!;
    const need=await queries.query({kind:"get_subject",...selection,subject:r.ref("activity-input","contribution","need","run")});
    expect(need.records.map(record=>record.payload)).toContainEqual(expect.objectContaining({status:accepted?"unavailable_accepted":"unavailable_submitted",phase:accepted?"settled":"pending"}));
    const stage=await queries.query({kind:"get_subject",...selection,subject:r.ref("activity","contribution","limitation","run")});
    expect(stage.records.map(record=>record.payload)).toContainEqual(expect.objectContaining({executionKind:"purpose_bound_stage",status:accepted?"accepted":"submitted"}));
    const relationships=await queries.query({kind:"get_data_flow",...selection,subject:r.ref("activity","contribution","limitation","run")});
    expect(relationships.graph?.links).toContainEqual(expect.objectContaining({kind:"observes",to:expect.objectContaining({id:"decision"})}));
    expect(stage.records.flatMap(record=>record.links).some(link=>link.kind==="delivers"||link.to.kind==="request")).toBe(false);
  }finally{await inspection.close();await queries.close();await rm(directory,{recursive:true,force:true});}
},30000);

it("links actual native result presentation separately from its original execution settlement",async()=>{
  const directory=await mkdtemp(join(tmpdir(),"helarc-result-presentation-inspection-")),root=join(directory,"inspection");
  const inspection=await HelarcInspection.create(join(directory,"settings.json"),root),queries=new InspectionQueryService(root);
  try {
    const r=inspection.recorder!,observer=new ActivityHandoffInspectionAdapter(r),time="2026-10-31T00:00:00.000Z";
    const presentation={digest:"presentation",inputAcceptanceId:"input-accepted",responseAcceptanceId:"response-accepted",requestId:"request",
      rawResultId:"raw",inputId:"selected-input",presentations:[{sectionId:"native-result",bindings:[{slot:{callId:"original-call"},representation:{id:"short-report",revision:"1"}}]}]};
    observer.observeStage("parent",{request:{id:"response-stage",pathId:"task",stageKind:"model",input:{}},status:"accepted",
      result:{id:"raw",outcome:"returned",recordedAt:time},receipt:{id:"accepted",progress:{kind:"task_model_response",exchange:{resultPresentationReceipt:presentation}}}} as unknown as ActivityStageState);
    await r.flush();expect(r.health().rejected).toBe(0);
    const selection=(await queries.query({kind:"get_snapshot",sourceId:r.source.sourceId,datasetId:r.manifest.datasetId})).selection!;
    const subject=await queries.query({kind:"get_subject",...selection,subject:r.ref("task-result-presentation","contribution","presentation","parent")});
    expect(subject.records.map(record=>record.payload)).toContainEqual(expect.objectContaining({executionKind:"native_result_presentation",status:"response_accepted"}));
    const links=subject.records.flatMap(record=>record.links);
    for(const id of ["original-call","raw","selected-input","request"])expect(links).toContainEqual(expect.objectContaining({to:expect.objectContaining({id})}));
    expect(links.some(link=>link.to.id==='["short-report","1"]')).toBe(true);
    expect(links.filter(link=>link.kind==="settles")).toEqual([expect.objectContaining({from:expect.objectContaining({id:"response-accepted"})})]);
  }finally{await inspection.close();await queries.close();await rm(directory,{recursive:true,force:true});}
},30000);

it("links consumer closure and original settlement without claiming recipient delivery",async()=>{
  const directory=await mkdtemp(join(tmpdir(),"helarc-consumer-inspection-")),root=join(directory,"inspection");
  const inspection=await HelarcInspection.create(join(directory,"settings.json"),root),queries=new InspectionQueryService(root);
  try {
    const r=inspection.recorder!,observer=new ActivityHandoffInspectionAdapter(r);
    for(const [sequence,ref] of [
      [1,{owner:"context-representation",kind:"method_input_closed",id:"consumer-path",revision:"closed"}],
      [2,{owner:"context-representation",kind:"result_settled",id:"read-stage",revision:"settlement-acceptance"}],
    ] as const)observer.observe({sequence,runId:"child",pathId:"source",requestId:null,kind:"fact_published",occurredAt:"2026-10-31T00:00:00.000Z",
      details:{fact:{id:`publication-${sequence}`,sourceId:"source",ref}}});
    await r.flush();expect(r.health().rejected).toBe(0);
    const selection=(await queries.query({kind:"get_snapshot",sourceId:r.source.sourceId,datasetId:r.manifest.datasetId})).selection!;
    const flow=await queries.query({kind:"get_data_flow",...selection,subject:r.ref("activity-publication","contribution","publication-2","child")});
    expect(flow.graph?.links).toContainEqual(expect.objectContaining({kind:"observes",to:expect.objectContaining({id:"read-stage"})}));
    expect(flow.graph?.links).toContainEqual(expect.objectContaining({kind:"produces",from:expect.objectContaining({owner:"shared_acceptance",id:"settlement-acceptance"})}));
    expect(flow.graph?.links.some(link=>link.kind==="delivers")).toBe(false);
  } finally {await inspection.close();await queries.close();await rm(directory,{recursive:true,force:true});}
},30000);

it.each([{settled:false,usable:true},{settled:true,usable:true},{settled:false,usable:false},{settled:true,usable:false}])("links actual input delivery independently of task advancement (%j)", async ({settled,usable}) => {
  const directory = await mkdtemp(join(tmpdir(), "helarc-task-handoff-inspection-")), root = join(directory, "inspection");
  const inspection = await HelarcInspection.create(join(directory, "settings.json"), root), queries = new InspectionQueryService(root);
  try {
    const r = inspection.recorder!, observer = new ActivityHandoffInspectionAdapter(r);
    const delivery = {via: {kind: "provider", requestId: "request", selection: {digest: "delivery-receipt", inputAcceptanceId: "input-accepted",
      responseAcceptanceId: "response-accepted", rawResultId: "raw", mapping: [{deliveryId: "source-one"}, {deliveryId: "source-two"}]}}};
    const progress = {kind: "task_model_response", state: usable?"interpreted":"response_not_usable", proposal: usable?{inputDeliveryReceipt: delivery}:null,
      exchange: {inputDeliveryReceipt:delivery}};
    const receipt = {id: "response-accepted", requestId: "model-stage", resultId: "raw", owner: "task-decision", progress};
    const settlement = {id: "response-accepted", requestId: "model-stage", resultId: "raw", owner: "task-decision",
      disposition: {kind: "retained_task_result", resultId: "raw", decisionAccepted: false, response: progress}};
    observer.observeStage("run", {request: {id: "model-stage", input: {}}, status: settled ? "settled" : "accepted",
      result: {id: "raw", outcome: "returned", recordedAt: "2026-10-30T00:00:00.000Z"},
      receipt: settled ? null : receipt, settlement: settled ? settlement : null} as unknown as ActivityStageState);
    await r.flush();
    expect(r.health().rejected).toBe(0);
    const selected = (await queries.query({kind: "get_snapshot", sourceId: r.source.sourceId, datasetId: r.manifest.datasetId})).selection!;
    const flow = await queries.query({kind: "get_data_flow", ...selected, subject: r.ref("task-input-delivery", "contribution", "delivery-receipt", "run")});
    expect(flow.graph?.links).toContainEqual(expect.objectContaining({kind: "delivers", to: expect.objectContaining({id: "request", kind: "request"})}));
    const delivered = await queries.query({kind: "get_subject", ...selected, subject: r.ref("task-input-delivery", "contribution", "delivery-receipt", "run")});
    expect(delivered.records.flatMap(record => record.links)).toContainEqual(expect.objectContaining({kind: "settles", from: expect.objectContaining({id: "response-accepted"})}));
    for (const id of ["source-one", "source-two"]) expect(flow.graph?.links).toContainEqual(expect.objectContaining({kind: "includes", to: expect.objectContaining({id})}));
    const stage = await queries.query({kind: "get_subject", ...selected, subject: r.ref("activity", "contribution", "model-stage", "run")});
    expect(stage.records.map(record => record.payload)).toContainEqual(expect.objectContaining({executionKind: "purpose_bound_stage", status: settled ? "settled" : "accepted"}));
  } finally {await inspection.close(); await queries.close(); await rm(directory, {recursive: true, force: true});}
}, 30000);
