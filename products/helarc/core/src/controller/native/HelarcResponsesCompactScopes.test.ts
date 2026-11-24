import {describe,it,expect,vi} from "vitest";
import {createHash} from "node:crypto";
import {modelInputValueDigest as digest} from "@agent-anything/model-interaction/input";
import {OPENAI_RESPONSES,bindModelAgentComposition} from "@agent-anything/model-interaction/protocol";
import {bindNativeInputManifest,nativeInputSettings,nativeInputGroupDigest,restoreResponsesCompactedWindow,RESPONSES_COMPACT_METHOD} from "@agent-anything/provider-integrations/native";
import {helarcNativePublishedInputGroups} from "./HelarcNativeInputGroups.js";
import {ActivityPurposeRegistry} from "@agent-anything/agent-runtime/activity";
import {HelarcNativeWorkingInput,type HelarcNativeWorkingGroupBasis} from "./HelarcNativeWorkingSources.js";
import type {HelarcRetainedNativeInput} from "./HelarcNativeInputAcceptance.js";
import {helarcResponsesCompactScopes as scopes,helarcResponsesCompactInventory as inventory,bindHelarcResponsesCompactPrefix as prefix} from "./HelarcResponsesCompactScopes.js";
import {helarcNativeSourceBytes,helarcNativeSourceMaterialRef,type HelarcNativeSourcePublication} from "./HelarcNativeSourcePublications.js";
import {helarcNativeWorkingGroupRevision} from "./HelarcNativeAccountScopes.js";
import {assessHelarcResponsesCompact} from "./HelarcResponsesCompaction.js";
import {realizeHelarcResponsesCompact as realize} from "./HelarcResponsesCompactRealization.js";
import {supplyHelarcResponsesCompactMethod,supplyHelarcResponsesCompactMethods} from "./HelarcResponsesCompactMethodSupply.js";
import {prepareHelarcResponsesCompactReception} from "./HelarcResponsesCompactReception.js";
import {HelarcResponsesCompactReceptionWork} from "./HelarcResponsesCompactReceptionWork.js";
import {helarcResponsesCompactPreparationSupply} from "./HelarcResponsesCompactPreparationSupply.js";
const ref=(id:string)=>({id,revision:"1"}),source=(id:string)=>({owner:"host",kind:"task",...ref(id)});
function publications(native:HelarcRetainedNativeInput):HelarcNativeSourcePublication[]{
  const items=native.manifest.groups.flatMap(g=>g.items),s=native.manifest.scope,recipient={runId:s.runId,recipient:s.recipientId,purpose:s.purpose.id};
  return native.workingSources!.groups.map(group=>{
    const bytes=helarcNativeSourceBytes(group,items),revision=helarcNativeWorkingGroupRevision(group),pathId=`capture:${group.id}:${revision}`,id=`${pathId}:custody`;
    const material=helarcNativeSourceMaterialRef(group,recipient,native.manifest.target.configuration);
    const range={...material,start:0,end:bytes.length,coordinate:"bytes" as const};
    const request={kind:"source_material_publication" as const,recipient,purpose:recipient.purpose,target:native.manifest.target.configuration,bytesBase64:bytes.toString("base64"),
      intent:{id,instanceId:id,activityId:pathId,owner:"material-source",maximumBytes:bytes.length,
        version:{ref:material,origin:{runId:s.runId,owner:"host",recordId:group.id,revision,occurredAt:"2026-11-16T00:00:00Z"},
          label:group.id,format:"json" as const,mediaType:"application/json",bytes:bytes.length,digest:`sha256:${createHash("sha256").update(bytes).digest("hex")}`,capture:"complete" as const,limitations:[]}}};
    return {group,pathId,request,state:"published",unavailable:null,published:{kind:"published_source_material",version:request.intent.version,
      access:{id,holdId:`${id}:consumer-hold`,recipient,range},representation:{ref:{id:`${id}:original`,revision},runId:s.runId,owner:"material-source",purpose:recipient.purpose,
        target:request.target,form:"original",body:range,inputs:[{role:"source",material:range,representation:null}],declaredCoverage:[range],details:[],holds:[],requirements:[],losses:[],restorations:[],method:null}}};
  });
}
const helarcResponsesCompactScopes=(n:HelarcRetainedNativeInput,p:ReturnType<typeof ref>,m:number)=>scopes(n,publications(n),p,m);
const helarcResponsesCompactInventory=(n:HelarcRetainedNativeInput)=>inventory(n,publications(n));
const bindHelarcResponsesCompactPrefix=(n:HelarcRetainedNativeInput,t:number,p:ReturnType<typeof ref>)=>prefix(n,publications(n),t,p);
const realizeHelarcResponsesCompact=(i:Omit<Parameters<typeof realize>[0],"publications">)=>realize({...i,publications:publications(i.original)});
function fixture(change?:(b:HelarcNativeWorkingGroupBasis,index:number)=>HelarcNativeWorkingGroupBasis):HelarcRetainedNativeInput {
  const w=new HelarcNativeWorkingInput();
  for(let index=0;index<5;index++){
    const id=`g${index}`,b:HelarcNativeWorkingGroupBasis={id,originRunId:"root",sources:[{source:source(id),position:""}],duties:["objective"],
      preservation:{obligations:[{id:"keep",requirement:"account",basis:`Keep fact ${index}`}],relationships:[]},exchangeId:null,
      protection:index===4?["first_delivery"]:[],acceptedBy:index===4?null:{runId:"root",activityId:"prior",acceptance:ref("accepted")},representations:[]};
    w.append([{role:"user",content:`Fact ${index}`}],change?change(b,index):b);
  }
  const body={model:"fixture",input:w.items,store:false},settings=nativeInputSettings(body);
  const manifest=bindNativeInputManifest({protocol:OPENAI_RESPONSES,
    scope:{id:"scope",runId:"root",recipientId:"task",purpose:ref("task"),compositionDigest:"composition"},
    target:{model:"fixture",configuration:"config:1",connection:"connection",disclosure:"authority"},
    selection:{id:"original",revision:"1",boundary:"boundary",judgments:["identity"]},
    groups:[{id:"history",representation:ref("history"),sources:["original"],holds:["history-hold"],deliveries:[],requires:[],items:w.items,replay:"local"}],
    settings,settingSources:Object.keys(settings).map(field=>({field,source:"original",digest:digest(settings[field])}))});
  return {kind:"helarc_native_input",manifest,wire:{body:JSON.stringify(body),digest:digest(body)},workingSources:w.snapshot(),
    prefixGroups:0,predecessor:null,continuity:{kind:"explicit"}};
}
function groupedFixture():HelarcRetainedNativeInput{
  const n=fixture(),s=n.manifest.scope;
  const grouped=helarcNativePublishedInputGroups({protocol:OPENAI_RESPONSES.id,items:n.manifest.groups.flatMap(g=>g.items),sources:n.workingSources!,
    publications:publications(n),recipient:{runId:s.runId,recipient:s.recipientId,purpose:s.purpose.id},target:n.manifest.target.configuration,
    inputId:"native-input",selectionId:n.manifest.selection.id});
  return {...n,manifest:bindNativeInputManifest({...n.manifest,groups:grouped.groups})};
}

describe("native compact lawful source scopes",()=>{
  it("uses stable published source groups without flattening native relationships",()=>{
    const n=groupedFixture(),groups=n.manifest.groups.map((g,i)=>i===2?{...g,requires:[{id:"g0",digest:nativeInputGroupDigest(n.manifest.groups[0]!)}]}:g);
    const original={...n,manifest:bindNativeInputManifest({...n.manifest,groups})};
    const found=helarcResponsesCompactScopes(original,ref("compact"),8);
    expect(found.inventory.units.map(u=>u.members.map(g=>g.id))).toEqual([["g0","g1","g2"],["g3"],["g4"]]);
    expect(found.scopes.map(s=>s.groups.length)).toEqual([4,3]);
    expect(found.inventory.manifest.groups.map(nativeInputGroupDigest)).toEqual(groups.map(nativeInputGroupDigest));
    expect(found.scopes[1]?.methodRequest.body.input).toEqual(groups.slice(0,3).flatMap(g=>g.items));
    expect(()=>bindHelarcResponsesCompactPrefix(original,1,ref("compact"))).toThrow("membership_invalid");
  });
  it("does not mistake a stored-response wire suffix for the complete retained source",()=>{
    const n=groupedFixture(),body={...JSON.parse(n.wire.body),previous_response_id:"retained-response",input:n.manifest.groups.slice(3).flatMap(g=>g.items)};
    const input={...n,prefixGroups:3,predecessor:"retained-response",wire:{body:JSON.stringify(body),digest:digest(body)}};
    const found=helarcResponsesCompactScopes(input,ref("compact"),8);
    expect(found.scopes[0]?.methodRequest.body.input).toEqual(n.manifest.groups.slice(0,4).flatMap(g=>g.items));
    expect(found.inventory.manifest.groups.map(g=>g.id)).toEqual(["g0","g1","g2","g3","g4"]);
  });
  it.each(["remote-only","delivery"])("excludes %s native groups without rejecting unrelated lawful prefixes",kind=>{
    const n=groupedFixture(),groups=n.manifest.groups.map((g,i)=>i!==1?g:kind==="remote-only"?{...g,replay:"remote_only" as const}:{...g,deliveries:["pending-delivery"]});
    const found=helarcResponsesCompactScopes({...n,manifest:bindNativeInputManifest({...n.manifest,groups})},ref("compact"),8);
    expect(found.scopes.map(s=>s.groups.length)).toEqual([1]);
    expect(found.exclusions.find(e=>e.sourceGroups.includes("g1"))?.reasons).toContain(kind==="remote-only"?"native_source_not_locally_replayable":"pending_native_delivery");
  });
  it("supplies native methods and explicit source admissions without claiming known quality",()=>{
    const protocol=OPENAI_RESPONSES,participant={protocol,implementation:ref("native")};
    const composition=bindModelAgentComposition({agent:ref("agent"),protocol,
      configuration:{configuration:ref("config"),protocol,model:"fixture",connectionBinding:ref("connection")},adapter:participant,
      task:{purpose:ref("task"),input:participant,interpreter:participant},auxiliary:[{purpose:ref("compact"),input:participant,interpreter:participant}]});
    const f=fixture(),native={...f,manifest:bindNativeInputManifest({...f.manifest,scope:{...f.manifest.scope,compositionDigest:composition.digest}})};
    const basis={native,publications:publications(native),composition,purpose:ref("compact"),authorityBasis:"authority",probeRequired:true,
      bounds:{readBytes:100000,storedBytes:100000,modelCalls:2,repairs:0,levels:1,pageBytes:4096,ranges:16},
      limits:{maximumStages:5,maximumAttempts:5},addresses:["capacity-gap"]};
    const supply=supplyHelarcResponsesCompactMethods(basis,2),o=supply.offers[0]!;
    expect(supply.report.enumeration).toEqual({complete:false,eligible:4,returned:2});
    expect(o.request.method).toBe("protocol");expect(o.request.execution.owner).toBe("openai.responses.compact");
    expect(o.materialAdmissions).toHaveLength(4);expect(o.option.quotation!.minimum.modelCalls).toBe(2);
    expect(o.option.capability.every(c=>c.conclusion==="unknown")).toBe(true);
    expect(o.materialAdmissions.every(a=>a.source.recipient.recipient==="task"&&a.hold.consumer.purpose==="compact")).toBe(true);
    expect(o.source.methodRequest.body.input).toEqual(f.manifest.groups[0]!.items.slice(0,4));
    expect(supplyHelarcResponsesCompactMethod(basis,1).source.groups).toHaveLength(1);
    expect(()=>supplyHelarcResponsesCompactMethod({...basis,authorityBasis:"different"},1)).toThrow("composition_changed");
    expect(()=>supplyHelarcResponsesCompactMethod({...basis,purpose:ref("absent")},1)).toThrow("purpose_unavailable");
    expect(()=>supplyHelarcResponsesCompactMethod({...basis,publications:basis.publications.slice(1)},1)).toThrow("publication_membership_changed");
  });
  it("enumerates historical prefixes and carries source-authored duties, never first delivery",()=>{
    const f=fixture(),r=helarcResponsesCompactScopes(f,ref("compact"),2);
    expect(r.enumeration).toEqual({complete:false,eligible:4,returned:2});
    expect(r.scopes.map(s=>s.groups.length)).toEqual([4,3]);
    expect(r.scopes[0]!.methodRequest.body.input).toHaveLength(4);
    expect(r.scopes[0]!.dutyBasis?.map(b=>b.description)).toEqual(["Keep fact 0","Keep fact 1","Keep fact 2","Keep fact 3"]);
    expect(r.exclusions[0]!.sourceGroups).toEqual(["g4"]);
    expect(r.scopes[0]!.methodRequest.body).not.toHaveProperty("instructions");
  });
  it.each(["exact","active","receipt","recipient","missing-relation"])("does not skip a %s protected prefix",kind=>{
    const f=fixture((b,i)=>i!==0?b:kind==="exact"?{...b,preservation:{...b.preservation,obligations:[{id:"exact",requirement:"exact",basis:"Required bytes"}]}}:
      kind==="active"?{...b,exchangeId:"active",protection:["active_exchange"]}:kind==="receipt"?{...b,acceptedBy:null}:
      kind==="recipient"?{...b,acceptedBy:{...b.acceptedBy!,runId:"sibling"}}:
      {...b,preservation:{...b.preservation,relationships:[{kind:"requires",source:source("unknown")}]}});
    expect(helarcResponsesCompactScopes(f,ref("compact"),8).scopes).toEqual([]);
    expect(()=>bindHelarcResponsesCompactPrefix(f,1,ref("compact"))).toThrow("protected");
  });
  it("keeps nonadjacent exchange members and intermediate notifications in one interval",()=>{
    const f=fixture((b,i)=>i===0||i===2?{...b,exchangeId:"exchange"}:b),r=helarcResponsesCompactScopes(f,ref("compact"),8);
    expect(r.inventory.units.map(u=>u.members.map(g=>g.id))).toEqual([["g0","g1","g2"],["g3"],["g4"]]);
    expect(r.scopes.map(s=>s.groups.length)).toEqual([4,3]);
    expect(r.scopes[1]!.methodRequest.body.input).toHaveLength(3);
    expect(()=>bindHelarcResponsesCompactPrefix(f,1,ref("compact"))).toThrow("membership_invalid");
  });
  it("merges intersecting declared relationships and exchanges without inferring prose",()=>{
    const f=fixture((b,i)=>i===0||i===2?{...b,exchangeId:"exchange"}:i===1?
      {...b,preservation:{...b.preservation,relationships:[{kind:"requires",source:source("g3")}]}}:b);
    const r=helarcResponsesCompactScopes(f,ref("compact"),8);
    expect(r.enumeration.eligible).toBe(1);expect(r.inventory.units[0]!.members).toHaveLength(4);
    expect(r.scopes[0]!.duties).toHaveLength(5);
  });
  it("a relationship crossing first delivery excludes the whole indivisible interval",()=>{
    const f=fixture((b,i)=>i===0?{...b,preservation:{...b.preservation,relationships:[{kind:"requires",source:source("g4")}]}}:b);
    expect(helarcResponsesCompactScopes(f,ref("compact"),8).enumeration.eligible).toBe(0);
  });
  it("restores exact accepted prefixes independently of current enumeration bounds",()=>{
    const f=fixture(),r=helarcResponsesCompactScopes(f,ref("compact"),4);
    expect(bindHelarcResponsesCompactPrefix(f,1,ref("compact"))).toEqual(r.scopes[3]);
    expect(helarcResponsesCompactScopes(f,ref("compact"),1).scopes).not.toContainEqual(r.scopes[3]);
    const changed=fixture((b,i)=>i===0?{...b,preservation:{...b.preservation,obligations:[{id:"keep",requirement:"account",basis:"New condition"}]}}:b);
    expect(bindHelarcResponsesCompactPrefix(changed,1,ref("compact"))).not.toEqual(r.scopes[3]);
  });
  it("rejects changed input and unmapped original native relationships",()=>{
    const f=fixture();expect(()=>helarcResponsesCompactInventory({...f,wire:{...f.wire,digest:"changed"}})).toThrow("inventory_changed");
    const manifest=bindNativeInputManifest({...f.manifest,groups:f.manifest.groups.map(g=>({...g,deliveries:["unmapped"]}))});
    expect(()=>helarcResponsesCompactInventory({...f,manifest})).toThrow("relationship_unmapped");
  });
  it("preserves whole opaque output, finite suffix, duties and ancestry without adopting",()=>{
    const original=fixture(),s=bindHelarcResponsesCompactPrefix(original,3,ref("compact"));
    const candidate=restoreResponsesCompactedWindow({id:"cmp_resource",object:"response.compaction",output:[
      {type:"message",role:"user",content:"Retained native message"},{id:"opaque",type:"compaction",encrypted_content:"ciphertext"}]});
    const findings=s.duties.map(d=>({id:`finding:${d.id}`,dutyId:d.id,dutyRevision:d.revision,kind:"method_assurance" as const,
      conclusion:"supported" as const,subject:candidate.digest,dependencies:s.dependencies,evidence:["synthetic scoped assurance"],limitations:["not live semantic evidence"]}));
    const assessment=assessHelarcResponsesCompact({source:s,candidate,findings}),group={id:"converted",representation:ref("compact-representation"),holds:["compact-hold"],observation:"native-observation"};
    const r=realizeHelarcResponsesCompact({original,source:s,candidate,assessment,group});
    expect(r.items.slice(0,2)).toEqual(candidate.items);expect(r.items.slice(2)).toEqual(original.manifest.groups[0]!.items.slice(3));
    expect(r.workingSources.groups[0]!.derivedFrom?.map(g=>g.groupId)).toEqual(["g0","g1","g2"]);
    expect(r.workingSources.groups[0]!.acceptedBy).toBeNull();expect(r.workingSources.groups[0]!.preservation.obligations).toHaveLength(3);
    expect(r.workingSources.groups.at(-1)!.protection).toEqual(["first_delivery"]);
    const body=JSON.parse(original.wire.body),laterItems=[...body.input,{role:"user",content:"Later Child delivery"}];
    const w=new HelarcNativeWorkingInput();
    w.inherit(body.input,original.workingSources!,{scope:{runId:"root",activityId:"later"},acceptance:ref("later-accepted")} as any);
    w.append([laterItems.at(-1)!],{...original.workingSources!.groups.at(-1)!,id:"late-child",originRunId:"child",acceptedBy:null,protection:["first_delivery"]});
    const laterBody={...body,input:laterItems},later={...original,workingSources:w.snapshot(),wire:{body:JSON.stringify(laterBody),digest:digest(laterBody)},
      manifest:bindNativeInputManifest({...original.manifest,groups:[{...original.manifest.groups[0]!,representation:ref("different-history-capture"),items:laterItems}]})};
    const reused=realizeHelarcResponsesCompact({original:later,source:s,candidate,assessment,group});
    expect(reused.items.at(-1)).toEqual(laterItems.at(-1));expect(reused.groups[0]!.items).toEqual(candidate.items);
    expect(()=>realizeHelarcResponsesCompact({original,source:s,candidate,assessment:assessHelarcResponsesCompact({source:s,candidate,findings:[]}),group})).toThrow("not_applicable");
  });
});

function receptionFixture(){
  const f=fixture(),original={...f,continuity:{kind:"responses",policy:"native_replay",previous:null,
    conditions:{basis:"original",authorized:true,disclosureRevision:"authority",remoteStorage:false,targetSupport:"established",predecessor:"unavailable",reestablish:false,policyChange:false}}} as HelarcRetainedNativeInput;
  const ps=publications(original),source=prefix(original,ps,4,ref("compact"));
  const candidate=restoreResponsesCompactedWindow({id:"compact-resource",object:"response.compaction",output:[{id:"opaque",type:"compaction",encrypted_content:"controlled"}]});
  const assessment=assessHelarcResponsesCompact({source,candidate,findings:source.duties.map(d=>({id:`f:${d.id}`,dutyId:d.id,dutyRevision:d.revision,
    kind:"method_assurance",conclusion:"supported",subject:candidate.digest,dependencies:source.dependencies,evidence:["controlled"],limitations:["not live semantic evidence"]}))});
  const scope={id:"scope",runId:"root",recipient:"task",purpose:"task",target:"config:1",owner:"context-representation",authorityBasis:"authority",continuity:"task"};
  const bytes=Buffer.from(JSON.stringify(candidate.items)),range={materialId:"compact-material",version:"1",coordinate:"bytes",start:0,end:bytes.length};
  const reader={runId:"root",recipient:scope.owner,purpose:"task"};
  const hold={id:"output",instanceId:"output",consumer:reader,responsibility:"checkpoint",range,basis:"terminal",releaseCondition:"settled"};
  const sourceHolds=ps.map(p=>({id:p.published!.access.holdId,instanceId:p.request.intent.instanceId,consumer:p.published!.access.recipient,
    responsibility:"checkpoint",range:p.published!.access.range,basis:p.pathId,releaseCondition:"settled"}));
  const publisherHolds=sourceHolds.slice(0,4).map(h=>({...h,id:`publisher:${h.id}`,consumer:reader}));
  const record={ref:ref("published"),runId:"root",owner:scope.owner,purpose:"task",target:scope.target,form:"native",body:range,
    inputs:ps.slice(0,4).map(p=>({role:"source",material:p.published!.representation.body,representation:p.published!.representation.ref})),
    declaredCoverage:ps.slice(0,4).map(p=>p.published!.representation.body),details:ps.slice(0,4).map(p=>p.published!.representation.body),
    holds:[hold.id,...publisherHolds.map(h=>h.id)],requirements:[],losses:[],restorations:[],method:{...RESPONSES_COMPACT_METHOD,activityId:"native",rawResultId:"terminal",
      acceptanceId:"accepted",protocolConfirmation:{rawRevision:"1",acceptanceRevision:"1"}}};
  const preserved={id:assessment.id,owner:record.owner,runId:record.runId,purpose:record.purpose,target:record.target,kind:"policy",conclusion:"supported",
    methodRevision:assessment.dependencies.method,subjects:[record.ref],coverage:record.declaredCoverage,limitations:["opaque semantic uncertainty"],
    dependencies:{...assessment.dependencies,candidate:assessment.candidateDigest,findings:digest(assessment.findings)}};
  const evidence={scope:{runId:"root",activityId:"native"},acceptance:ref("accepted"),sources:[{scope:{activityId:"native"},record:ref("terminal")}]};
  const method={state:"ready",request:{recipient:{runId:"root"},execution:{request:source}},compact:{candidate,evidence},assessment,
    publication:{representation:record.ref,judgmentId:assessment.id}};
  const state={activity:{scope:{runId:"root"},composition:{digest:"composition"}},fence:{controlRevision:3},cancelled:false};
  const describe=vi.fn(async()=>({state:"ready"})),methodResult=vi.fn(async()=>method),material=vi.fn(async(c:any)=>{
    if(c.kind==="describe"){const h=[hold,...sourceHolds,...publisherHolds].find(h=>h.id===c.holdId);if(!h||digest(h.consumer)!==digest(c.recipient))throw new Error("access_denied");return {hold:h};}
    if(c.kind==="read")return {start:c.offset,end:Math.min(c.offset+c.length,bytes.length),bytesBase64:bytes.subarray(c.offset,c.offset+c.length).toString("base64")};
    throw new Error("Read-only preparation must not modify custody");
  });
  const catalog=vi.fn(async(c:any)=>c.kind==="read_judgment"?preserved:c.ref.id===record.ref.id?record:ps.find(p=>p.published!.representation.ref.id===c.ref.id)?.published!.representation??null);
  const journal=vi.fn(async(c:any)=>c.kind==="state"?state:c.kind==="acceptance"?{evidence}:c.kind==="record"?{ref:ref("terminal")}:null);
  const input={original,publications:ps,methodPathId:"producer",scope,activityId:"task-activity",inputId:"next-input",selectionId:"selection",maximumReadBytes:10000,
    capacity:{limits:[{id:"bytes",targetRevision:scope.target,dimension:"request_bytes",maximum:10000,source:"controlled"}],reservations:[],
      policy:{id:"p",revision:"1",purpose:"task",basis:"original",allowUnknown:false,allowEstimatedFit:false},maximumCombinations:1,maximumMeasurements:0}};
  const ports={methods:{describe,result:methodResult},materials:{command:material},representations:{command:catalog},journal:{command:journal}};
  const run=(signal=new AbortController().signal)=>prepareHelarcResponsesCompactReception(input as any,ports as any,signal);
  return {input,ports,run,method,state,record,preserved,material,catalog,journal,describe,methodResult,bytes};
}

describe("qualified compact whole-input reception",()=>{
  it("restores original production outside the new-offer enumeration limit",async()=>{
    const f=receptionFixture(),protocol=OPENAI_RESPONSES,participant={protocol,implementation:ref("native")};
    const composition=bindModelAgentComposition({agent:ref("agent"),protocol,
      configuration:{configuration:ref("config"),protocol,model:"fixture",connectionBinding:ref("connection")},adapter:participant,
      task:{purpose:ref("task"),input:participant,interpreter:participant},auxiliary:[{purpose:ref("compact"),input:participant,interpreter:participant}]});
    const native={...f.input.original,manifest:bindNativeInputManifest({...f.input.original.manifest,scope:{...f.input.original.manifest.scope,compositionDigest:composition.digest}})};
    const methods={native,publications:publications(native),composition,purpose:ref("compact"),authorityBasis:"authority",probeRequired:false,
      bounds:{readBytes:100000,storedBytes:100000,modelCalls:2,repairs:0,levels:1,pageBytes:4096,ranges:16},limits:{maximumStages:5,maximumAttempts:5}};
    const inputNeed={needId:"need",scope:f.input.scope},inputSupply={needId:"need"},result=vi.fn(async()=>({state:"working"}));
    const supplier=helarcResponsesCompactPreparationSupply({methods,origin:{activityDigest:"a",preparedDigest:"p",historyDigest:"h",
      inputNeedDigest:digest(inputNeed),inputSupplyDigest:digest(inputSupply)},reception:{input:{...f.input,original:native,publications:methods.publications},
        originalInputPathId:"original",inputNeed,inputSupply},rejectedInputs:[]} as any,
      {activities:{command:vi.fn()},methods:{result},receiver:{purpose:{digest:"compact-receiver"},readPlan:vi.fn()}} as any);
    const old=supplyHelarcResponsesCompactMethod({...methods,addresses:["original-gap"]},1);
    const producer={record:{investment:{pathId:old.pathId,workId:"original-work"},decision:{investment:{kind:"propose",optionId:old.option.id}},input:{options:[old.option]}}};
    const collected=await supplier.collect({addresses:["current-gap"],producers:[producer] as any,receivers:[],maximum:1},new AbortController().signal);
    expect(collected.offers).toHaveLength(1);expect(collected.offers[0]!.pathId).not.toBe(old.pathId);
    expect(collected.reuseOptions[0]!.option.request).toEqual(old.request);
    expect(collected.report.originalWork).toMatchObject([{pathId:old.pathId,available:true}]);
    expect(collected.receptions).toEqual([]);expect(result).toHaveBeenCalledWith(old.pathId);
    expect(supplier.owns(old.option)).toBe(true);
  });
  it("retains opaque output, untouched suffix and ancestry without accepting or dispatching",async()=>{
    const f=receptionFixture(),r=await f.run();expect(r.kind).toBe("ready");if(r.kind!=="ready")return;
    expect(r.selected.manifest.groups[0]!.items).toEqual(f.method.compact.candidate.items);
    expect(r.selected.manifest.groups[1]!.items).toEqual([{role:"user",content:"Fact 4"}]);
    expect(r.selected.workingSources!.groups[0]!.derivedFrom).toHaveLength(4);
    expect(r.selected.workingSources!.groups[1]!.protection).toEqual(["first_delivery"]);
    expect(r.readBytes).toBe(f.bytes.length);expect(r.readiness.allowed).toBe(true);
    expect(r.proposal.parts[0]).toMatchObject({owner:"protocol_execution",kind:"require_accepted_result",proposal:{activityId:"native",controlRevision:3,record:ref("terminal")}});
    const admissions=r.proposal.parts.filter(p=>p.kind==="admit_access");
    expect(admissions).toHaveLength(1);expect((admissions[0]!.proposal as any).hold.instanceId).toBe("output");
    expect(f.material.mock.calls.filter(([c])=>c.kind==="read")).toHaveLength(1);
  });
  it.each(["capacity","unknown"])("reports %s rather than accepting an unusable successor",async mode=>{
    const f=receptionFixture();if(mode==="capacity")f.input.capacity.limits[0]!.maximum=1;else f.input.capacity.limits=[];
    expect(await f.run()).toMatchObject({kind:"unavailable",reason:"recipient_input_capacity_unavailable"});
  });
  it.each(["purpose","candidate","coverage","revision"])("rejects changed %s provenance before reading content",async mode=>{
    const f=receptionFixture();if(mode==="purpose")f.preserved.purpose="other";
    if(mode==="candidate")f.preserved.dependencies.candidate="other";
    if(mode==="coverage")f.preserved.coverage=[];
    if(mode==="revision")f.record.method.protocolConfirmation.acceptanceRevision="other";
    await expect(f.run()).rejects.toThrow(/unconfirmed|changed/);expect(f.material).not.toHaveBeenCalled();
  });
  it("retains pending/cancelled production as unavailable without reading a body",async()=>{
    const f=receptionFixture();f.describe.mockResolvedValueOnce({state:"active"});
    expect(await f.run()).toMatchObject({kind:"unavailable",reason:"compact_method_active"});
    f.state.cancelled=true;expect(await f.run()).toMatchObject({kind:"unavailable",reason:"compact_native_operation_cancelled"});
    expect(f.material).not.toHaveBeenCalled();
  });
  it("checks read bound, bytes, source custody and cancellation",async()=>{
    const f=receptionFixture();f.input.maximumReadBytes=1;await expect(f.run()).rejects.toThrow("output_unavailable");
    f.input.maximumReadBytes=10000;f.material.mockRejectedValueOnce(new Error("access_revoked"));await expect(f.run()).rejects.toThrow("access_revoked");
    const c=new AbortController();c.abort(new Error("stopped"));await expect(f.run(c.signal)).rejects.toThrow("stopped");
    f.material.mockImplementation(async(cmd:any)=>cmd.kind==="read"?{start:0,end:0,bytesBase64:""}:{hold:{id:"output",range:f.record.body}});
    await expect(f.run()).rejects.toThrow("page_invalid");
  });
  it("does not admit unrelated extra publications",async()=>{
    const f=receptionFixture();f.input.publications.push({...f.input.publications[0]!,group:{...f.input.publications[0]!.group,id:"unrelated"}});
    await expect(f.run()).rejects.toThrow("publication_membership_changed");
  });
  it("checks the source demand, durable outcome, native cancellation guard and supplier return independently",async()=>{
    const f=receptionFixture(),registry=new ActivityPurposeRegistry(),paths=new Map<string,any>(),stages=new Map<string,any>(),signal=new AbortController().signal;
    const supply={needId:"demand:need",runId:"root",owner:f.input.scope.owner,consumerPathId:"demand",source:{stageId:"demand:stage:1",requestDigest:""},configuration:ref("config")};
    const need={kind:"native_input_need",revision:"1",needId:supply.needId,scope:f.input.scope,
      consumer:{activityId:f.input.activityId,protocol:OPENAI_RESPONSES,compositionDigest:"composition"}};
    const demand={status:"accepted",request:{id:supply.source.stageId,pathId:"demand",input:{plan:{inputNeed:need,capacity:f.input.capacity}}},receipt:{id:"source-accepted"}};
    supply.source.requestDigest=digest(demand.request);stages.set(supply.source.stageId,demand);
    const prepared={kind:"prepared",value:{selected:f.input.original},stage:{request:{input:{plan:{inputSupply:supply}}}}};
    const activities={command:vi.fn(async(c:any)=>c.kind==="read_snapshot"?structuredClone({path:paths.get(c.pathId)??null,
      stages:c.requestIds.map((id:string)=>stages.get(id)??null),inputNeeds:[]}):
      c.kind==="read_path"?paths.get(c.pathId)??null:c.kind==="read_stage"?stages.get(c.requestId)??null:null)};
    const work=new HelarcResponsesCompactReceptionWork({...f.ports,activities,original:{result:async()=>prepared},authorize:async()=>({kind:"allowed"}),now:()=>"2026-11-16T00:00:00Z"} as any,registry);
    const intent={id:"reception",runId:"root",permissionBasis:"authority",resourceScope:"reception",scheduledWorkId:"reception-work",
      maximumStages:1,maximumAttempts:1,maximumConcurrent:1,deadlineAt:"2030-01-01T00:00:00Z"};
    const plan={revision:"1",binding:{revision:"1",pathId:intent.id,workId:intent.scheduledWorkId,scope:f.input.scope,boundary:"boundary",
      requirementsDigest:digest(f.input.original.workingSources!.groups.flatMap(()=>[])),members:[{pathId:"producer",workId:"producer-work",requestDigest:digest(f.method.request)}]},
      input:f.input,originalInputPathId:"original",inputNeed:need,inputSupply:supply};
    const {helarcNativeInputRequirements}=await import("./HelarcNativeInputRequirements.js");
    plan.binding.requirementsDigest=digest(helarcNativeInputRequirements(f.input.original.workingSources!.groups));
    const parts=work.prepareSubmission(intent,plan as any),path={intent:parts[0]!.proposal,cancelled:false,controlRevision:0,progressRevision:0},
      stage={request:parts[1]!.proposal,status:"dispatched",attempt:{id:"attempt"}} as any;
    paths.set(intent.id,path);stages.set(stage.request.id,stage);
    paths.set("producer",{intent:{runId:"root",scheduledWorkId:"producer-work",permissionBasis:"authority"},cancelled:false});
    stage.result=await work.execute(path as any,stage,stage.attempt,signal);
    const interpreted=await work.interpret(path as any,stage,signal);stage.status="accepted";
    stage.receipt={id:"reception-accepted",owner:f.input.scope.owner,requestId:stage.request.id,resultId:stage.result.id,expectedProgressRevision:0,progress:interpreted.progress,next:[]};
    Object.assign(path,{progress:interpreted.progress,progressRevision:1});
    const reads=f.material.mock.calls.length;activities.command.mockClear();
    expect((await work.result(intent.id)).kind).toBe("checked");expect(f.material.mock.calls).toHaveLength(reads);
    expect(activities.command.mock.calls.map(([c])=>c.kind)).toEqual(["read_snapshot"]);
    const acceptance=await work.prepareAdoption(intent.id,{id:"adopt",need:{id:supply.needId,supplier:supply.owner,origin:{requestId:supply.source.stageId,receiptId:demand.receipt.id},
      stage:{id:"demand:ready",pathId:"demand",stageKind:"ready",capabilities:[],dependencies:[]}} as any,expectedSelectionId:null,expectedControlRevision:0},signal);
    expect(acceptance.parts.some(p=>p.kind==="require_accepted_result")).toBe(true);
    expect(acceptance.parts.some(p=>p.owner==="context_input_supply"&&p.kind==="native_input_return")).toBe(true);
    demand.request.input.plan.capacity={...f.input.capacity,limits:[]};
    await expect(work.prepareAdoption(intent.id,{id:"another",need:{id:supply.needId,supplier:supply.owner,origin:{requestId:supply.source.stageId}} as any,
      expectedSelectionId:null,expectedControlRevision:0},signal)).rejects.toThrow("demand_changed");
    path.cancelled=true;expect((await work.reconcile(path as any,stage,signal)).value).toMatchObject({kind:"responses_compact_reception_cancelled"});
  });
});
