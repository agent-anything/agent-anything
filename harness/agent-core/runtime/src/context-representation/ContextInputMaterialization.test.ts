import {Buffer} from "node:buffer";
import {describe,expect,it,vi} from "vitest";
import type {MaterialAccess,MaterialCustodyPort,MaterialVersion} from "@agent-anything/context/custody";
import type {ActivityHandoffPort,ActivityPathState,ActivityStageState,ActivityStageRequest,ActivityAttempt} from "../activity/ActivityHandoff.js";
import {ActivityPurposeRegistry} from "../activity/ActivityPurpose.js";
import type {ActivityPurposeHandler} from "../activity/ActivityHandoffProcessor.js";
import {ContextInputMaterializationWork,type ContextInputMaterializationRequest} from "./ContextInputMaterialization.js";
import {createModelCallRef} from "@agent-anything/model-interaction";
import {declareModelResultTextSlot,type ModelToolMessage} from "@agent-anything/model-interaction/input";

function fixture(bytes=Buffer.from("a\u4e00b"),duplicate=false,resultText=false,multipleSlots=false) {
  const recipient={runId:"parent",recipient:"parent-agent",purpose:"task"};
  const access:MaterialAccess={id:"access",holdId:"hold",recipient,range:{materialId:"child-report",version:"1",start:0,end:bytes.length,coordinate:"bytes"}};
  const version:MaterialVersion={ref:{materialId:"child-report",version:"1"},origin:{runId:"child",owner:"child",recordId:"report",revision:"1",occurredAt:"2026-10-30T00:00:00Z"},label:"report",format:"utf8",mediaType:"text/plain",bytes:bytes.length,digest:"digest",capture:"complete",limitations:[]};
  const materials={command:vi.fn(async command=>{
    if(command.kind==="describe")return {hold:{id:"hold",range:access.range},version};
    if(command.kind!=="read")throw new Error(command.kind);
    const end=Math.min(bytes.length,command.offset+command.length);
    return {version,instanceId:"instance",start:command.offset,end,bytesBase64:bytes.subarray(command.offset,end).toString("base64"),text:null,next:end===bytes.length?null:end};
  })} as unknown as MaterialCustodyPort;
  const states=new Map<string,ActivityStageState>();let path:ActivityPathState;
  const port={command:vi.fn(async command=>command.kind==="read_stage"?states.get(command.requestId)??null:command.kind==="read_path"?path:null)} as unknown as ActivityHandoffPort;
  const preparation={prepareSubmission:vi.fn((_intent:unknown,_request:unknown)=>[] as unknown as readonly [never,never])},authorize=vi.fn<ActivityPurposeHandler["authorize"]>(async()=>({kind:"allowed"})),now=()=>"2026-10-30T00:00:00Z";
  const create=()=>new ContextInputMaterializationWork(port,new ActivityPurposeRegistry<ActivityPurposeHandler>(),{materials,preparation,authorize,now});
  let work=create();
  const intent={id:"materialize",runId:"parent",permissionBasis:"permission",resourceScope:"parent",maximumStages:30,maximumAttempts:30,maximumConcurrent:1,deadlineAt:"2030-01-01T00:00:00Z"};
  const section={id:"report",source:{owner:"context-representation",kind:"representation",id:"candidate",revision:"1"},kind:"evidence",role:"user" as const,necessity:"mandatory" as const,content:{kind:"retained_text" as const,access,prefix:"Report:\n",suffix:"\nEnd"}};
  const message:ModelToolMessage={role:"tool",content:["child-a","child-b"].map((id,index)=>({kind:"model_tool_result",result:{
    modelCallRef:createModelCallRef({providerRequestId:"original",controllerRequestId:"controller",turnId:"turn",contentBlockOrdinal:index,branchId:"parent"}),
    providerCallRef:{providerId:"provider",id},name:"Agent_exact",settlement:"failed",sourceRefs:[{owner:"runtime",kind:"result",id,revision:"1"}],
    presentation:{presenter:{id:"runtime",revision:"1"},disposition:"complete",failureCode:null},
    content:{output:{summary:"Original report",status:"failed",effect_status:"partial"},failure:{code:"build_failed"}},
  }}))};
  const slot=declareModelResultTextSlot(message,message.content[0]!.result.modelCallRef.id,["output","summary"]);
  const resultSection={...section,role:"tool" as const,content:{kind:"retained_result_text" as const,message,replacements:[{access,prefix:"Report:\n",suffix:"\nEnd",slot}]}};
  if(multipleSlots)resultSection.content.replacements.push({access,prefix:"Second:\n",suffix:"",slot:declareModelResultTextSlot(message,message.content[1]!.result.modelCallRef.id,["output","summary"])});
  const request={kind:"context_input_materialization",pageBytes:2,preparationIntent:{...intent,id:"prepare"},preparation:{kind:"context_input_preparation",template:{purpose:"task"},policy:{purpose:"task"},materialAccesses:[]},
    demand:{id:"demand",...recipient,targetRevision:"target",historyBoundary:"original",deliveryIds:["child-delivery"],dependencies:{candidate:"1"},maximumCombinations:2,maximumExternalMeasurements:0,maximumReadBytes:100,
      contributions:[{id:"report",owner:"context-representation",sourceRevision:"1",deliveryIds:["child-delivery"],currentOptionId:"candidate",localBudget:{dimension:"input_tokens",grant:null,ceiling:null},options:[{id:"candidate",revision:"1",sections:[{position:4,section:resultText?resultSection:section},...(duplicate?[{position:5,section:{...section,id:"report-again"}}]:[])],duties:["evidence","new_information"],findings:[],requirements:[],requires:[],excludes:[],preference:0,estimatedCost:null,omissionBasis:null}]}]}} as ContextInputMaterializationRequest;
  const parts=work.prepareSubmission(intent,request);
  path={intent:parts[0].proposal,controlRevision:0,progressRevision:0,progress:null,resourceUse:{admittedStages:0,dispatchedAttempts:0}} as ActivityPathState;
  let next=parts[1].proposal as ActivityStageRequest;
  const signal=new AbortController().signal;
  const step=async()=>{
    const stage={request:next,attempt:{id:`${next.id}:attempt`},status:"dispatched"} as ActivityStageState;
    await work.authorize(path,stage,signal,"execution");
    const raw=await work.execute(path,stage,stage.attempt as ActivityAttempt,signal);
    const result=await work.interpret(path,{...stage,result:raw},signal);
    states.set(stage.request.id,{...stage,status:"accepted",result:raw,receipt:{id:`${stage.request.id}:receipt`,resultId:raw.id,expectedProgressRevision:path.progressRevision,progress:result.progress}} as ActivityStageState);
    path={...path,progress:result.progress,progressRevision:path.progressRevision+1};
    if(result.next.length)next=result.next[0]!;
    return result;
  };
  return {request,intent,work,access,materials,preparation,authorize,port,states,step,signal,message,path:()=>path,next:()=>next,
    restart:()=>{work=create();},reads:()=>(materials.command as ReturnType<typeof vi.fn>).mock.calls.filter(([c])=>c.kind==="read"),
    finish:async()=>{for(let i=0;i<30;i++){const result=await step();if(!result.next.length)return result;}throw new Error("fixture did not finish");}};
}
describe("recipient input materialization",()=>{
  it("recovers multiple positions in one native message without rereading shared material",async()=>{
    const f=fixture(Buffer.from("a\u4e00b"),false,true,true);await f.step();f.restart();await f.finish();
    const request=f.preparation.prepareSubmission.mock.calls[0]![1] as {demand:ContextInputMaterializationRequest["demand"]};
    const expected=structuredClone(f.message);
    for(const [i,prefix,suffix] of [[0,"Report:\n","\nEnd"],[1,"Second:\n",""]] as const)
      ((expected.content[i]!.result.content as Record<string,unknown>).output as Record<string,unknown>).summary=prefix+"a\u4e00b"+suffix;
    expect(request.demand.contributions[0]!.options[0]!.sections[0]!.section.content).toEqual({kind:"model_message",message:expected});
    expect(f.reads().map(([c])=>c.offset)).toEqual([0,2,4]);expect(request.demand.deliveryIds).toEqual(["child-delivery"]);
  });
  it("rejects two replacements of the same position before reading",()=>{
    const f=fixture(Buffer.from("short"),false,true),changed=structuredClone(f.request);
    const content=changed.demand.contributions[0]!.options[0]!.sections[0]!.section.content;
    if(content.kind!=="retained_result_text")throw new Error("fixture");
    Object.assign(content,{replacements:[content.replacements[0],content.replacements[0]]});
    expect(()=>f.work.prepareSubmission(f.intent,changed)).toThrow("replacement_invalid");expect(f.reads()).toHaveLength(0);
  });
  it.each(["temporary","denied"] as const)("returns %s intact before accessing material",async kind=>{
    const f=fixture(),refusal=kind==="temporary"?{kind,code:"pending",message:"Await authority"}:
      {kind,code:"denied",message:"Authority revoked",decision:{owner:"host",id:"denial",revision:"1"}};
    f.authorize.mockResolvedValue(refusal);
    const stage={request:f.next()} as ActivityStageState;
    for(const action of ["admission","execution","interpretation","reconciliation","settlement"] as const)
      expect(await f.work.authorize(f.path(),stage,f.signal,action)).toBe(refusal);
    expect(f.materials.command).not.toHaveBeenCalled();expect(f.preparation.prepareSubmission).not.toHaveBeenCalled();
  });
  it("requires material access after explicit permission and preserves settlement's separate authority",async()=>{
    const f=fixture(),stage={request:f.next()} as ActivityStageState;
    expect(await f.work.authorize(f.path(),stage,f.signal,"execution")).toEqual({kind:"allowed"});
    expect(f.materials.command).toHaveBeenCalled();
    (f.materials.command as ReturnType<typeof vi.fn>).mockClear().mockResolvedValue(null);
    expect(await f.work.authorize(f.path(),stage,f.signal,"settlement")).toEqual({kind:"allowed"});
    expect(f.materials.command).not.toHaveBeenCalled();
    await expect(f.work.authorize(f.path(),stage,f.signal,"execution")).rejects.toThrow("access_unavailable");
  });
  it("restores a first result body inside its native group after recovery, with failures and sibling untouched",async()=>{
    const f=fixture(Buffer.from("a\u4e00b"),false,true);await f.step();f.restart();await f.finish();
    const request=f.preparation.prepareSubmission.mock.calls[0]![1] as unknown as {demand:ContextInputMaterializationRequest["demand"]};
    const content=request.demand.contributions[0]!.options[0]!.sections[0]!.section.content;
    const expected=structuredClone(f.message);
    ((expected.content[0]!.result.content as Record<string,unknown>).output as Record<string,unknown>).summary="Report:\na\u4e00b\nEnd";
    expect(content).toEqual({kind:"model_message",message:expected});expect(f.reads().map(([c])=>c.offset)).toEqual([0,2,4]);
    expect(f.message.content[1]).toEqual(expected.content[1]);expect(request.demand.deliveryIds).toEqual(["child-delivery"]);
  });
  it("rejects a changed original result binding before reading candidate material",()=>{
    const f=fixture(Buffer.from("short"),false,true),changed=structuredClone(f.request);
    const content=changed.demand.contributions[0]!.options[0]!.sections[0]!.section.content;
    if(content.kind!=="retained_result_text")throw new Error("fixture");
    (content.message.content[0]!.result.content as Record<string,unknown>).failure=null;
    expect(()=>f.work.prepareSubmission(f.intent,changed)).toThrow("source_changed");expect(f.reads()).toHaveLength(0);
  });
  it("resolves complete UTF-8 across byte boundaries and opens input preparation only after accepted pages",async()=>{
    const f=fixture();await f.finish();expect(f.reads()).toHaveLength(3);
    expect(f.preparation.prepareSubmission).toHaveBeenCalledTimes(1);
    const [,request]=f.preparation.prepareSubmission.mock.calls[0]! as unknown as [unknown,{demand:ContextInputMaterializationRequest["demand"];materialAccesses:MaterialAccess[]}];
    expect(request.demand.contributions[0]!.options[0]!.sections[0]).toMatchObject({position:4,section:{content:{kind:"text",text:"Report:\na\u4e00b\nEnd"}}});
    expect(request.materialAccesses).toEqual([f.access]);expect(request.demand.deliveryIds).toEqual(["child-delivery"]);
    expect(await f.work.result("materialize")).toEqual({kind:"organized",preparationPathId:"prepare"});
  });
  it("reuses accepted pages after owner reconstruction, without material rereads",async()=>{
    const f=fixture();await f.step();expect(f.reads()).toHaveLength(1);f.restart();await f.finish();
    expect(f.reads().map(([c])=>c.offset)).toEqual([0,2,4]);expect(f.preparation.prepareSubmission).toHaveBeenCalledTimes(1);
  });
  it("reads one declared access once even when the owner places its text in two positions",async()=>{
    const f=fixture(Buffer.from("a\u4e00b"),true);await f.finish();expect(f.reads()).toHaveLength(3);
    const request=f.preparation.prepareSubmission.mock.calls[0]![1] as {demand:ContextInputMaterializationRequest["demand"]};
    expect(request.demand.contributions[0]!.options[0]!.sections.map(s=>s.position)).toEqual([4,5]);
  });
  it("rejects a sibling recipient, changed permission basis, or insufficient reading budget before submission",()=>{
    const f=fixture();
    expect(()=>f.work.prepareSubmission({...f.intent,runId:"sibling"},f.request)).toThrow("scope_invalid");
    expect(()=>f.work.prepareSubmission({...f.intent,permissionBasis:"other"},f.request)).toThrow("scope_invalid");
    expect(()=>f.work.prepareSubmission(f.intent,{...f.request,demand:{...f.request.demand,recipient:"sibling"}})).toThrow("material_scope_invalid");
    expect(()=>f.work.prepareSubmission(f.intent,{...f.request,demand:{...f.request.demand,maximumReadBytes:2}})).toThrow("read_budget_exceeded");
    expect(()=>f.work.prepareSubmission({...f.intent,maximumStages:2},f.request)).toThrow("known_work_exceeds_delegation");
  });
  it("does not invent text when the retained bytes are not valid UTF-8",async()=>{
    const f=fixture(Buffer.from([0xc3,0x28]));const result=await f.finish();
    expect(result.progress).toMatchObject({state:"gap",reason:"input_materialization_encoding_invalid"});expect(f.preparation.prepareSubmission).not.toHaveBeenCalled();
  });
  it("rechecks current material access even when all pages are retained",async()=>{
    const f=fixture(Buffer.from("ab"));await f.step();
    (f.materials.command as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    await expect(f.step()).rejects.toThrow("access_unavailable");expect(f.preparation.prepareSubmission).not.toHaveBeenCalled();
  });
  it("rejects changed page evidence rather than constructing a new body on recovery",async()=>{
    const f=fixture(Buffer.from("ab"));await f.step();const original=f.states.values().next().value!;
    f.states.set(original.request.id,{...original,result:{...original.result!,id:"substituted-result"}});
    await expect(f.step()).rejects.toThrow("page_evidence_invalid");expect(f.preparation.prepareSubmission).not.toHaveBeenCalled();
  });
  it("does not turn cancellation settlement into a downstream submission",async()=>{
    const f=fixture();const stage={request:f.next(),result:{id:"retained-result"}} as ActivityStageState;
    expect(await f.work.settle(f.path(),stage,f.signal)).toMatchObject({disposition:{resultId:"retained-result",adopted:false}});
    expect(f.preparation.prepareSubmission).not.toHaveBeenCalled();expect(f.reads()).toHaveLength(0);
  });
  it("preserves a genuine empty material rather than interpreting missing content as empty",async()=>{
    const f=fixture(Buffer.alloc(0));await f.finish();expect(f.reads()).toHaveLength(0);
    const request=f.preparation.prepareSubmission.mock.calls[0]![1] as unknown as {demand:ContextInputMaterializationRequest["demand"]};
    expect(request.demand.contributions[0]!.options[0]!.sections[0]!.section.content).toEqual({kind:"text",text:"Report:\n\nEnd"});
  });
});
