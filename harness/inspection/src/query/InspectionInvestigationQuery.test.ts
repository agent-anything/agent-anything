import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { InspectionRecorder } from "../../dist/recording/index.js";
import { InspectionQueryService } from "../../dist/query/index.js";
import { ExecutionFlowInspectionAdapter } from "../../dist/adapters/index.js";
import { inspectionLink } from "../../dist/adapters/ProviderInspectionAdapter.js";
import { createExecutionFlowDefinition, ExecutionFlowPath } from "@agent-anything/observability/execution-flow";

const cleanups: (()=>Promise<void>)[]=[];
afterEach(async()=>{for(const cleanup of cleanups.splice(0).reverse()) await cleanup();});
async function fixture() {
  const directory=mkdtempSync(join(tmpdir(),"inspection-investigation-"));
  cleanups.push(async()=>{if(!relative(tmpdir(),resolve(directory)).startsWith("inspection-investigation-"))throw new Error("Invalid cleanup target");rmSync(directory,{recursive:true,force:true});});
  const recorder=await InspectionRecorder.create({root:directory,application:"test",name:"Investigation",policy:{revision:"test",enabled:true,definition:true,agent:true,provider:true,execution:true}});
  const query=new InspectionQueryService(directory);cleanups.push(async()=>query.close());cleanups.push(async()=>recorder.flush(true));
  const snapshot=async()=>{await recorder.flush();return(await query.query({kind:"get_snapshot",sourceId:recorder.source.sourceId,datasetId:recorder.manifest.datasetId})).selection!;};
  return{recorder,query,snapshot};
}

describe("Investigation read projections",()=>{
  it("retains transport material after dense bindings and follows explicit Call execution relationships",async()=>{
    const {recorder:r,query,snapshot}=await fixture();
    const request=r.ref("model-interaction","request","request","root");
    r.offer({subject:request,occurredAt:null,payload:{kind:"request",purpose:"controller",providerId:"test",model:"model",compositionId:null,messageCount:1,toolCount:70}});
    for(let i=0;i<70;i++)r.offer({subject:r.ref("tools","definition",`tool-${i}`,null,"1"),occurredAt:null,payload:{kind:"event",name:"binding",sequence:null,code:null},links:[inspectionLink("binding",r.ref("tools","definition",`tool-${i}`,null,"1"),request)]});
    const attempt=r.ref("provider","provider-attempt","http","root");
    for(const phase of ["started","settled"] as const)r.offer({subject:attempt,occurredAt:null,payload:{kind:"transport",phase,requestId:"request",providerId:"test",method:"POST",endpoint:"https://provider.test/chat",httpStatus:phase==="settled"?200:null,status:phase==="settled"?"succeeded":"started",code:null,encodedBytes:2},links:[inspectionLink("contains",request,attempt)],contents:[{name:phase==="started"?"Encoded request body":"Decoded response",class:"provider",stage:phase,mediaType:"application/json",value:{}}]});
    const call=r.ref("runtime","call","call","root");
    const action=r.ref("runtime","action","run-action","root");
    const prepared=r.ref("action-execution","action","prepared","root");
    r.offer({subject:call,occurredAt:null,payload:{kind:"event",name:"model.call",sequence:null,code:null},links:[inspectionLink("materializes",call,action)]});
    r.offer({subject:prepared,occurredAt:null,payload:{kind:"execution",phase:"settled",executionKind:"action",status:"failed",code:"command_failed",effectCertainty:null},links:[inspectionLink("materializes",action,prepared)]});
    const scope=await snapshot();
    const requests=(await query.query({...scope,kind:"get_model_request",runId:"root"})).summaries!;
    expect(requests[0]!.relatedRecords.flatMap(record=>record.contents.map(content=>content.name))).toEqual(expect.arrayContaining(["Encoded request body","Decoded response"]));
    const calls=(await query.query({...scope,kind:"get_execution",runId:"root"})).summaries!;
    expect(calls[0]!.relatedRecords.some(record=>record.subject.id==="prepared" && record.payload.kind==="execution" && record.payload.status==="failed")).toBe(true);
    expect(calls[0]!.links.some(link=>link.from.id==="run-action" && link.to.id==="prepared")).toBe(true);
  });
  it("keeps initial and latest Run material without burying input bindings in intermediate snapshots",async()=>{
    const {recorder:r,query,snapshot}=await fixture();
    const run=r.ref("runtime","run","root","root");
    for(let revision=0;revision<70;revision++) {
      r.offer({subject:run,occurredAt:null,payload:{kind:"snapshot",status:revision===69?"completed":"running",revision,agentId:"agent",parentRunId:null,taskId:"task"},
        contents:[{name:"Run snapshot",class:"agent",stage:"committed",mediaType:"application/json",value:{revision}}],
        links:[inspectionLink("contains",run,r.ref("runtime","turn",`turn-${revision}`,"root"))],
      });
      if(revision===35) r.offer({subject:run,occurredAt:null,payload:{kind:"event",name:"middle",sequence:null,code:null}});
    }
    const input=r.ref("runtime","contribution","input","root","1");
    r.offer({subject:input,occurredAt:null,payload:{kind:"event",name:"Run input",sequence:null,code:null},
      links:[inspectionLink("binding",input,run)],contents:[{name:"Run input",class:"agent",stage:"bound",mediaType:"application/json",value:{task:"task"}}]});
    const scope=await snapshot();
    const summary=(await query.query({...scope,kind:"list_runs"})).summaries![0]!;
    expect(summary.facts.filter(r=>r.payload.kind==="snapshot").map(r=>r.payload.kind==="snapshot"?r.payload.revision:null)).toEqual([0,69]);
    expect(summary.facts.some(r=>r.payload.kind==="event" && r.payload.name==="middle")).toBe(true);
    expect(summary.relatedRecords.some(r=>r.subject.id==="input" && r.contents[0]?.name==="Run input")).toBe(true);
    expect(summary.limited).toBe(true);
  });
  it("scopes summaries by recorded descendants and rejects cross-scope cursors",async()=>{
    const {recorder:r,query,snapshot}=await fixture();
    for(const [id,parent] of [["root",null],["child","root"],["nested","child"],["other",null]] as const) {
      r.offer({subject:r.ref("runtime","run",id,id),occurredAt:null,payload:{kind:"snapshot",status:"running",revision:1,agentId:"agent",parentRunId:parent,taskId:id}});
      const request=r.ref("model-interaction","request","request-"+id,id);
      r.offer({subject:request,occurredAt:null,payload:{kind:"request",purpose:"controller",providerId:"test",model:"model",compositionId:null,messageCount:1,toolCount:0},links:[inspectionLink("produces",r.ref("runtime","run",id,id),request)]});
    }
    const scope=await snapshot();
    const root=await query.query({...scope,kind:"get_model_request",runId:"root"});
    expect(root.summaries?.map(s=>s.subject.runId)).toEqual(["root"]);
    const graph=await query.query({...scope,kind:"get_data_flow",runId:"root",includeDescendants:true});
    expect(new Set(graph.graph!.nodes.map(node=>node.subject.runId))).toEqual(new Set(["root","child","nested"]));
    expect((await query.query({...scope,kind:"list_runs",runId:"child",includeDescendants:true})).records.map(record=>record.subject.id)).toEqual(["child","nested"]);
    const page=await query.query({...scope,kind:"get_model_request",runId:"root",includeDescendants:true,limit:1});
    const second=await query.query({...scope,kind:"get_model_request",runId:"root",includeDescendants:true,after:String(page.next),limit:10});
    expect(second.summaries?.map(s=>s.subject.runId)).toEqual(["child","nested"]);
    await expect(query.query({...scope,kind:"get_model_request",runId:"child",includeDescendants:true,after:String(page.next)})).rejects.toThrow("inspection_cursor_invalid");
    await expect(query.query({...scope,kind:"get_model_request",runId:"root",after:String(page.next)})).rejects.toThrow("inspection_cursor_invalid");
  });
  it("pairs interval endpoints across pages without treating settlement as success",async()=>{
    const {recorder:r,query,snapshot}=await fixture();
    const first=r.ref("provider","provider-attempt","a","root");const second=r.ref("provider","provider-attempt","b","root");
    const offer=(id:string,subject:typeof first,phase:"started"|"settled",time:string,status:string|null)=>r.offer({id,subject,occurredAt:time,payload:{kind:"interval",activity:"provider",clock:"one",phase,status}});
    offer("a-start",first,"started","2026-09-14T00:00:00Z",null);
    offer("b-start",second,"started","2026-09-14T00:00:01Z",null);
    const open=await snapshot();
    offer("a-end",first,"settled","2026-09-14T00:00:03Z","failed");offer("b-end",second,"settled","2026-09-14T00:00:04Z","succeeded");
    const scope=await snapshot();
    const page=await query.query({...scope,kind:"get_timeline",runId:"root",limit:1});
    expect(page.intervals).toMatchObject([{startRecordId:"a-start",endRecordId:"a-end",status:"failed"}]);
    expect((await query.query({...open,kind:"get_timeline",runId:"root",limit:1})).intervals[0]?.endRecordId).toBeNull();
    const rest=await query.query({...scope,kind:"get_timeline",runId:"root",limit:1,after:String(page.next)});
    expect(rest.intervals[0]?.startRecordId).toBe("b-start");
    const range=await query.query({...scope,kind:"get_timeline",runId:"root",from:"2026-09-14T00:00:02Z",to:"2026-09-14T00:00:02Z"});
    expect(range.intervals).toHaveLength(2);
  });
  it("summarizes closed occurrences on a one-entry page and resolves actual caller ancestry",async()=>{
    const {recorder,query,snapshot}=await fixture();
    const definition=createExecutionFlowDefinition({owner:"test",id:"flow",revision:"1",label:"Flow",description:"Test",steps:[{id:"step",label:"Step",kind:"entry",checks:["check"]}],transitions:[{id:"again",from:"step",to:"step",label:"Repeat"}],entryStepIds:["step"],exitStepIds:["step"]});
    const observer=new ExecutionFlowInspectionAdapter(recorder);
    const root=new ExecutionFlowPath(definition,{observer},"root");const first=root.advance("step");first.check("check","not_satisfied");
    const child=new ExecutionFlowPath(definition,root.callContext,"child");child.advance("step");child.close("returned");root.advance("step");root.close("returned");
    const scope=await snapshot();
    const page=await query.query({...scope,kind:"list_flow_occurrences",runId:"root",invocationId:root.ref.invocationId,limit:1});
    expect(page.flow?.occurrences).toMatchObject([{disposition:"returned",checkCount:1,issueCount:1,branch:"step"}]);
    const read=await query.query({...scope,kind:"get_execution_flow",runId:"child",invocationId:child.ref.invocationId});
    expect(read.flow?.ancestry?.[0]?.subject.id).toBe(first.ref.stepExecutionId);
  });
  it("uses recorded call names only under current content-class authorization",async()=>{
    const {recorder:r,query,snapshot}=await fixture();
    const call=r.ref("runtime","call","call","root");
    r.offer({subject:call,occurredAt:null,payload:{kind:"event",name:"model.call",sequence:null,code:null},contents:[{name:"Model call",stage:"decoded",class:"provider",mediaType:"application/json",value:{name:"Read",modelCallRef:{id:"call"}}}]});
    const scope=await snapshot();
    expect((await query.query({...scope,kind:"get_execution",runId:"root"})).summaries?.[0]?.label).toBe("Read");
    r.setPolicy({revision:"off",enabled:true,definition:true,agent:true,provider:false,execution:true});await r.flush();
    expect((await query.query({...scope,kind:"get_execution",runId:"root"})).summaries?.[0]?.label).toBe("call");
  });
});
