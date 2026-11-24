import {describe,expect,it} from "vitest";
import {modelInputValueDigest as digest} from "@agent-anything/model-interaction/input";
import type {ActivityPathState,ActivityStageState} from "@agent-anything/agent-runtime/activity";
import {createHelarcRunActivityScope} from "./HelarcRunActivityScope.js";
import {reportCaptureAuthorization} from "./HelarcReportMaterialHandoff.js";

async function scenario(mode:"continue"|"settle"="continue"){
  const parent={runId:"parent",recipient:"agent",purpose:"decision"},child={...parent,runId:"child"};
  const facts=new Map<string,unknown>(),controls=new Map([["child",true],["parent",false]]);
  const store={readProductRun:async()=>({contextBinding:{id:"context"}}),readRunCommit:async()=>({state:{run:{id:"child"}},
    admission:{lineage:{kind:"descendant",root:{id:"parent"},parent:{id:"parent"},relation:{id:"delegation"}}}}),
    readRunControl:async(runId:string)=>({terminal:controls.get(runId),cancelled:false,commitId:runId,revision:3}),
    activityHandoffs:{command:async(c:{kind:string;id:string})=>facts.get(c.id)??null}};
  const scope=createHelarcRunActivityScope({rootRunId:"parent",modelPoolId:"models",contextId:"context",store:store as never,
    host:{service:{assertAvailable(){},wake(){}},bindings:{bind(){}}} as never,
    composition:{id:"original",revision:"1",modelPoolCapacity:1,localPoolCapacity:1}});
  await scope.prepareActivation();scope.activate({} as never,mode);
  const path={intent:{id:"capture",runId:"child",permissionBasis:scope.permissionBasis}} as ActivityPathState;
  const transfer={parent,root:"parent",relation:{id:"delegation",revision:"1"},result:{id:"result",revision:"1"}};
  const version={materialId:"report",version:"original"};
  const request={input:{reportTransfer:transfer,intent:{version:{ref:version}},recipient:child}};
  const fact={id:"capture:capture-authority",sourceId:"capture:report-owner",
    handoff:{...transfer,child,version,pathId:"capture"},
    ref:{owner:"helarc.report-handoff",kind:"accepted_report_capture",id:"report:parent:"+digest(parent),revision:digest({intent:path.intent,request})}};
  facts.set(fact.id,fact);
  const authorize=reportCaptureAuthorization(store as never,scope);
  const check=(input:unknown=request.input,action:"admission"|"execution"|"reconciliation"|"interpretation"="admission")=>
    authorize(path,{request:{input}} as ActivityStageState,new AbortController().signal,action);
  return {scope,transfer,request,check,controls,facts};
}
describe("authority belongs to the accepted work, not to the source Run",()=>{
  it("permits the exact capture after Child termination and still denies ordinary progression",async()=>{
    const s=await scenario();expect(await s.check()).toEqual({kind:"allowed"});expect(await s.check({}, "execution")).toMatchObject({code:"helarc_run_progression_closed"});
    for(const change of [{parent:{...s.transfer.parent,runId:"sibling"}},{parent:{...s.transfer.parent,purpose:"different"}},{result:{id:"result",revision:"2"}}])
      expect(await s.check({...s.request.input,reportTransfer:{...s.transfer,...change}})).toMatchObject({code:"report_capture_basis_unconfirmed"});
    expect(await s.check({...s.request.input,intent:{version:{ref:{materialId:"report",version:"new"}}}})).toMatchObject({code:"report_capture_basis_unconfirmed"});
    s.controls.set("parent",true);expect(await s.check()).toMatchObject({code:"report_recipient_closed"});
    s.facts.set("capture:stop",{ref:{kind:"report_publication_cancelled"}});expect(await s.check()).toMatchObject({code:"report_publication_withdrawn"});
  });
  it("cancellation never authorizes new capture or resumed writes",async()=>{
    const s=await scenario();s.scope.activate({} as never,"cancel");
    expect(await s.check()).toMatchObject({code:"helarc_recovery_cancel_requested"});
    expect(await s.check(undefined,"reconciliation")).toMatchObject({code:"helarc_recovery_cancel_requested"});
    expect(()=>s.scope.assertNewDeliveryAllowed()).toThrow();
  });
  it("settlement-only activation cannot create grants while interpreting completed capture",async()=>{
    const s=await scenario("settle");
    expect(await s.check(undefined,"interpretation")).toMatchObject({kind:"temporary",code:"helarc_recovery_continue_required"});
    s.scope.activate({} as never,"continue");s.facts.clear();
    expect(await s.check()).toMatchObject({kind:"temporary",code:"report_capture_basis_unavailable"});
  });
});
