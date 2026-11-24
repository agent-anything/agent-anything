import {describe,it,expect} from "vitest";
import {createNativeModelCallRef,type ModelToolResult} from "@agent-anything/model-interaction";
import {OPENAI_RESPONSES,type ModelPurposeEvidence,type NativeModelSourceRef} from "@agent-anything/model-interaction/protocol";
import {projectNativeTaskHistory,requireTurnTaskInput} from "./NativeTaskHistory.js";
import {createNativeTaskModelItems} from "./TaskDecisionModelItems.js";
import {createNativeTaskHistorySeed,snapshotTaskInteractionSeed} from "./TaskInteractionSeed.js";
import {retainInputPresentation} from "./DecisionInputDelivery.js";
import {snapshotTaskModelExchange,validateTaskDecisionProposal} from "./TaskDecisionValidation.js";
import type {TaskDecisionInputSources,TaskDecisionModelItem} from "./TaskDecisionActivity.js";
import type {RunItem} from "../run/RunItem.js";
const ref=(id:string)=>({id,revision:"1"});
function purpose(id="one",runId="root"){
  const source:NativeModelSourceRef={scope:{runId,activityId:id,recipientId:"agent",purpose:ref("task"),compositionDigest:`sha256:${"a".repeat(64)}`},
    protocol:OPENAI_RESPONSES,interpretation:ref("responses-reader"),operationId:`${id}:create`,record:ref(`${id}:observation`),
    position:{format:"json-pointer",value:"/output/0"},nativeIdentity:{kind:"function_call",id:`${id}:item`}};
  const evidence:ModelPurposeEvidence={scope:source.scope,interpreter:ref("task-reader"),acceptance:ref(`${id}:accepted`),sources:[source]};
  const call={modelCallRef:createNativeModelCallRef({providerRequestId:`${id}:request`,controllerRequestId:`${id}:decision`,branchId:runId,
    contentBlockOrdinal:0,nativeSource:source,purposeAcceptance:evidence.acceptance}),providerCallRef:{providerId:OPENAI_RESPONSES.id,id:`${id}:call`},name:"Work",ordinal:0,input:{path:"x"}};
  return {evidence,call,items:createNativeTaskModelItems(evidence,[call])};
}
function item(payload:unknown,sequence:number):RunItem{return {ref:{id:`item:${sequence}`,sequence},committedInRevision:sequence,payload} as RunItem;}
function turn(items:readonly TaskDecisionModelItem[],sequence:number){return item({kind:"controller_turn",turn:{id:`turn:${sequence}`},modelItems:items},sequence);}
function settlement(p=purpose(),sequence=2){const {input:_,ordinal:__,...call}=p.call;
  const result:ModelToolResult={...call,settlement:"succeeded",content:{effect:"written"},presentation:{presenter:ref("result"),disposition:"complete",failureCode:null},
    sourceRefs:[{owner:"executor",kind:"result",id:`result:${sequence}`,revision:"1"}]};
  return item({kind:"model_call_settlement",result},sequence);}
const project=(items:readonly RunItem[])=>projectNativeTaskHistory({runId:"root",runRevision:items.length,items});
const input=()=>({runId:"root",agent:{id:"agent"},toolExposure:{controllerRequestId:"one:decision"},interaction:project([])}) as TaskDecisionInputSources;

describe("native task history",()=>{
  it("retains unobserved assignments and Host outcomes separately from native exchanges",()=>{
    const source={owner:"runtime",kind:"run_commit",id:"root:commit:1",revision:"1",runId:"root"};
    const presentation=(id:string,text:string)=>retainInputPresentation({id,source,kind:"conversation_opening",role:"user",necessity:"mandatory",content:{kind:"text",text},
      provenance:{purpose:"prior_task",recipientRunId:"root",author:"host",sources:[source],presenter:{owner:"host",kind:"presenter",...ref("handoff")},coverage:[source.id],limitations:[]},
      preservation:{obligations:[{id:"truth",requirement:"account",basis:"No accepted model response"}],relationships:[]}});
    const boundary={opening:[presentation("assignment","Prior assignment")],closing:[presentation("outcome","Cancelled before response")]};
    const seed=createNativeTaskHistorySeed("root",project([]),boundary);
    expect(snapshotTaskInteractionSeed(seed)).toEqual(seed);
    expect(seed.segments[0]!.entries).toEqual([]);
    expect(()=>createNativeTaskHistorySeed("root",project([]))).toThrow("native_import_history_not_closed");
    expect(()=>createNativeTaskHistorySeed("root",project([]),{...boundary,closing:boundary.opening})).toThrow("native_import_boundary_invalid");
    const p=purpose();
    expect(()=>createNativeTaskHistorySeed("root",project([turn(p.items,1),settlement(p)]),boundary)).toThrow("native_import_boundary_invalid");
  });
  it("retains purpose and local settlements without inventing messages or a Model Turn",()=>{
    const p=purpose(),history=project([turn(p.items,1),settlement(p)]);
    expect(history.entries.map(e=>e.kind)).toEqual(["purpose","settlement"]);expect(history.settledCallCount).toBe(1);
    expect(history.unsettledCalls).toEqual([]);expect(history).not.toHaveProperty("messages");
    expect(()=>requireTurnTaskInput({interaction:history})).toThrow("turn_task_input_participant_mismatch");
  });
  it("rejects missing, repeated and foreign settlements rather than rebuilding effects",()=>{
    const p=purpose(),other=purpose("two");
    expect(()=>project([turn(p.items,1),turn(other.items,2)])).toThrow("Native task history");
    expect(()=>project([turn(p.items,1),settlement(p),settlement(p,3)])).toThrow("Native task history");
    expect(()=>project([turn(p.items,1),settlement(other)])).toThrow("Native task history");
    expect(()=>project([turn(purpose("foreign","sibling").items,1)])).toThrow("Native task history");
  });
  it("requires one accepted task purpose and does not mix native and Turn conventions",()=>{
    const p=purpose(),second=purpose("two");
    expect(()=>snapshotTaskModelExchange({modelItems:[...p.items,second.items[0]!]},input())).toThrow();
    expect(()=>snapshotTaskModelExchange({modelItems:[...p.items,{id:"finish",kind:"model_turn_finish",turnId:"invented",finish:{kind:"completed"},metadata:{}} as TaskDecisionModelItem]},input())).toThrow();
  });
  it("allows rejected-call correlation without forged arguments, but never lets it execute",()=>{
    const p=purpose(),{input:_,...call}=p.call;
    const items:TaskDecisionModelItem[]=[p.items[0]!,{id:"rejected",kind:"native_rejected_call",call,metadata:{}}];
    const valid=validateTaskDecisionProposal({kind:"advance",modelItems:items,candidates:[{kind:"model_call_rejection",modelCallRef:call.modelCallRef,name:call.name,code:"invalid",message:"Fix the arguments"}]},input());
    expect(valid.modelItems[1]).not.toHaveProperty("call.input");
    expect(()=>validateTaskDecisionProposal({kind:"advance",modelItems:items,candidates:[{kind:"state_transition",transition:"plan_update",modelCallRef:call.modelCallRef,input:{}}]},input())).toThrow();
    expect(()=>validateTaskDecisionProposal({kind:"advance",modelItems:items,candidates:null} as never,input())).toThrow();
  });
  it("imports closed original occurrences without adding them to the successor's active Calls",()=>{
    const p=purpose(),seed=createNativeTaskHistorySeed("root",project([turn(p.items,1),settlement(p)]));
    expect(snapshotTaskInteractionSeed(seed)).toEqual(seed);
    const successor=projectNativeTaskHistory({runId:"successor",runRevision:0,items:[],seed});
    expect(successor.entries).toEqual([]);expect(successor.unsettledCalls).toEqual([]);
    expect(successor.seed?.segments[0]?.entries).toHaveLength(2);
    expect(()=>snapshotTaskInteractionSeed({...seed,sourceRunId:"sibling"})).toThrow("native_import_source_invalid");
    expect(()=>createNativeTaskHistorySeed("root",project([turn(p.items,1)]))).toThrow("native_import_history_not_closed");
  });
  it("correlates rejected Calls by identity values after storage reorders object members",()=>{
    const p=purpose(),{input:_,...call}=p.call;
    call.providerCallRef={id:call.providerCallRef.id,providerId:call.providerCallRef.providerId};
    const items:TaskDecisionModelItem[]=[p.items[0]!,{id:"rejected",kind:"native_rejected_call",call,metadata:{}}];
    const outcome=settlement(p);
    if(outcome.payload.kind!=="model_call_settlement")throw new Error("fixture");
    const invalid=item({...outcome.payload,result:{...outcome.payload.result,settlement:"invalid",content:{code:"arguments_too_large"}}},2);
    const history=project([turn(items,1),invalid]);
    expect(history.unsettledCalls).toEqual([]);
    expect(snapshotTaskInteractionSeed(createNativeTaskHistorySeed("root",history))).toMatchObject({kind:"native_evidence"});
    const wrong=item({...outcome.payload,result:{...outcome.payload.result,providerCallRef:{...call.providerCallRef,id:"another-call"}}},2);
    expect(()=>project([turn(items,1),wrong])).toThrow("Native task history");
  });
});
