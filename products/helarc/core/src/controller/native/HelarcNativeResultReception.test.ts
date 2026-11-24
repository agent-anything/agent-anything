import {describe,it,expect,vi} from "vitest";
import {createNativeModelCallRef} from "@agent-anything/model-interaction";
import {OPENAI_RESPONSES} from "@agent-anything/model-interaction/protocol";
import {modelInputValueDigest as digest} from "@agent-anything/model-interaction/input";
import {helarcResultTextDeclaration} from "../../prompt/HelarcResultTextDeclaration.js";
import {prepareHelarcNativeResultReception,type HelarcNativeResultReceptionInput,type HelarcNativeResultReceptionPorts} from "./HelarcNativeResultReception.js";
import {HelarcNativeWorkingInput} from "./HelarcNativeWorkingSources.js";
import {ActivityPurposeRegistry,type ActivityPurposeHandler} from "@agent-anything/agent-runtime/activity";
import {helarcNativeTaskResultSources} from "./HelarcNativeTaskResultDelivery.js";
import {helarcNativeInputRequirements} from "./HelarcNativeInputRequirements.js";
import {HelarcNativeResultReceptionWork} from "./HelarcNativeResultReceptionWork.js";
import {planHelarcNativeSourcePublications} from "./HelarcNativeSourcePublications.js";

const ref=(id:string)=>({id,revision:"1"});
function fixture(){
  const recipient={runId:"parent",recipient:"agent",purpose:"task"},scope={...recipient,id:"scope",target:"config:1",owner:"context-representation",authorityBasis:"original",continuity:"parent"};
  const nativeScope={runId:"parent",recipientId:"agent",activityId:"decision",purpose:ref("task"),compositionDigest:digest("composition")};
  const nativeSource={scope:nativeScope,protocol:OPENAI_RESPONSES,interpretation:ref("responses"),operationId:"create",record:ref("reply"),
    position:{format:"json-pointer" as const,value:"/output/0"},nativeIdentity:{kind:"function_call",id:"fc1"}};
  const result={modelCallRef:createNativeModelCallRef({providerRequestId:"request",controllerRequestId:"decision",branchId:"parent",contentBlockOrdinal:0,nativeSource,purposeAcceptance:ref("accepted")}),
    providerCallRef:{providerId:"openai",id:"call1"},name:"Agent_a1",settlement:"succeeded" as const,
    presentation:{presenter:ref("agent-runtime.observation"),disposition:"complete" as const,failureCode:null},sourceRefs:[{owner:"child",kind:"result",id:"report",revision:"1"}],
    content:{kind:"descendant_run",status:"succeeded",output:{summary:"Original report; unverified.",status:"completed",effect_status:"none",uncertainty:["unverified"]}}};
  const item={type:"function_call_output",call_id:"call1",output:JSON.stringify({settlement:result.settlement,result:result.content})};
  const items=[{type:"function_call",id:"fc1",call_id:"call1",name:"Agent_a1",arguments:"{}"},item];
  const body={model:"test",store:false,input:items};
  const working=new HelarcNativeWorkingInput();
  working.append(items,{id:"exchange",originRunId:"parent",sources:[{source:{owner:"model-access",kind:"protocol_observation",...ref("reply")},position:""}],
    duties:["continuity","evidence"],preservation:{obligations:[{id:"outcome",requirement:"account",basis:"Retain the Call and uncertainty"}],relationships:[]},
    exchangeId:"decision",protection:["active_exchange"],acceptedBy:null,representations:[]});
  const composition={digest:nativeScope.compositionDigest,composition:{protocol:OPENAI_RESPONSES,
    configuration:{configuration:ref("config"),connectionBinding:ref("account")}}};
  const texts:Record<string,string>={history:JSON.stringify(items),source:result.content.output.summary,candidate:"Report; unverified."};
  const range=(id:string)=>({materialId:id,version:"1",coordinate:"bytes" as const,start:0,end:Buffer.byteLength(texts[id]!)});
  const methodRecipient={...recipient,recipient:"context-representation",purpose:"method"};
  const hold=(id:string,consumer=methodRecipient)=>({id,instanceId:id,consumer,responsibility:"preparation",range:range(id),basis:"method",releaseCondition:"explicit release"});
  const record=(id:string)=>({ref:ref(id),runId:"parent",owner:"context-representation",purpose:"task",target:"config:1",form:"original",body:range(id),
    inputs:[{role:"source",material:range("source"),representation:null}],declaredCoverage:[range("source")],details:[range("source")],holds:[id],requirements:[],losses:[],restorations:[],method:null});
  const history=record("history"),candidate=record("candidate"),preserved={id:"preserved",owner:"context-representation",subjects:[candidate.ref],conclusion:"supported",limitations:["Model check is fallible"]};
  const progress={request:{nativeComposition:composition,recipient:methodRecipient,sourceBoundary:digest(result),requirements:helarcResultTextDeclaration(result,"original","1")!.requirements,
    sources:[{access:{range:range("source")}}]},resultIds:["candidate"],
    candidates:[{id:"candidate",representation:candidate.ref,access:{id:"candidate-access",holdId:"candidate",recipient:methodRecipient,range:range("candidate")}}],
    assessments:[{supported:true,candidateIds:["candidate"],scope:"both",judgmentIds:["preserved"]}]};
  const methods=vi.fn(async()=>({kind:"ready",progress})),reads=vi.fn(async(c:any)=>{
    if(c.kind==="describe")return {hold:hold(c.holdId)};
    if(c.kind!=="read")throw new Error("Unexpected write");
    const bytes=Buffer.from(texts[c.access.range.materialId]!);const end=Math.min(bytes.length,c.offset+c.length);
    return {start:c.offset,end,bytesBase64:bytes.subarray(c.offset,end).toString("base64")};
  });
  const catalog=vi.fn(async(c:any)=>c.kind==="read_judgment"?preserved:c.ref.id==="history"?history:candidate);
  const input={activity:{scope:nativeScope,composition},prepared:{binding:{scope:nativeScope},sourceDigest:"source-boundary",wire:{body:JSON.stringify(body),digest:digest(body)},workingSources:working.snapshot(),
    results:[{callId:result.modelCallRef.id,position:"/input/1",contentDigest:digest(item)}]},
    input:{runId:"parent",interaction:{kind:"native_evidence",entries:[{kind:"purpose"},{kind:"settlement",result}]}},scope,inputId:"input",selectionId:"selection",
    methodPathId:"method",callId:result.modelCallRef.id,candidateId:"candidate",history:{record:history,hold:hold("history",recipient)},sourceHold:hold("source"),
    maximumReadBytes:10000,continuity:{kind:"responses",policy:"native_replay",previous:null,conditions:{basis:"original",authorized:true,disclosureRevision:"original",remoteStorage:false,
      targetSupport:"established",predecessor:"unavailable",reestablish:false,policyChange:false}},
    capacity:{limits:[{id:"bytes",targetRevision:"config:1",dimension:"request_bytes",maximum:10000,source:"fixture"}],reservations:[],
      policy:{id:"policy",revision:"1",purpose:"task",basis:"explicit unknown policy",allowEstimatedFit:false,allowUnknown:true},maximumCombinations:1,maximumMeasurements:0}} as unknown as HelarcNativeResultReceptionInput;
  const ports={methods:{result:methods},materials:{command:reads},representations:{command:catalog}} as unknown as HelarcNativeResultReceptionPorts;
  return {input,ports,methods,reads,catalog,progress,preserved,texts};
}
const signal=()=>new AbortController().signal;
describe("native result reception",()=>{
  it("selects published groups and the substituted body without treating retained history as selected",async()=>{
    const f=fixture(),recipient={runId:f.input.scope.runId,recipient:f.input.scope.recipient,purpose:f.input.scope.purpose};
    const items=JSON.parse(f.input.prepared.wire.body).input;
    const plans=await planHelarcNativeSourcePublications({items,sources:f.input.prepared.workingSources!,recipient,target:f.input.scope.target,
      observedAt:"2026-11-18T00:00:00Z",maximumSourceBytes:10000,signal:signal(),
      activities:{command:async()=>({path:null,stages:[],inputNeeds:[]})} as never});
    const publications=plans.map(plan=>{
      const request=plan.request,range={...request.intent.version.ref,start:0,end:request.intent.version.bytes!,coordinate:"bytes" as const};
      const access={id:`${request.intent.id}:source-access`,holdId:`${request.intent.id}:consumer-hold`,recipient,range};
      const representation={ref:{id:`${request.intent.id}:original`,revision:range.version},runId:recipient.runId,owner:request.intent.owner,
        form:"original" as const,target:request.target,purpose:request.purpose,body:range,inputs:[{role:"source" as const,material:range,representation:null}],
        declaredCoverage:[range],holds:[],details:[],requirements:[],losses:[],restorations:[],method:null};
      return {...plan,state:"published" as const,published:{kind:"published_source_material" as const,version:request.intent.version,access,representation}};
    });
    const read=f.reads.getMockImplementation()!;
    f.reads.mockImplementation(async(c:any)=>{
      const publication=publications.find(p=>p.published.access.holdId===c.holdId);
      return c.kind==="describe"&&publication?{hold:{id:c.holdId,instanceId:publication.request.intent.instanceId,consumer:recipient,
        range:publication.published.access.range,responsibility:"preparation",basis:"source",releaseCondition:"explicit"}}:read(c);
    });
    const result=await prepareHelarcNativeResultReception({...f.input,publications},f.ports,signal());
    expect(result.kind).toBe("ready");if(result.kind!=="ready")return;
    const selected=(result.proposal.parts.find(p=>p.kind==="selection_input")!.proposal as any);
    expect(selected.selection.representations).toEqual([ref("candidate")]);
    expect(result.judgment.subjects).toEqual([ref("candidate")]);
    expect(selected.selection.holds.some((h:any)=>h.range.materialId==="history")).toBe(true);
    expect(result.judgment.inputs.some(r=>r.materialId==="history")).toBe(true);
    expect(result.selected.resultPresentations?.[0]?.representation).toEqual(ref("candidate"));
    expect(f.reads.mock.calls.some(([c])=>c.kind==="read"&&c.access.range.materialId==="history")).toBe(true);
  });
  it("returns a checked proposal without accepting, sending, or consuming the Child delivery",async()=>{
    const f=fixture(),r=await prepareHelarcNativeResultReception(f.input,f.ports,signal());
    expect(r.kind).toBe("ready");if(r.kind!=="ready")return;
    const output=JSON.parse(JSON.parse(r.selected.wire.body).input[1].output);
    expect(output.result.output.summary).toBe(f.texts.candidate);expect(output.result.output.uncertainty).toEqual(["unverified"]);
    expect(r.judgment.limitations).toEqual(["Model check is fallible"]);
    expect(r.selected.workingSources!.groups[0]).toMatchObject({sources:f.input.prepared.workingSources!.groups[0]!.sources,
      preservation:f.input.prepared.workingSources!.groups[0]!.preservation,representations:[ref("candidate")],protection:["active_exchange"]});
    expect(r.proposal.parts.some(p=>p.kind==="stage_submission")).toBe(false);
    expect(f.catalog.mock.calls.every(([c])=>c.kind==="read"||c.kind==="read_judgment")).toBe(true);
  });
  it.each(["pending","gap","cancelled"])("does not consume %s work",async kind=>{
    const f=fixture();f.methods.mockResolvedValueOnce({kind} as never);
    await expect(prepareHelarcNativeResultReception(f.input,f.ports,signal())).resolves.toEqual({kind:"unavailable",reason:`method_${kind}`});expect(f.reads).not.toHaveBeenCalled();
  });
  it("refuses unknown preservation even when the candidate is small",async()=>{
    const f=fixture();f.preserved.conclusion="unknown";
    await expect(prepareHelarcNativeResultReception(f.input,f.ports,signal())).rejects.toThrow("preservation_unconfirmed");expect(f.reads).not.toHaveBeenCalled();
  });
  it("checks the recipient purpose and complete encoded capacity independently of method capacity",async()=>{
    const f=fixture(),capacity={...f.input.capacity,limits:f.input.capacity.limits.map(l=>({...l,maximum:1}))};
    await expect(prepareHelarcNativeResultReception({...f.input,capacity},f.ports,signal())).resolves.toMatchObject({kind:"unavailable",reason:"recipient_input_capacity_unavailable"});
    await expect(prepareHelarcNativeResultReception({...f.input,capacity:{...capacity,policy:{...capacity.policy,purpose:"method"}}},f.ports,signal())).rejects.toThrow("policy_scope_invalid");
  });
  it("rejects altered source, recipient, history and exhausted read allowance",async()=>{
    const f=fixture();
    await expect(prepareHelarcNativeResultReception({...f.input,scope:{...f.input.scope,recipient:"sibling"}},f.ports,signal())).rejects.toThrow("scope_changed");
    await expect(prepareHelarcNativeResultReception({...f.input,maximumReadBytes:1},f.ports,signal())).rejects.toThrow("read_limit");
    f.texts.history="[]";
    await expect(prepareHelarcNativeResultReception(f.input,f.ports,signal())).rejects.toThrow();
    f.progress.request.sourceBoundary="different";
    await expect(prepareHelarcNativeResultReception(f.input,f.ports,signal())).rejects.toThrow("method_changed");
  });
  it("does not convert cancellation or revoked custody into a usable result",async()=>{
    const f=fixture(),control=new AbortController();control.abort(new Error("cancelled"));
    await expect(prepareHelarcNativeResultReception(f.input,f.ports,control.signal)).rejects.toThrow("cancelled");expect(f.methods).not.toHaveBeenCalled();
    f.reads.mockRejectedValueOnce(new Error("access_revoked"));await expect(prepareHelarcNativeResultReception(f.input,f.ports,signal())).rejects.toThrow("access_revoked");
  });
});

function workFixture(){
  const f=fixture(),sources=helarcNativeTaskResultSources(f.input.input as never),scope=f.input.scope;
  const inputNeed={kind:"native_input_need",revision:"1",needId:"demand:need",scope,consumer:{activityId:f.input.activity.scope.activityId,
    protocol:OPENAI_RESPONSES,compositionDigest:f.input.activity.composition.digest}};
  const source={request:{id:"demand:stage:1",pathId:"demand",stageKind:"source",input:{plan:{activity:f.input.activity,prepared:f.input.prepared,
    inputNeed,resultSources:sources}}},status:"accepted",receipt:{id:"source-receipt"}};
  const inputSupply={needId:inputNeed.needId,runId:scope.runId,owner:scope.owner,consumerPathId:"demand",source:{stageId:source.request.id,requestDigest:digest(source.request)},configuration:ref("config")};
  const plan={revision:"1",input:{...f.input,input:sources},inputNeed,inputSupply,binding:{revision:"1",pathId:"receiver",workId:"receiver-work",scope,
    boundary:f.input.prepared.sourceDigest,requirementsDigest:digest(helarcNativeInputRequirements(f.input.prepared.workingSources!.groups)),
    members:[{pathId:"method",workId:"method-work",requestDigest:digest(f.progress.request)}]}};
  const producer={intent:{id:"method",runId:scope.runId,permissionBasis:scope.authorityBasis,scheduledWorkId:"method-work"},cancelled:false};
  let path:any,stage:any;
  const activities=vi.fn(async(c:any)=>{
    if(c.kind==="read_snapshot")return structuredClone({path,stages:[stage],inputNeeds:[]});
    if(c.kind==="read_path")return c.pathId==="method"?producer:path;
    if(c.kind==="read_stage")return c.requestId===source.request.id?source:stage;
    if(c.kind==="pending")return [];
    if(c.kind==="read_schedule")return {intent:{workId:"receiver-work",runId:scope.runId,owner:scope.owner,allowedPathIds:["receiver"]},revision:1,closed:false,pathsSealed:false};
    throw new Error(`Unexpected ${c.kind}`);
  });
  const work=new HelarcNativeResultReceptionWork({...f.ports,activities:{command:activities},authorize:async()=>({kind:"allowed"}),now:()=>"2026-11-16T00:00:00Z"},
    new ActivityPurposeRegistry<ActivityPurposeHandler>());
  const parts=work.prepareSubmission({id:"receiver",runId:scope.runId,scheduledWorkId:"receiver-work",permissionBasis:scope.authorityBasis,
    resourceScope:"receiver",maximumStages:1,maximumAttempts:1,maximumConcurrent:1,deadlineAt:"2030-01-01T00:00:00Z"},plan as never);
  path={intent:parts[0]!.proposal,cancelled:false,controlRevision:0,progressRevision:0,progress:null};
  stage={request:parts[1]!.proposal,status:"submitted",attempt:{id:"receive-attempt"},result:null,receipt:null};
  async function accepted(){
    stage.result=await work.execute(path,stage,stage.attempt,signal());
    const result=await work.interpret(path,stage,signal());path.progress=result.progress;path.progressRevision=1;stage.status="accepted";
    stage.receipt={id:"receive-receipt",requestId:stage.request.id,resultId:stage.result.id,owner:scope.owner,expectedProgressRevision:0,progress:result.progress};
    return result;
  }
  return {...f,work,plan,path,stage,source,producer,activities,accepted};
}

describe("durable result reception",()=>{
  it("accepts a local check once and restores evidence without rereading bodies or calling methods",async()=>{
    const f=workFixture(),interpreted=await f.accepted();
    expect(interpreted.participants).toHaveLength(1);expect(interpreted.participants[0]).toMatchObject({owner:"representation",kind:"judge"});
    f.reads.mockClear();f.methods.mockClear();f.activities.mockClear();
    const result=await f.work.result("receiver");expect(result.kind).toBe("checked");
    expect(f.reads).not.toHaveBeenCalled();expect(f.methods).not.toHaveBeenCalled();
    expect(result.outcome?.result.kind).toBe("checked");
    expect(f.activities.mock.calls.map(([c])=>c.kind)).toEqual(["read_snapshot"]);
  });
  it("keeps a coherent observed result while cancellation advances afterward, and still rejects mismatched receipts",async()=>{
    const f=workFixture();await f.accepted();
    f.activities.mockImplementationOnce(async(c:any)=>{
      expect(c.kind).toBe("read_snapshot");const snapshot=structuredClone({path:f.path,stages:[f.stage],inputNeeds:[]});
      f.path.cancelled=true;f.path.controlRevision++;return snapshot;
    });
    expect((await f.work.result("receiver")).kind).toBe("checked");
    expect((await f.work.result("receiver")).kind).toBe("cancelled");
    f.stage.receipt.expectedProgressRevision++;
    await expect(f.work.result("receiver")).rejects.toThrow("input_reception_outcome_unconfirmed");
  });
  it.each(["demand","producer"])("rejects altered original %s before constructing an input",async part=>{
    const f=workFixture();if(part==="demand")f.source.request.input.plan.prepared={...f.input.prepared,sourceDigest:"changed"};
    else f.producer.intent.scheduledWorkId="another-work";
    await expect(f.work.execute(f.path,f.stage,f.stage.attempt,signal())).rejects.toThrow(`native_result_reception_${part}_changed`);
    expect(f.reads).not.toHaveBeenCalled();
  });
  it("does not report a capacity gap as a checked result",async()=>{
    const f=workFixture();f.plan.input.capacity={...f.plan.input.capacity,limits:f.plan.input.capacity.limits.map(l=>({...l,maximum:1}))};
    const parts=f.work.prepareSubmission(f.path.intent,f.plan as never);f.stage.request=parts[1]!.proposal;
    const interpreted=await f.accepted();expect(interpreted.participants).toEqual([]);
    expect((await f.work.result("receiver")).kind).toBe("gap");
  });
  it("closes only its receiving path and retains the independent producer and selected materials",async()=>{
    const f=workFixture();await f.accepted();f.path.cancelled=true;f.path.controlRevision=1;
    const value=await f.work.prepare({state:{subscription:{id:"receiver:reception",owner:f.input.scope.owner,runId:f.input.scope.runId,
      binding:{kind:"activity_path",id:"receiver"}}}} as never,signal());
    expect(value.close).toBe(true);expect(value.decision.kind).toBe("native_result_reception_closed");
    expect(value.participants.every(p=>p.owner==="activity")).toBe(true);
    expect(value.participants.some(p=>p.kind==="path_cancellation"||p.kind==="holds")).toBe(false);
    expect(f.producer.cancelled).toBe(false);
  });
});
