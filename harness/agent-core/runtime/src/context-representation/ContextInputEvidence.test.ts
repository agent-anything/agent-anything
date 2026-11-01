import {describe,expect,it} from "vitest";
import {ActivityPurposeRegistry,type ActivityHandoffPort,type ActivityPathState,type ActivityStageState} from "../activity/index.js";
import {CONTEXT_INPUT_PREPARATION_PURPOSE} from "./ContextInputPreparation.js";
import {readContextInputEvidence} from "./ContextInputEvidence.js";

function fixture() {
  const scope={runId:"child",recipient:"worker",purpose:"task",target:"target",owner:"context-representation"};
  const demand={id:"demand",runId:scope.runId,recipient:scope.recipient,purpose:scope.purpose,targetRevision:scope.target,historyBoundary:"H"};
  const progress={state:"gap",reason:"capacity",stageRequestId:"prepare:stage:2",rawResultId:"raw",
    gap:{reason:"capacity",demandId:demand.id,targetRevision:scope.target,information:[],capacity:[],untested:true,responsibility:"request_owner"}};
  const path={intent:{id:"prepare",runId:scope.runId,owner:scope.owner,purpose:new ActivityPurposeRegistry<null>().register(CONTEXT_INPUT_PREPARATION_PURPOSE,null)},
    controlRevision:0,progressRevision:2,cancelled:false,progress} as unknown as ActivityPathState;
  const first={request:{id:"prepare:stage:1",pathId:"prepare",input:{request:{kind:"context_input_preparation",demand}}}} as ActivityStageState;
  const stage={request:{id:progress.stageRequestId,pathId:"prepare"},status:"accepted",
    result:{id:"raw",completeness:"complete",outcome:"returned"},receipt:{id:"receipt",requestId:progress.stageRequestId,resultId:"raw",
      owner:scope.owner,expectedProgressRevision:1,progress}} as ActivityStageState;
  let reads=0,changeOnRead=false;
  const activities:ActivityHandoffPort={command:async command=>{
    if(command.kind==="read_path"){reads++;return changeOnRead&&reads>1?{...path,controlRevision:1,cancelled:true}:path;}
    if(command.kind==="read_stage")return command.requestId===first.request.id?first:command.requestId===stage.request.id?stage:null;
    throw new Error("Evidence reading must not mutate accepted work");
  }};
  const input={activities,pathId:"prepare",scope,demandId:demand.id,boundary:"H"};
  return {input,path,first,stage,progress,read:()=>readContextInputEvidence(input,new AbortController().signal),race:()=>{changeOnRead=true;}};
}
describe("accepted input preparation evidence",()=>{
  it("retains assessed gaps, uncertainty and original acceptance across serialization",async()=>{
    const f=fixture(),before=await f.read();
    expect(before).toMatchObject({kind:"available",current:{kind:"gap",gap:{untested:true},evidence:{owner:"activity",id:"prepare:stage:2",revision:"2"}},
      origin:{pathId:"prepare",stageId:"prepare:stage:2",rawResultId:"raw",receiptId:"receipt",progressRevision:2}});
    Object.assign(f.path,JSON.parse(JSON.stringify(f.path)));Object.assign(f.stage,JSON.parse(JSON.stringify(f.stage)));
    expect(await f.read()).toEqual(before);
  });
  it("does not invent a capacity gap from an unassessed technical failure",async()=>{
    const f=fixture();Object.assign(f.progress,{reason:"remote_measurement_dependency_unavailable"});Reflect.deleteProperty(f.progress,"gap");
    expect(await f.read()).toMatchObject({kind:"unassessed",reason:"remote_measurement_dependency_unavailable",origin:{rawResultId:"raw"}});
    expect(await f.read()).not.toHaveProperty("current");
  });
  it("does not promote a saved raw response before professional acceptance",async()=>{
    const f=fixture();Object.assign(f.path,{progress:null,progressRevision:0});Object.assign(f.stage,{status:"raw_result",receipt:null});
    expect(await f.read()).toEqual({kind:"pending"});
  });
  it("keeps cancellation and a racing control change out of usable evidence",async()=>{
    const f=fixture();Object.assign(f.path,{cancelled:true});expect(await f.read()).toEqual({kind:"cancelled"});
    const g=fixture();g.race();expect(await g.read()).toEqual({kind:"changed"});
  });
  it("can inspect the original accepted outcome after closure without making it usable",async()=>{
    const f=fixture(),original=await f.read();Object.assign(f.path,{cancelled:true});
    expect(await readContextInputEvidence({...f.input,includeCancelledOutcome:true},new AbortController().signal))
      .toEqual({kind:"cancelled",acceptedOutcome:original});
    Object.assign(f.stage.receipt!,{progress:{...f.progress,reason:"altered"}});
    await expect(readContextInputEvidence({...f.input,includeCancelledOutcome:true},new AbortController().signal)).rejects.toThrow("acceptance_mismatch");
  });
  it("does not infer a historical outcome when closure preceded professional acceptance",async()=>{
    const f=fixture();Object.assign(f.path,{cancelled:true,progress:null,progressRevision:0});
    expect(await readContextInputEvidence({...f.input,includeCancelledOutcome:true},new AbortController().signal)).toEqual({kind:"cancelled"});
  });
  it.each(["runId","recipient","purpose","target","owner"] as const)("rejects another %s rather than treating it as empty history",async field=>{
    const f=fixture();Object.assign(f.input.scope,{[field]:"another"});await expect(f.read()).rejects.toThrow(/context_input_evidence_(path|scope)_mismatch/);
  });
  it.each(["demandId","boundary"] as const)("rejects changed original %s",async field=>{
    const f=fixture();Object.assign(f.input,{[field]:"another"});await expect(f.read()).rejects.toThrow("context_input_evidence_scope_mismatch");
  });
  it.each(["status","result","revision","receipt","origin"])("rejects a missing or inconsistent accepted %s",async field=>{
    const f=fixture();
    if(field==="status")Object.assign(f.stage,{status:"raw_result"});
    if(field==="result")Object.assign(f.stage.result!,{outcome:"unknown"});
    if(field==="revision")Object.assign(f.stage.receipt!,{expectedProgressRevision:0});
    if(field==="receipt")Object.assign(f.stage.receipt!,{progress:{...f.progress,reason:"altered"}});
    if(field==="origin")Object.assign(f.progress,{stageRequestId:"not-recorded"});
    await expect(f.read()).rejects.toThrow("context_input_evidence_acceptance_mismatch");
  });
  it("checks cancellation without issuing new work",async()=>{
    const controller=new AbortController();controller.abort();await expect(readContextInputEvidence(fixture().input,controller.signal)).rejects.toThrow();
  });
});
