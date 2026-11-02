import {afterEach,describe,expect,it} from "vitest";
import {mkdtempSync,rmSync} from "node:fs";
import {join,dirname,resolve,basename} from "node:path";
import {tmpdir} from "node:os";
import {createHash} from "node:crypto";
import {modelInputValueDigest} from "@agent-anything/model-interaction/input";
import {ActivityPurposeRegistry,type ActivityHandoffCommand,type SharedAcceptanceProposal} from "@agent-anything/agent-runtime/activity";
import {contextDeliveryFactSource} from "@agent-anything/agent-runtime/context-representation";
import type {MaterialCustodyCommand,MaterialCustodyIntent,MaterialHold,MaterialRange,MaterialSearchPage,MaterialReadPage,MaterialGrant} from "@agent-anything/context/custody";
import {CustodyMaterialAccess} from "@agent-anything/context/custody";
import type {RepresentationRecord,RepresentationJudgment} from "@agent-anything/context/representation";
import type {ContextAcceptancePart,ContextDeliveryPage,ContextSelectionProposal,ContextSelectionSnapshot,ContextUseScope} from "@agent-anything/context/selection";
import {ExecutionDatabase} from "./ExecutionDatabase.js";

const databases:ExecutionDatabase[]=[],directories:string[]=[];
afterEach(()=>{
  for(const db of databases.splice(0))db.close();
  for(const directory of directories.splice(0)) {
    if(dirname(resolve(directory))!==resolve(tmpdir()) || !basename(directory).startsWith("helarc-context-foundation-"))throw new Error("Unsafe cleanup");
    rmSync(directory,{recursive:true,force:true});
  }
});
function open(directory=mkdtempSync(join(tmpdir(),"helarc-context-foundation-"))) {
  if(!directories.includes(directory))directories.push(directory);
  const db=new ExecutionDatabase(directory);databases.push(db);
  return {db,directory,c:(command:MaterialCustodyCommand)=>db.materialCustodyCommand(db.generation,command).custodyValue,
    a:(command:ActivityHandoffCommand)=>db.activityHandoffCommand(db.generation,command).activityValue,
    accept:(id:string,parts:SharedAcceptanceProposal["parts"],scope="root",actor="root-agent")=>db.acceptShared(db.generation,{id,scope,actor,parts}).acceptanceValue};
}
const recipient={runId:"root",recipient:"root-agent",purpose:"task"};
const scope:ContextUseScope={...recipient,id:"scope",continuity:"conversation",owner:"root-agent",target:"test-model",authorityBasis:"host-grant:1"};
function material(f:ReturnType<typeof open>,text="alpha beta gamma",suffix="one",parts?:readonly number[],format:MaterialCustodyIntent["version"]["format"]="utf8") {
  const bytes=Buffer.from(text),digest=`sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  const range:MaterialRange={materialId:`material:${suffix}`,version:"1",start:0,end:bytes.length,coordinate:"bytes"};
  const intent:MaterialCustodyIntent={id:`custody:${suffix}`,instanceId:`instance:${suffix}`,activityId:`source:${suffix}`,owner:"producer",maximumBytes:bytes.length,
    version:{ref:{materialId:range.materialId,version:range.version},origin:{runId:"child",owner:"producer",recordId:`result:${suffix}`,revision:"1",occurredAt:"2026-10-28T00:00:00Z"},
      label:`Result ${suffix}`,format,mediaType:format==="json"?"application/json":"text/plain",bytes:bytes.length,digest,capture:"complete",limitations:[]}};
  f.c({kind:"begin",intent});let offset=0;
  const boundaries=parts??Array.from({length:Math.ceil(bytes.length/262144)},(_,index)=>Math.min(bytes.length,(index+1)*262144));
  for(const end of boundaries){f.c({kind:"append",id:`chunk:${suffix}:${offset}`,intentId:intent.id,offset,bytesBase64:bytes.subarray(offset,end).toString("base64")});offset=end;}
  f.c({kind:"complete",intentId:intent.id});
  const hold:MaterialHold={id:`hold:${suffix}`,instanceId:intent.instanceId,consumer:recipient,responsibility:"preparation",range,basis:intent.id,releaseCondition:"accepted or explicitly abandoned"};
  const grant:MaterialGrant={id:`grant:${suffix}`,instanceId:intent.instanceId,recipient,range,revision:0,allowed:true,basis:"host delegation"};
  const partsToPublish:readonly ContextAcceptancePart[]=[{owner:"material_custody",kind:"publish",proposal:{intentId:intent.id,holds:[hold],grants:[grant]}}];
  expect(f.accept(`publish:${suffix}`,partsToPublish,"child","producer").outcome).toBe("accepted");
  return {intent,range,hold,grant,text};
}
function representation(f:ReturnType<typeof open>,m:ReturnType<typeof material>,id="representation"):RepresentationRecord {
  const record:RepresentationRecord={ref:{id,revision:"1"},owner:recipient.recipient,runId:recipient.runId,purpose:recipient.purpose,target:scope.target,
    form:"original",body:m.range,inputs:[{role:"source",material:m.range,representation:null}],declaredCoverage:[m.range],details:[m.range],holds:[m.hold.id],requirements:[],losses:[],restorations:[],method:null};
  f.db.representationCommand(f.db.generation,{kind:"record",record});return record;
}
function selection(f:ReturnType<typeof open>,m:ReturnType<typeof material>,r:RepresentationRecord,id="first",previous:string|null=null,keep=false,deliveryIds:readonly string[]=[],consumer="root-agent",inlineFoundation=false) {
  if(!inlineFoundation)f.db.selectionCommand(f.db.generation,{kind:"scope",scope});
  const inputId=`input:${id}`,selectionId=keep?previous!:`selection:${id}`,exactInput={messages:[{role:"user",content:`${m.text}:${id}`}],model:scope.target};
  const judgment:RepresentationJudgment={id:`judgment:${id}`,owner:scope.owner,runId:scope.runId,evidenceSources:[],kind:"combination",subjects:[r.ref],inputs:[m.range],purpose:scope.purpose,target:scope.target,
    methodRevision:"fixture:1",dependencies:{inputDigest:modelInputValueDigest(exactInput)},coverage:[m.range],conclusion:"supported",limitations:["Controlled complete input, not a semantic compaction test"],basis:"independent fixture expectations"};
  if(!inlineFoundation)f.db.representationCommand(f.db.generation,{kind:"judge",judgment});
  const inputHold:MaterialHold={...m.hold,id:`input-hold:${id}`,responsibility:"input",basis:inputId};
  const selectionHold:MaterialHold={...m.hold,id:`selection-hold:${id}`,responsibility:"selection",basis:selectionId};
  const proposal:ContextSelectionProposal={id:`accept:${id}`,scopeId:scope.id,expectedSelectionId:previous,expectedControlRevision:0,
    selection:keep?null:{id:selectionId,representations:[r.ref],judgmentIds:[judgment.id],holds:[selectionHold]},
    input:{id:inputId,activityId:`model-path:${id}`,stageRequestId:`request:${id}`,scopeId:scope.id,selectionId,exactInput,target:scope.target,deliveries:deliveryIds.map(id=>({id,position:"user:0"})),holds:[inputHold],combinationJudgmentId:judgment.id},releaseHolds:[]};
  const purpose=new ActivityPurposeRegistry<null>().register({ref:{id:"task",revision:"1"},inputOwner:"root-agent",executionOwner:"model",interpretationOwner:consumer,acceptanceOwner:consumer,recoveryOwner:consumer,stageKinds:["model"],capabilities:[],continuationKinds:[]},null);
  f.a({kind:"open_path",intent:{id:proposal.input.activityId,runId:"root",owner:consumer,purpose,permissionBasis:"host",resourceScope:proposal.input.activityId,maximumStages:1,maximumAttempts:1,maximumConcurrent:1,deadlineAt:"2030-01-01T00:00:00Z"}});
  if(consumer!==scope.owner)expect(f.accept(`input-need:${id}`,[{owner:"activity",kind:"input_need",proposal:{id:`need:${id}`,supplier:scope.owner,
    stage:{id:proposal.input.stageRequestId,pathId:proposal.input.activityId,stageKind:"model",dependencies:[],capabilities:[]},
    unavailableStage:{id:`${proposal.input.stageRequestId}:unavailable`,pathId:proposal.input.activityId,stageKind:"model",dependencies:[],capabilities:[]}}}],scope.runId,consumer).outcome).toBe("accepted");
  const parts:SharedAcceptanceProposal["parts"]=[
    ...(inlineFoundation?[
      {owner:"context_selection",kind:"scope",proposal:scope},
      {owner:"representation",kind:"judge",proposal:judgment},
    ]:[]),
    {owner:"material_custody",kind:"holds",proposal:{acquire:keep?[inputHold]:[selectionHold,inputHold],release:[],basis:proposal.id}},
    {owner:"context_selection",kind:"selection_input",proposal},
    {owner:"context_delivery",kind:"select",proposal:{inputId,scopeId:scope.id,deliveryIds}},
    {owner:"activity",kind:"stage_submission",proposal:{id:proposal.input.stageRequestId,pathId:proposal.input.activityId,stageKind:"model",input:exactInput,dependencies:[],capabilities:[]}},
  ];
  return {proposal,parts,judgment,inputHold,selectionHold,accept:()=>f.accept(proposal.id,parts)};
}
describe("material custody and consistent selection",()=>{
  it("keeps a judgment's recipient scope distinct from its source representation across recovery",()=>{
    const f=open(),m=material(f),r=representation(f,m),prepared=selection(f,m,r);
    const judgment:RepresentationJudgment={...prepared.judgment,id:"child-judgment",owner:"child-specialist",runId:"child",
      evidenceSources:[{owner:"activity",id:"child-raw-result",runId:"child",revision:null}]};
    expect(f.accept("wrong-judgment-scope",[{owner:"representation",kind:"judge",proposal:judgment}],"root",judgment.owner).outcome).toBe("rejected");
    expect(f.db.representationCommand(f.db.generation,{kind:"read_judgment",id:judgment.id}).representationValue).toBeNull();
    expect(f.accept("child-judgment-acceptance",[{owner:"representation",kind:"judge",proposal:judgment}],"child",judgment.owner).outcome).toBe("accepted");
    const fact=f.db.contextFoundationFacts("child",0,256).contextFacts.find(fact=>fact.subject===judgment.id)!;
    expect(fact.evidence?.subject.runId).toBe("child");
    expect(fact.evidence?.relationships).toContainEqual(expect.objectContaining({kind:"observes",to:{owner:"representation",id:JSON.stringify([r.ref.id,r.ref.revision]),runId:"root",revision:null}}));
    expect(fact.evidence?.relationships).toContainEqual(expect.objectContaining({kind:"observes",to:judgment.evidenceSources[0]}));
    f.db.close();const reopened=open(f.directory);
    expect(reopened.db.representationCommand(reopened.db.generation,{kind:"read_judgment",id:judgment.id}).representationValue).toEqual(judgment);
    expect(reopened.db.contextFoundationFacts("child",0,256).contextFacts.find(restored=>restored.subject===judgment.id)).toEqual(fact);
  });
  it("records exact material access and grant revisions without turning reads into state changes or delivery",()=>{
    const f=open(),m=material(f,"original child material"),access={id:"page-observation",holdId:m.hold.id,recipient,range:m.range};
    f.c({kind:"read",access,offset:0,length:8});
    const read=f.db.contextFoundationFacts("root",0,256).contextFacts.find(fact=>fact.subject===access.id)!;
    expect(read.details).toMatchObject({range:m.range,start:0,end:8,recipient,holdId:m.hold.id});
    expect(read.evidence?.state).toBeNull();
    expect(read.evidence?.relationships).toContainEqual(expect.objectContaining({kind:"observes",to:expect.objectContaining({id:m.intent.instanceId,runId:"child"})}));
    expect(read.evidence?.relationships).toContainEqual(expect.objectContaining({kind:"observes",to:expect.objectContaining({id:m.range.materialId,revision:m.range.version,runId:null})}));
    expect(read.evidence?.relationships.some(edge=>edge.kind==="delivers")).toBe(false);
    f.c({kind:"grant",grant:{...m.grant,revision:1,allowed:false},expectedRevision:0});
    expect(()=>f.c({kind:"read",access,offset:0,length:8})).toThrow("material_unavailable");
    const facts=f.db.contextFoundationFacts("root",0,256).contextFacts;
    expect(facts.filter(fact=>fact.kind==="grant_changed").map(fact=>fact.details)).toMatchObject([
      {previousRevision:null,grant:{revision:0,allowed:true}},{previousRevision:0,grant:{revision:1,allowed:false}},
    ]);
    expect(facts.filter(fact=>fact.kind==="read"&&fact.subject===access.id)).toHaveLength(1);
  });
  it("retires settled input, selection and holds together and restores the same acceptance",()=>{
    const f=open(),m=material(f),r=representation(f,m),s=selection(f,m,r);expect(s.accept().outcome).toBe("accepted");
    const release={owner:"context_selection",kind:"input_retirement",proposal:{inputIds:[s.proposal.input.id],withdrawals:[{
      scopeId:scope.id,expectedSelectionId:s.proposal.input.selectionId,expectedControlRevision:0}],basis:"consumer-closed"}};
    const parts=[release,{owner:"material_custody",kind:"holds",proposal:{acquire:[],release:[s.inputHold.id,s.selectionHold.id],basis:"consumer-closed"}}];
    expect(f.accept("premature-retirement",parts).outcome).toBe("rejected");
    f.a({kind:"cancel",pathId:s.proposal.input.activityId,expectedControlRevision:0});
    expect(f.accept("failed-retirement",[...parts,{owner:"material_custody",kind:"holds",proposal:{acquire:[],release:["missing"],basis:"fixture"}}]).outcome).toBe("rejected");
    expect(f.db.selectionCommand(f.db.generation,{kind:"current",scopeId:scope.id}).selectionValue).toMatchObject({id:s.proposal.input.selectionId});
    expect(()=>f.c({kind:"release",holdId:s.inputHold.id,basis:"not-retired"})).toThrow("still_active");
    expect(f.accept("retirement",parts).outcome).toBe("accepted");f.db.close();const restored=open(f.directory);
    expect(restored.accept("retirement",parts).outcome).toBe("accepted");
    expect(restored.db.selectionCommand(restored.db.generation,{kind:"current",scopeId:scope.id}).selectionValue).toBe(null);
    expect(()=>restored.c({kind:"describe",holdId:s.inputHold.id,recipient})).toThrow("material_unavailable");
    expect(restored.c({kind:"describe",holdId:m.hold.id,recipient})).toMatchObject({hold:m.hold});
  });
  it("retires every legitimately accepted input without a smaller cleanup count ceiling",()=>{
    const f=open(),m=material(f),r=representation(f,m),first=selection(f,m,r);
    expect(first.accept().outcome).toBe("accepted");
    const inputs=[first];
    for(let i=1;i<257;i++) {
      const next=selection(f,m,r,`retire:${i}`,first.proposal.input.selectionId,true);
      expect(next.accept().outcome).toBe("accepted");inputs.push(next);
    }
    for(const input of inputs)f.a({kind:"cancel",pathId:input.proposal.input.activityId,expectedControlRevision:0});
    const parts:SharedAcceptanceProposal["parts"]=[
      {owner:"context_selection",kind:"input_retirement",proposal:{inputIds:inputs.map(input=>input.proposal.input.id),withdrawals:[{
        scopeId:scope.id,expectedSelectionId:first.proposal.input.selectionId,expectedControlRevision:0}],basis:"closed-all"}},
      {owner:"material_custody",kind:"holds",proposal:{acquire:[],release:[first.selectionHold.id,...inputs.map(input=>input.inputHold.id)],basis:"closed-all"}},
    ];
    expect(f.accept("retire-all",parts).outcome).toBe("accepted");f.db.close();const restored=open(f.directory);
    expect(restored.accept("retire-all",parts).outcome).toBe("accepted");
    for(const input of inputs)expect(()=>restored.c({kind:"describe",holdId:input.inputHold.id,recipient})).toThrow("material_unavailable");
    expect(restored.c({kind:"describe",holdId:m.hold.id,recipient})).toMatchObject({hold:m.hold});
  });
  it("does not retire another owner scope or withdraw a replacement selection",()=>{
    const f=open(),m=material(f),r=representation(f,m),s=selection(f,m,r);expect(s.accept().outcome).toBe("accepted");
    f.a({kind:"cancel",pathId:s.proposal.input.activityId,expectedControlRevision:0});
    const release={owner:"context_selection",kind:"input_retirement",proposal:{inputIds:[s.proposal.input.id],withdrawals:[{
      scopeId:scope.id,expectedSelectionId:s.proposal.input.selectionId,expectedControlRevision:0}],basis:"closed"}};
    expect(f.accept("foreign-retirement",[release],"root","another")).toMatchObject({outcome:"rejected",rejection:{code:"selection_release_actor_invalid"}});
    const next=selection(f,m,r,"second",s.proposal.input.selectionId);expect(next.accept().outcome).toBe("accepted");
    expect(f.accept("stale-retirement",[release])).toMatchObject({outcome:"rejected",rejection:{code:"selection_withdraw_conflict"}});
    expect(f.db.selectionCommand(f.db.generation,{kind:"current",scopeId:scope.id}).selectionValue).toMatchObject({id:next.proposal.input.selectionId});
    expect(()=>f.c({kind:"release",holdId:s.inputHold.id,basis:"not-retired"})).toThrow("still_active");
  });
  function admission(m:ReturnType<typeof material>) {
    const consumer={runId:"root",recipient:"context-representation",purpose:"context-compaction"};
    const hold:MaterialHold={...m.hold,id:"method-source-hold",consumer,basis:"method-path",responsibility:"preparation"};
    const grant:MaterialGrant={...m.grant,id:"method-source-grant",recipient:consumer,basis:"host-authorized-method"};
    const source={id:"original-access",holdId:m.hold.id,recipient,range:m.range};
    const part:ContextAcceptancePart={owner:"material_custody",kind:"admit_access",proposal:{source,grant,hold}};
    return {hold,grant,source,part,access:{id:"method-access",holdId:hold.id,recipient:consumer,range:m.range}};
  }
  it("accepts independent method access atomically, reopens it and retains the exact original material",()=>{
    const f=open(),m=material(f),p=admission(m);
    const accepted=f.accept("method-admission",[p.part]);expect(accepted.outcome).toBe("accepted");
    f.c({kind:"release",holdId:m.hold.id,basis:"original consumer settled"});
    f.db.close();databases.splice(databases.indexOf(f.db),1);
    const reopened=open(f.directory);
    expect(reopened.accept("method-admission",[p.part])).toEqual(accepted);
    expect(reopened.c({kind:"read",access:p.access,offset:0,length:m.range.end})).toMatchObject({bytesBase64:Buffer.from(m.text).toString("base64")});
    reopened.c({kind:"grant",grant:{...p.grant,revision:1,allowed:false},expectedRevision:0});
    expect(()=>reopened.c({kind:"read",access:p.access,offset:0,length:1})).toThrow("material_unavailable");
  });
  it("rejects revoked original access without leaving a target hold or grant",()=>{
    const f=open(),m=material(f),p=admission(m);
    f.c({kind:"grant",grant:{...m.grant,revision:1,allowed:false},expectedRevision:0});
    expect(f.accept("method-admission",[p.part]).outcome).toBe("rejected");
    expect(()=>f.c({kind:"describe",holdId:p.hold.id,recipient:p.hold.consumer})).toThrow("material_unavailable");
    expect(()=>f.c({kind:"hold",hold:p.hold})).toThrow("material_unavailable");
  });
  it("rolls back access when a later participant fails and never infers a Parent receipt",()=>{
    const f=open(),m=material(f),p=admission(m);
    expect(f.accept("failed-method-admission",[p.part,{owner:"material_custody",kind:"holds",proposal:{acquire:[],release:["missing"],basis:"fixture"}}]).outcome).toBe("rejected");
    expect(()=>f.c({kind:"hold",hold:p.hold})).toThrow("material_unavailable");
    expect(f.accept("method-admission",[p.part]).outcome).toBe("accepted");
    const deliveries=f.db.selectionCommand(f.db.generation,{kind:"pending_deliveries",recipient:p.hold.consumer,after:0,through:null,limit:10}).selectionValue as ContextDeliveryPage;
    expect(deliveries.entries).toEqual([]);
  });
  it("does not extend the source range or change the receiving Run",()=>{
    const f=open(),m=material(f),p=admission(m);
    expect(f.accept("wide-method-admission",[{...p.part,proposal:{source:{...p.source,range:{...m.range,end:1}},grant:p.grant,hold:p.hold}}]).outcome).toBe("rejected");
    expect(f.accept("wrong-run-method-admission",[p.part],"other-run").outcome).toBe("rejected");
    expect(()=>f.c({kind:"hold",hold:p.hold})).toThrow("material_unavailable");
  });
  it("publishes recipient facts atomically and recovers them without acknowledging Parent delivery",()=>{
    const f=open(),m=material(f);
    for(const s of [scope,{...scope,id:"auxiliary-scope",purpose:"auxiliary"}]) {
      f.db.selectionCommand(f.db.generation,{kind:"scope",scope:s});
      f.a({kind:"subscribe_reconsideration",subscription:{id:`watch:${s.purpose}`,runId:s.runId,owner:s.owner,sources:[contextDeliveryFactSource(s).id]}});
    }
    const hold={...m.hold,id:"delivered-hold",responsibility:"delivery" as const,basis:"delivered"};
    const parts:ContextAcceptancePart[]=[
      {owner:"material_custody",kind:"holds",proposal:{acquire:[hold],release:[],basis:"deliver"}},
      {owner:"context_delivery",kind:"publish",proposal:{id:"delivered",sourceRunId:"child",sourceId:m.intent.version.origin.recordId,recipient,material:m.range,instanceId:m.intent.instanceId,holdId:hold.id,detailHoldId:null}},
    ];
    expect(f.accept("rollback-delivery",[...parts,{owner:"context_delivery",kind:"dispose",proposal:{deliveryId:"missing",recipient,reason:"cancelled",basis:"invalid"}}],"child","producer").outcome).toBe("rejected");
    expect(f.a({kind:"read_reconsideration",subscriptionId:"watch:task",limit:16})).toMatchObject({facts:[]});
    expect(f.db.selectionCommand(f.db.generation,{kind:"delivery",id:"delivered"}).selectionValue).toBeNull();
    expect(f.accept("child-delivery",parts,"child","producer").outcome).toBe("accepted");
    f.db.close();const restored=open(f.directory);
    expect(restored.accept("child-delivery",parts,"child","producer").outcome).toBe("accepted");
    expect(restored.a({kind:"pending_reconsiderations",runId:"root",afterId:null,limit:16})).toMatchObject([{subscription:{id:"watch:task"}}]);
    expect(restored.a({kind:"pending_reconsiderations",runId:"child",afterId:null,limit:16})).toEqual([]);
    expect(restored.a({kind:"read_reconsideration",subscriptionId:"watch:task",limit:16})).toMatchObject({facts:[{ref:{owner:"context_delivery",kind:"published",id:"delivered"}}]});
    expect(restored.db.selectionCommand(restored.db.generation,{kind:"pending_deliveries",recipient,after:0,through:null,limit:16}).selectionValue)
      .toMatchObject({entries:[{delivery:{id:"delivered"},selectedInputId:null}]});
    expect(restored.db.contextFoundationFacts("root",0,256).contextFacts.find(f=>f.kind==="published"&&f.owner==="context_delivery")?.details)
      .toMatchObject({acceptanceId:"child-delivery",acceptanceScope:"child"});
    const publication=restored.db.contextFoundationFacts("root",0,256).contextFacts.filter(f=>f.kind==="published"&&f.owner==="context_delivery");
    expect(publication).toHaveLength(1);
    expect(publication[0]!.evidence?.subject).toMatchObject({owner:"context_delivery",id:"delivered",runId:"root"});
    expect(publication[0]!.evidence?.relationships).toContainEqual(expect.objectContaining({kind:"observes",to:expect.objectContaining({owner:"shared_acceptance",id:"child-delivery",runId:"child"})}));
    expect(publication[0]!.evidence?.relationships).toContainEqual(expect.objectContaining({kind:"observes",to:expect.objectContaining({owner:"material_custody",id:m.intent.instanceId,runId:"child"})}));
    expect(publication[0]!.evidence?.relationships.some(edge=>edge.kind==="delivers")).toBe(false);
  });
  it.each([false,true])("associates multiple inputs and stages by identity, not part order (reverse=%s)",reverse=>{
    const f=open(),m=material(f),r=representation(f,m),first=selection(f,m,r,"first"),second=selection(f,m,r,"second");
    const secondScope={...scope,id:"second-scope",continuity:"independent-consumer"};
    f.db.selectionCommand(f.db.generation,{kind:"scope",scope:secondScope});
    const proposal={...second.proposal,id:first.proposal.id,scopeId:secondScope.id,input:{...second.proposal.input,scopeId:secondScope.id}};
    const secondParts=second.parts.map(part=>part.owner==="context_selection"?{...part,proposal}:part.owner==="context_delivery"?
      {...part,proposal:{inputId:proposal.input.id,scopeId:secondScope.id,deliveryIds:[]}}:part);
    const parts=reverse?[...secondParts,...first.parts]:[...first.parts,...secondParts];
    expect(f.accept(first.proposal.id,parts).outcome).toBe("accepted");
    f.db.close();const restored=open(f.directory);
    expect(restored.accept(first.proposal.id,parts).outcome).toBe("accepted");
    for(const p of [first.proposal,proposal]) {
      expect(restored.db.selectionCommand(restored.db.generation,{kind:"binding",inputId:p.input.id,checkCurrentControl:true}).selectionValue)
        .toMatchObject({scope:{id:p.scopeId},input:{stageRequestId:p.input.stageRequestId,exactInput:p.input.exactInput}});
      expect(restored.a({kind:"read_stage",requestId:p.input.stageRequestId})).toMatchObject({request:{input:p.input.exactInput},status:"submitted"});
    }
  });
  it.each(["stage_submission","select"])("rejects duplicate %s identities without partial input acceptance",kind=>{
    const f=open(),m=material(f),r=representation(f,m),s=selection(f,m,r,"ambiguous");
    const duplicate=s.parts.find(p=>p.kind===kind)!;
    expect(f.accept(s.proposal.id,[duplicate,...s.parts])).toMatchObject({outcome:"rejected",rejection:{code:kind==="stage_submission"?"input_activity_submission_ambiguous":"input_delivery_part_ambiguous"}});
    expect(f.a({kind:"read_stage",requestId:s.proposal.input.stageRequestId})).toBeNull();
    expect(f.db.selectionCommand(f.db.generation,{kind:"current",scopeId:scope.id}).selectionValue).toBeNull();
    expect(()=>f.c({kind:"describe",holdId:s.inputHold.id,recipient})).toThrow();
  });
  it.each(["path","content"])("does not borrow a matching stage identity with wrong %s",change=>{
    const f=open(),m=material(f),r=representation(f,m),s=selection(f,m,r,"mismatch");
    const parts=s.parts.map(part=>part.kind==="stage_submission"?{...part,proposal:{...(part.proposal as object),
      ...(change==="path"?{pathId:"other-path"}:{input:{different:true}})}}:part);
    expect(f.accept(s.proposal.id,parts)).toMatchObject({outcome:"rejected",rejection:{code:"input_activity_submission_missing"}});
    expect(f.a({kind:"read_stage",requestId:s.proposal.input.stageRequestId})).toBeNull();
  });
  it("accepts original scope, combination evidence and consumer input at one boundary",()=>{
    const f=open(),m=material(f),r=representation(f,m),a=selection(f,m,r,"atomic",null,false,[],"task-decision",true);
    expect(a.accept().outcome).toBe("accepted");f.db.close();const restored=open(f.directory);
    expect(restored.db.selectionCommand(restored.db.generation,{kind:"binding",inputId:a.proposal.input.id,checkCurrentControl:true}).selectionValue)
      .toMatchObject({scope,input:{id:a.proposal.input.id},selection:{id:a.proposal.input.selectionId}});
    expect(restored.a({kind:"read_stage",requestId:a.proposal.input.stageRequestId})).toMatchObject({status:"submitted"});
    expect(restored.accept(a.proposal.id,a.parts).outcome).toBe("accepted");
  });
  it("looks up absent, unselected and restored selected scopes without creating a scope",()=>{
    const f=open(),lookup=()=>f.db.selectionCommand(f.db.generation,{kind:"lookup_scope",scopeId:scope.id}).selectionValue;
    expect(lookup()).toBeNull();
    expect(()=>f.db.selectionCommand(f.db.generation,{kind:"current_control",scopeId:scope.id})).toThrow("input_scope_missing");
    f.db.selectionCommand(f.db.generation,{kind:"scope",scope});
    expect(lookup()).toMatchObject({scope,control:{revision:0,allowed:true},selection:null});
    const m=material(f),r=representation(f,m),s=selection(f,m,r);expect(s.accept().outcome).toBe("accepted");
    expect(lookup()).toMatchObject({scope,selection:{id:s.proposal.input.selectionId}});
    f.db.close();const restored=open(f.directory);
    expect(restored.db.selectionCommand(restored.db.generation,{kind:"lookup_scope",scopeId:scope.id}).selectionValue)
      .toMatchObject({scope,control:{revision:0},selection:{id:s.proposal.input.selectionId}});
  });
  it("rolls back scope, judgment and input if the original consumer is cancelled",()=>{
    const f=open(),m=material(f),r=representation(f,m),a=selection(f,m,r,"atomic",null,false,[],"task-decision",true);
    f.a({kind:"cancel",pathId:a.proposal.input.activityId,expectedControlRevision:0});
    expect(a.accept().outcome).toBe("rejected");
    expect(()=>f.db.selectionCommand(f.db.generation,{kind:"current_control",scopeId:scope.id})).toThrow("input_scope_missing");
    expect(f.db.representationCommand(f.db.generation,{kind:"read_judgment",id:a.judgment.id}).representationValue).toBeNull();
    expect(f.a({kind:"read_stage",requestId:a.proposal.input.stageRequestId})).toBeNull();
  });
  it.each(["before","with_settlement"])("separates input selection from consumer receipt %s cancellation settlement",timing=>{
    const f=open(),m=material(f),r=representation(f,m),a=selection(f,m,r,"separate",null,false,[],"task-decision");
    expect(a.accept().outcome).toBe("accepted");
    const requestId=a.proposal.input.stageRequestId,executor={hostSession:"host",worker:"worker",generation:f.db.generation};
    f.a({kind:"admit",requestId,expectedControlRevision:0});
    f.a({kind:"dispatch",attempt:{id:"attempt",requestId,executor,inputDigest:modelInputValueDigest(a.proposal.input.exactInput),startedAt:"2026-10-30T00:00:00Z"},expectedControlRevision:0});
    f.db.selectionCommand(f.db.generation,{kind:"sent",inputId:a.proposal.input.id,attemptId:"attempt"});
    f.a({kind:"save_raw",result:{id:"response",attemptId:"attempt",completeness:"complete",outcome:"returned",value:{answer:"received"},usage:null,recordedAt:"2026-10-30T00:00:01Z"}});
    const parts:ContextAcceptancePart[]=[{owner:"context_delivery",kind:"accept",proposal:{inputId:a.proposal.input.id,responseId:"response",detailHolds:[]}}];
    expect(f.accept("selection-owner-cannot-receive",parts).outcome).toBe("rejected");
    expect(f.accept("wrong-purpose",parts,"root","hook").outcome).toBe("rejected");
    if(timing==="before")expect(f.accept("original-consumer",parts,"root","task-decision").outcome).toBe("accepted");
    const release:ContextAcceptancePart={owner:"context_delivery",kind:"release_selection",proposal:{inputId:a.proposal.input.id,basis:"cancelled"}};
    expect(f.accept("early-release",[release],"root","task-decision").outcome).toBe("rejected");
    f.a({kind:"cancel",pathId:a.proposal.input.activityId,expectedControlRevision:0});
    f.a({kind:"settle",receipt:{id:"settled",requestId,resultId:"response",owner:"task-decision",disposition:{kind:"retained"}},executor,expectedControlRevision:1,
      ...(timing==="with_settlement"?{participants:parts}:{})});
    expect(f.a({kind:"read_path",pathId:a.proposal.input.activityId})).toMatchObject({progressRevision:0,progress:null,cancelled:true});
    expect(f.accept("forged-after-settlement",[{owner:"context_delivery",kind:"accept",proposal:{inputId:a.proposal.input.id,responseId:"other-response",detailHolds:[]}}],"root","task-decision").outcome).toBe("rejected");
    expect(f.accept("recovery-release",[release],"root","task-decision").outcome).toBe("accepted");
  });
  it("discovers a bounded recipient publication range and reselects only after original execution settles",()=>{
    const f=open(),m=material(f),r=representation(f,m);
    const publish=(id:string)=>{
      const hold={...m.hold,id:`hold:${id}`,responsibility:"delivery" as const,basis:id};
      expect(f.accept(`publish:${id}`,[
        {owner:"material_custody",kind:"holds",proposal:{acquire:[hold],release:[],basis:id}},
        {owner:"context_delivery",kind:"publish",proposal:{id,sourceRunId:"child",sourceId:m.intent.version.origin.recordId,recipient,material:m.range,instanceId:m.intent.instanceId,holdId:hold.id,detailHoldId:null}},
      ]).outcome).toBe("accepted");
    };
    const page=(after=0,through:number|null=null)=>f.db.selectionCommand(f.db.generation,{kind:"pending_deliveries",recipient,after,through,limit:1}).selectionValue as ContextDeliveryPage;
    publish("first");publish("second");
    const first=page();expect(first.entries.map(e=>e.delivery.id)).toEqual(["first"]);
    publish("later");
    const second=page(first.nextAfter!,first.through);
    expect(second.entries.map(e=>e.delivery.id)).toEqual(["second"]);expect(second.nextAfter).toBeNull();
    expect(page(0).through).toBeGreaterThan(first.through);
    expect(f.db.selectionCommand(f.db.generation,{kind:"pending_deliveries",recipient:{...recipient,purpose:"auxiliary"},after:0,through:null,limit:10}).selectionValue).toMatchObject({entries:[]});
    const a=selection(f,m,r,"original",null,false,["first"]);a.accept();
    expect(page().entries[0]!.selectedInputId).toBe(a.proposal.input.id);
    const release:ContextAcceptancePart={owner:"context_delivery",kind:"release_selection",proposal:{inputId:a.proposal.input.id,basis:"original request closed without recipient acceptance"}};
    expect(f.accept("premature",[release]).outcome).toBe("rejected");
    f.a({kind:"cancel",pathId:a.proposal.input.activityId,expectedControlRevision:0});
    expect(f.accept("wrong-owner",[release],"root","other-agent").outcome).toBe("rejected");
    expect(f.accept("released",[release]).outcome).toBe("accepted");
    expect(f.accept("released",[release]).outcome).toBe("accepted");
    expect(page().entries[0]!.selectedInputId).toBeNull();
    expect(()=>f.c({kind:"release",holdId:"hold:first",basis:"still owed"})).toThrow("still_active");
    const b=selection(f,m,r,"replacement",a.proposal.input.selectionId,true,["first"]);expect(b.accept().outcome).toBe("accepted");
    expect(page().entries[0]!.selectedInputId).toBe(b.proposal.input.id);
    expect(f.db.selectionCommand(f.db.generation,{kind:"binding",inputId:a.proposal.input.id,checkCurrentControl:false}).selectionValue).toMatchObject({input:{exactInput:a.proposal.input.exactInput}});
    expect(f.db.contextFoundationFacts("root",0,256).contextFacts.filter(fact=>fact.kind==="selection_released")).toHaveLength(1);
    f.a({kind:"subscribe_reconsideration",subscription:{id:"watch-selection",runId:"root",owner:"root-agent",sources:[contextDeliveryFactSource(recipient).id]}});
    const observations=f.a({kind:"read_reconsideration",subscriptionId:"watch-selection",limit:16}) as import("@agent-anything/agent-runtime/activity").ActivityReconsiderationSnapshot;
    expect(observations.facts.filter(f=>f.ref.id==="first").map(f=>f.ref.kind)).toEqual(["published","selected","selection_released","selected"]);
  });
  it("keeps independent selection scopes on the same Run independently current and controlled",()=>{
    const f=open(),m=material(f),r=representation(f,m),first=selection(f,m,r);first.accept();
    const otherScope={...scope,id:"parallel-scope",continuity:"separate-input-stream"};
    f.db.selectionCommand(f.db.generation,{kind:"scope",scope:otherScope});
    const other=selection(f,m,r,"parallel");
    const proposal={...other.proposal,scopeId:otherScope.id,input:{...other.proposal.input,scopeId:otherScope.id}};
    const parts=other.parts.map(part=>part.owner==="context_selection"?{...part,proposal}:
      part.owner==="context_delivery"?{...part,proposal:{inputId:proposal.input.id,scopeId:otherScope.id,deliveryIds:[]}}:part);
    expect(f.accept(proposal.id,parts).outcome).toBe("accepted");
    f.db.selectionCommand(f.db.generation,{kind:"control",control:{scopeId:scope.id,revision:1,allowed:false,basis:"cancel first"},expectedRevision:0});
    expect(()=>f.db.selectionCommand(f.db.generation,{kind:"binding",inputId:first.proposal.input.id,checkCurrentControl:true})).toThrow("control_revoked");
    expect(f.db.selectionCommand(f.db.generation,{kind:"binding",inputId:proposal.input.id,checkCurrentControl:true}).selectionValue).toMatchObject({input:{id:proposal.input.id},scope:otherScope});
  });
  it("rejects a new capacity promise without collecting retained data",()=>{
    const f=open(),m=material(f);
    expect(()=>f.c({kind:"begin",intent:{...m.intent,id:"excess",instanceId:"excess",maximumBytes:8*1024*1024*1024}})).toThrow("storage_budget");
    expect(f.c({kind:"read",access:{id:"retained",holdId:m.hold.id,recipient,range:m.range},offset:0,length:32})).toMatchObject({text:m.text});
    expect(f.c({kind:"state",intentId:"excess"})).toBeNull();
  });
  it("publishes a method product with its professional acceptance and rejects invented provenance atomically",()=>{
    const f=open(),m=material(f),r=representation(f,m),s=selection(f,m,r);s.accept();
    const requestId=s.proposal.input.stageRequestId,executor={hostSession:"host",worker:"worker",generation:f.db.generation};
    f.a({kind:"admit",requestId,expectedControlRevision:0});
    f.a({kind:"dispatch",attempt:{id:"attempt",requestId,executor,inputDigest:modelInputValueDigest(s.proposal.input.exactInput),startedAt:"2026-10-28T00:00:00Z"},expectedControlRevision:0});
    f.a({kind:"save_raw",result:{id:"raw",attemptId:"attempt",completeness:"complete",outcome:"returned",value:"output",usage:null,recordedAt:"2026-10-28T00:00:01Z"}});
    f.a({kind:"claim_processing",claim:{id:"claim",requestId,executor,previousClaimId:null},expectedControlRevision:0});
    const record:RepresentationRecord={...r,ref:{id:"derived",revision:"1"},form:"excerpt",method:{id:"exact-excerpt",revision:"1",activityId:s.proposal.input.activityId,rawResultId:"raw",acceptanceId:"accepted-product"}};
    expect(()=>f.db.representationCommand(f.db.generation,{kind:"record",record})).toThrow("method_unconfirmed");
    const parts=(id:string,product:RepresentationRecord):SharedAcceptanceProposal["parts"]=>[
      {owner:"representation",kind:"record",proposal:product},
      {owner:"activity",kind:"professional_acceptance",proposal:{kind:"accept",receipt:{id,requestId,resultId:"raw",owner:scope.owner,expectedProgressRevision:0,progress:{product:product.ref},next:[]},executor,expectedControlRevision:0}},
    ];
    expect(f.accept("bad-product",parts("bad-product",{...record,method:{...record.method!,rawResultId:"invented",acceptanceId:"bad-product"}}))).toMatchObject({outcome:"rejected",rejection:{code:"representation_method_unconfirmed"}});
    expect(f.a({kind:"read_stage",requestId})).toMatchObject({status:"raw_result",receipt:null});
    expect(f.db.representationCommand(f.db.generation,{kind:"read",ref:record.ref}).representationValue).toBeNull();
    expect(f.accept("accepted-product",parts("accepted-product",record)).outcome).toBe("accepted");
    expect(f.accept("accepted-product",parts("accepted-product",record)).outcome).toBe("accepted");
    f.db.close();const restored=open(f.directory);
    expect(restored.db.representationCommand(restored.db.generation,{kind:"read",ref:record.ref}).representationValue).toEqual(record);
    expect(restored.a({kind:"read_stage",requestId})).toMatchObject({status:"accepted",receipt:{id:"accepted-product"}});
  });
  it("filters authorized discovery and reads JSON paths without widening a partial grant or silently truncating",()=>{
    const f=open(),m=material(f,JSON.stringify({rows:[{value:7},{value:9}],large:"x".repeat(100)}),"structured",undefined,"json");
    const page=f.c({kind:"discover",recipient,after:0,frontier:null,limit:8,filter:{sourceRunId:"child",format:"json",labelIncludes:"structured",occurredFrom:"2026-10-27T00:00:00Z"}});
    expect(page).toMatchObject({values:[{version:{ref:m.intent.version.ref}}],next:null});
    expect(f.c({kind:"discover",recipient,after:0,frontier:null,limit:8,filter:{sourceRunId:"other"}})).toMatchObject({values:[]});
    const command={kind:"read_structure" as const,access:{id:"structure",holdId:m.hold.id,recipient,range:m.range},path:["rows","1","value"],maximumSourceBytes:1024,maximumResultBytes:16};
    expect(f.c(command)).toMatchObject({value:9,path:command.path,sourceRange:m.range,coordinate:"json_path",complete:true});
    expect(()=>f.c({...command,path:["rows","length"]})).toThrow("path_missing");
    expect(()=>f.c({...command,path:["__proto__"]})).toThrow("path_missing");
    expect(()=>f.c({...command,path:["large"]})).toThrow("result_budget");
    expect(()=>f.c({...command,maximumSourceBytes:8})).toThrow("source_budget");
    expect(()=>f.c({...command,access:{...command.access,range:{...m.range,end:8}}})).toThrow("complete_range");
  });
  it("captures unknown-length material under a fixed bound and freezes its verified manifest only on completion",()=>{
    const f=open(),m=material(f),intent={...m.intent,id:"streaming",instanceId:"streaming-instance",maximumBytes:32,
      version:{...m.intent.version,ref:{materialId:"streamed",version:"1"},bytes:null,digest:null}};
    expect(f.c({kind:"begin",intent})).toMatchObject({state:"staging",version:null});
    f.c({kind:"append",id:"stream-1",intentId:intent.id,offset:0,bytesBase64:Buffer.from("first ").toString("base64")});
    expect(f.c({kind:"state",intentId:intent.id})).toMatchObject({bytes:6,version:null});
    f.c({kind:"append",id:"stream-2",intentId:intent.id,offset:6,bytesBase64:Buffer.from("second").toString("base64")});
    expect(f.c({kind:"complete",intentId:intent.id})).toMatchObject({state:"complete",version:{bytes:12,digest:`sha256:${createHash("sha256").update("first second").digest("hex")}`}});
    expect(()=>f.c({kind:"append",id:"late",intentId:intent.id,offset:12,bytesBase64:"YQ=="})).toThrow("bound_invalid");
    f.c({kind:"abandon",intentId:intent.id,owner:intent.owner,basis:"producer closed without publication",cleanupId:"abandoned"});
    expect(f.c({kind:"delete",instanceId:intent.instanceId,cleanupId:"abandoned",maximumChunks:1})).toMatchObject({state:"sealed"});
    expect(f.c({kind:"delete",instanceId:intent.instanceId,cleanupId:"abandoned",maximumChunks:1})).toMatchObject({state:"deleted"});
  });
  it("disposes a cancelled recipient without claiming delivery or releasing another consumer",()=>{
    const f=open(),m=material(f),deliveryHold:MaterialHold={...m.hold,id:"cancelled-delivery-hold",responsibility:"delivery",basis:"cancelled-delivery"};
    expect(f.accept("publish-delivery",[
      {owner:"material_custody",kind:"holds",proposal:{acquire:[deliveryHold],release:[],basis:"publish"}},
      {owner:"context_delivery",kind:"publish",proposal:{id:deliveryHold.basis,sourceRunId:"child",sourceId:m.intent.version.origin.recordId,recipient,material:m.range,instanceId:m.intent.instanceId,holdId:deliveryHold.id,detailHoldId:null}},
    ]).outcome).toBe("accepted");
    expect(()=>f.c({kind:"release",holdId:deliveryHold.id,basis:"not-closed"})).toThrow("still_active");
    expect(f.accept("cancel-delivery",[{owner:"context_delivery",kind:"dispose",proposal:{deliveryId:deliveryHold.basis,recipient,reason:"cancelled",basis:"recipient cancelled"}}]).outcome).toBe("accepted");
    f.c({kind:"release",holdId:deliveryHold.id,basis:"recipient cancelled"});
    expect(f.c({kind:"read",access:{id:"other-consumer",holdId:m.hold.id,recipient,range:m.range},offset:0,length:32})).toMatchObject({text:m.text});
    const facts=f.db.contextFoundationFacts("root",0,256).contextFacts;
    expect(facts.some(fact=>fact.kind==="disposed")).toBe(true);expect(facts.some(fact=>fact.kind==="accepted")).toBe(false);
    expect(facts.filter(fact=>fact.owner==="context_delivery").flatMap(fact=>fact.evidence!.relationships).some(edge=>edge.kind==="delivers")).toBe(false);
  });
  it("gives public tools the same scoped version, bounded search and revoked-access behavior as internal readers",async()=>{
    const f=open(),m=material(f,"alpha ".repeat(70000)+"TARGET"),signal=new AbortController().signal;
    const access=new CustodyMaterialAccess({command:async command=>f.c(command)},recipient);
    const found=await access.search("root",{in:"description",query:"Result"},signal,"discover");
    expect(found.matches).toHaveLength(1);const reference=found.matches[0]!.description.reference;
    const result=await access.search("root",{references:[reference],query:"TARGET"},signal,"search");
    expect(result.matches.map(match=>match.byteStart)).toEqual([420000]);expect(result.exhausted).toBe(true);
    expect((await access.read("root",{reference,offset:420000},signal,"read")).text).toBe("TARGET");
    f.c({kind:"grant",grant:{...m.grant,revision:1,allowed:false},expectedRevision:0});
    await expect(access.read("root",{reference},signal,"revoked")).rejects.toThrow("unavailable");
  });
  it("keeps public material identity across recipients, holds and restart without sharing authority",async()=>{
    const f=open(),m=material(f,"retained detail"),signal=new AbortController().signal;
    const access=new CustodyMaterialAccess({command:async command=>f.c(command)},recipient);
    const reference=(await access.search("root",{in:"description"},signal,"find")).matches[0]!.description.reference;
    const child={runId:"child-reader",recipient:"child-agent",purpose:"task"};
    const childAccess=new CustodyMaterialAccess({command:async command=>f.c(command)},child);
    await expect(childAccess.read(child.runId,{reference},signal,"not-admitted")).rejects.toThrow("unavailable");
    const hold={...m.hold,id:"child-detail",consumer:child,responsibility:"detail" as const,basis:"delegation"};
    const admission=[{owner:"material_custody" as const,kind:"admit_access" as const,proposal:{
      source:{id:"source-access",holdId:m.hold.id,range:m.range,recipient},hold,
      grant:{...m.grant,id:"child-grant",recipient:child,basis:"delegation"}}}];
    expect(f.accept("child-admission",admission,child.runId,child.recipient).outcome).toBe("accepted");
    expect((await childAccess.read(child.runId,{reference},signal,"read-child")).text).toBe(m.text);
    f.c({kind:"release",holdId:m.hold.id,basis:"parent-done"});
    await expect(access.read("root",{reference},signal,"parent-released")).rejects.toThrow("unavailable");
    expect((await childAccess.read(child.runId,{reference},signal,"child-retained")).text).toBe(m.text);
    f.db.close();const reopened=open(f.directory);
    const restored=new CustodyMaterialAccess({command:async command=>reopened.c(command)},child);
    expect((await restored.read(child.runId,{reference},signal,"after-restart")).text).toBe(m.text);
    expect((await restored.search(child.runId,{in:"description"},signal,"rediscover")).matches[0]!.description.reference).toEqual(reference);
    await expect(restored.read(child.runId,{reference:{...reference,revision:`sha256:${"0".repeat(64)}`}},signal,"wrong-version")).rejects.toThrow("reference_changed");
    reopened.c({kind:"grant",grant:{...m.grant,id:"child-grant",recipient:child,basis:"delegation",revision:1,allowed:false},expectedRevision:0});
    await expect(restored.read(child.runId,{reference},signal,"child-revoked")).rejects.toThrow("unavailable");
    // Replay of the original accepted transfer cannot revive revoked authority.
    expect(reopened.accept("child-admission",admission,child.runId,child.recipient).outcome).toBe("accepted");
    await expect(restored.read(child.runId,{reference},signal,"still-revoked")).rejects.toThrow("unavailable");
  });
  it("resolves an authorized retained instance of the same material view without reviving a revoked instance",async()=>{
    const f=open(),m=material(f,"replicated material"),signal=new AbortController().signal;
    const access=new CustodyMaterialAccess({command:async command=>f.c(command)},recipient);
    const reference=(await access.search("root",{in:"description"},signal,"find-replica")).matches[0]!.description.reference;
    const intent={...m.intent,id:"replica",instanceId:"replica-instance"};
    f.c({kind:"begin",intent});f.c({kind:"append",id:"replica-chunk",intentId:intent.id,offset:0,bytesBase64:Buffer.from(m.text).toString("base64")});
    f.c({kind:"complete",intentId:intent.id});
    const hold={...m.hold,id:"zz-replica-hold",instanceId:intent.instanceId},grant={...m.grant,id:"replica-grant",instanceId:intent.instanceId};
    expect(f.accept("publish-replica",[{owner:"material_custody",kind:"publish",proposal:{intentId:intent.id,holds:[hold],grants:[grant]}}],"child","producer").outcome).toBe("accepted");
    f.c({kind:"grant",grant:{...m.grant,revision:1,allowed:false},expectedRevision:0});
    expect((await access.read("root",{reference},signal,"replica-read")).text).toBe(m.text);
    f.c({kind:"grant",grant:{...grant,revision:1,allowed:false},expectedRevision:0});
    await expect(access.read("root",{reference},signal,"all-revoked")).rejects.toThrow("unavailable");
  });
  it("rejects a selection without the matching durable activity and rejects invented send acknowledgements",()=>{
    const f=open(),m=material(f),r=representation(f,m),a=selection(f,m,r);
    expect(f.accept(a.proposal.id,a.parts.filter(part=>part.owner!=="activity"))).toMatchObject({outcome:"rejected",rejection:{code:"input_activity_submission_missing"}});
    expect(()=>f.c({kind:"release",holdId:a.inputHold.id,basis:"discard"})).toThrow("hold_missing");
    const b=selection(f,m,r,"valid");expect(b.accept().outcome).toBe("accepted");
    expect(f.a({kind:"read_stage",requestId:b.proposal.input.stageRequestId})).toMatchObject({status:"submitted"});
    expect(()=>f.db.selectionCommand(f.db.generation,{kind:"sent",inputId:b.proposal.input.id,attemptId:"invented"})).toThrow("not_confirmed");
  });
  it("reopens bounded custody before publication without fabricating another source",()=>{
    const first=open(),bytes=Buffer.from("frozen bytes"),digest=`sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    const intent:MaterialCustodyIntent={id:"write",instanceId:"physical:1",activityId:"operation:1",owner:"owner",maximumBytes:bytes.length,
      version:{ref:{materialId:"m",version:"v"},origin:{runId:"child",owner:"owner",recordId:"result",revision:"1",occurredAt:"2026-10-28T00:00:00Z"},label:"output",format:"utf8",mediaType:"text/plain",bytes:bytes.length,digest,capture:"prefix",limitations:["still growing"]}};
    first.c({kind:"begin",intent});first.c({kind:"append",id:"chunk1",intentId:intent.id,offset:0,bytesBase64:bytes.subarray(0,4).toString("base64")});first.db.close();
    const second=open(first.directory);expect(second.c({kind:"state",intentId:intent.id})).toMatchObject({bytes:4,state:"staging"});
    second.c({kind:"append",id:"chunk1",intentId:intent.id,offset:0,bytesBase64:bytes.subarray(0,4).toString("base64")});
    second.c({kind:"append",id:"chunk2",intentId:intent.id,offset:4,bytesBase64:bytes.subarray(4).toString("base64")});
    expect(second.c({kind:"complete",intentId:intent.id})).toMatchObject({state:"complete",bytes:bytes.length});
    expect(second.db.listRetentionPins()).toContainEqual({ownerId:"child",reason:"context_material"});
  });
  it("reads split UTF-8 and searches across chunks with explicit finite scan coverage",()=>{
    const f=open(),m=material(f,"alpha \u96ea beta ALPHA end","utf8",[8,12,27]);
    const access={id:"read",holdId:m.hold.id,recipient,range:m.range};
    let offset=0,text="";
    do{const page=f.c({kind:"read",access:{...access,id:`read:${offset}`},offset,length:8}) as MaterialReadPage;text+=page.text;offset=page.next??m.range.end;}while(offset<m.range.end);
    expect(text).toBe(m.text);
    let cursor:string|undefined,complete=false;const positions:number[]=[];
    do{const page=f.c({kind:"search",request:{...access,id:`search:${positions.length}:${cursor??"first"}`,query:"alpha",caseMode:"ascii_insensitive",maximumMatches:1,scanBytes:6,...(cursor?{cursor}:{})}}) as MaterialSearchPage;
      positions.push(...page.matches.map(match=>match.start));cursor=page.next??undefined;complete=page.complete;
    }while(!complete);
    expect(positions).toEqual([0,15]);
    const page=f.c({kind:"search",request:{...access,id:"none",query:"zzz",caseMode:"sensitive",maximumMatches:5,scanBytes:5}}) as MaterialSearchPage;
    expect(page).toMatchObject({matches:[],complete:false,stop:"scan_budget"});
    expect(()=>f.c({kind:"search",request:{...access,id:"changed",query:"other",caseMode:"sensitive",maximumMatches:5,scanBytes:6,cursor:page.next!}})).toThrow("cursor_invalid");
  });
  it("keeps equal bytes in independent source and recipient scopes, and checks revoked grants on every read",()=>{
    const f=open(),a=material(f,"same","a"),b=material(f,"same","b");
    expect(a.intent.version.digest).toBe(b.intent.version.digest);expect(a.range.materialId).not.toBe(b.range.materialId);
    expect(()=>f.c({kind:"read",access:{id:"wrong",holdId:a.hold.id,recipient:{...recipient,runId:"other-child"},range:a.range},offset:0,length:16})).toThrow();
    f.c({kind:"grant",grant:{...a.grant,revision:1,allowed:false},expectedRevision:0});
    expect(()=>f.c({kind:"read",access:{id:"revoked",holdId:a.hold.id,recipient,range:a.range},offset:0,length:16})).toThrow("unavailable");
    expect(f.c({kind:"read",access:{id:"other",holdId:b.hold.id,recipient,range:b.range},offset:0,length:16})).toMatchObject({text:"same"});
  });
  it("seals a physical instance against new holds and does not let late deletion erase re-custodied bytes",()=>{
    const f=open(),m=material(f);
    expect(()=>f.c({kind:"seal",instanceId:m.intent.instanceId,cleanupId:"cleanup"})).toThrow("retained");
    f.c({kind:"release",holdId:m.hold.id,basis:"abandoned"});f.c({kind:"seal",instanceId:m.intent.instanceId,cleanupId:"cleanup"});
    expect(()=>f.c({kind:"hold",hold:{...m.hold,id:"late"}})).toThrow("unavailable");
    const intent={...m.intent,id:"custody:new",instanceId:"instance:new"};
    f.c({kind:"begin",intent});f.c({kind:"append",id:"new-chunk",intentId:intent.id,offset:0,bytesBase64:Buffer.from(m.text).toString("base64")});f.c({kind:"complete",intentId:intent.id});
    const hold={...m.hold,id:"new-hold",instanceId:intent.instanceId};
    expect(f.accept("new-publish",[{owner:"material_custody",kind:"publish",proposal:{intentId:intent.id,holds:[hold],grants:[{...m.grant,id:"new-grant",instanceId:intent.instanceId}]}}],"child","producer").outcome).toBe("accepted");
    expect(f.c({kind:"delete",instanceId:m.intent.instanceId,cleanupId:"cleanup",maximumChunks:1})).toMatchObject({state:"deleted"});
    expect(f.c({kind:"read",access:{id:"after-delete",holdId:hold.id,recipient,range:m.range},offset:0,length:32})).toMatchObject({text:m.text});
  });
  it("atomically accepts scoped selection, exact input and holds, retaining an older input after a new selection",()=>{
    const f=open(),m=material(f),r=representation(f,m),first=selection(f,m,r);
    expect(first.accept().outcome).toBe("accepted");expect(first.accept().outcome).toBe("accepted");
    const second=selection(f,m,r,"second",first.proposal.input.selectionId);expect(second.accept().outcome).toBe("accepted");
    f.db.close();const restored=open(f.directory);
    const binding=restored.db.selectionCommand(restored.db.generation,{kind:"binding",inputId:first.proposal.input.id,checkCurrentControl:true}).selectionValue as ContextSelectionSnapshot;
    expect(binding.input.exactInput).toEqual(first.proposal.input.exactInput);expect(binding.selection.id).toBe(first.proposal.input.selectionId);
    expect(restored.db.selectionCommand(restored.db.generation,{kind:"current",scopeId:scope.id}).selectionValue).toMatchObject({id:second.proposal.input.selectionId});
    expect(()=>restored.c({kind:"release",holdId:first.inputHold.id,basis:"not-retired"})).toThrow("still_active");
    restored.db.selectionCommand(restored.db.generation,{kind:"control",control:{scopeId:scope.id,revision:1,allowed:false,basis:"revoked"},expectedRevision:0});
    expect(()=>restored.db.selectionCommand(restored.db.generation,{kind:"binding",inputId:first.proposal.input.id,checkCurrentControl:true})).toThrow("revoked");
  });
  it("rolls back all participants on stale selection while keeping candidate and judgment evidence",()=>{
    const f=open(),m=material(f),r=representation(f,m),a=selection(f,m,r),b=selection(f,m,r,"competitor");
    expect(a.accept().outcome).toBe("accepted");expect(b.accept()).toMatchObject({outcome:"rejected",rejection:{code:"selection_conflict"}});
    expect(()=>f.c({kind:"release",holdId:b.inputHold.id,basis:"discard"})).toThrow("hold_missing");
    expect(f.db.representationCommand(f.db.generation,{kind:"read",ref:r.ref}).representationValue).toEqual(r);
    expect(f.db.querySharedAcceptance(f.db.generation,b.proposal.id)).toMatchObject({outcome:"rejected"});
  });
  it("keeps the selection unchanged while accepting a new complete input",()=>{
    const f=open(),m=material(f),r=representation(f,m),a=selection(f,m,r);a.accept();
    const b=selection(f,m,r,"new-information",a.proposal.input.selectionId,true);expect(b.accept().outcome).toBe("accepted");
    const binding=f.db.selectionCommand(f.db.generation,{kind:"binding",inputId:b.proposal.input.id,checkCurrentControl:true}).selectionValue as ContextSelectionSnapshot;
    expect(binding.selection.id).toBe(a.proposal.input.selectionId);expect(binding.input.exactInput).toEqual(b.proposal.input.exactInput);
  });
  it("does not turn background reads into Parent delivery and retains promised details after actual response acceptance",()=>{
    const f=open(),m=material(f),r=representation(f,m);
    const deliveryHold:MaterialHold={...m.hold,id:"delivery-hold",responsibility:"delivery",basis:"delivery"};
    const detailHold:MaterialHold={...m.hold,id:"detail-hold",responsibility:"detail",basis:"detail promise"};
    expect(f.accept("deliver",[
      {owner:"material_custody",kind:"holds",proposal:{acquire:[deliveryHold,detailHold],release:[],basis:"deliver"}},
      {owner:"context_delivery",kind:"publish",proposal:{id:"delivery",sourceRunId:"child",sourceId:m.intent.version.origin.recordId,recipient,material:m.range,instanceId:m.intent.instanceId,holdId:deliveryHold.id,detailHoldId:detailHold.id}},
    ]).outcome).toBe("accepted");
    f.c({kind:"read",access:{id:"auxiliary-read",holdId:m.hold.id,recipient,range:m.range},offset:0,length:32});
    const a=selection(f,m,r,"parent",null,false,["delivery"]);expect(a.accept().outcome).toBe("accepted");
    expect(f.accept("forged-received",[{owner:"context_delivery",kind:"accept",proposal:{inputId:a.proposal.input.id,responseId:"invented",detailHolds:[detailHold.id]}}]).outcome).toBe("rejected");
    const requestId=a.proposal.input.stageRequestId;
    f.a({kind:"admit",requestId,expectedControlRevision:0});
    const executor={hostSession:"host",worker:"worker",generation:f.db.generation};
    f.a({kind:"dispatch",attempt:{id:"attempt",requestId,executor,inputDigest:modelInputValueDigest(a.proposal.input.exactInput),startedAt:"2026-10-28T00:00:00Z"},expectedControlRevision:0});
    f.db.selectionCommand(f.db.generation,{kind:"sent",inputId:a.proposal.input.id,attemptId:"attempt"});
    f.a({kind:"save_raw",result:{id:"actual-response",attemptId:"attempt",completeness:"complete",outcome:"returned",value:{answer:"received"},usage:null,recordedAt:"2026-10-28T00:00:01Z"}});
    expect(f.accept("received",[{owner:"context_delivery",kind:"accept",proposal:{inputId:a.proposal.input.id,responseId:"actual-response",detailHolds:[detailHold.id]}}]).outcome).toBe("accepted");
    f.c({kind:"release",holdId:deliveryHold.id,basis:"received"});
    expect(f.c({kind:"read",access:{id:"later-detail",holdId:detailHold.id,recipient,range:m.range},offset:0,length:32})).toMatchObject({text:m.text});
    expect(f.db.contextFoundationFacts("root",0,256).contextFacts.some(fact=>fact.kind==="accepted")).toBe(true);
    f.a({kind:"subscribe_reconsideration",subscription:{id:"watch-received",runId:"root",owner:"root-agent",sources:[contextDeliveryFactSource(recipient).id]}});
    const observations=f.a({kind:"read_reconsideration",subscriptionId:"watch-received",limit:16}) as import("@agent-anything/agent-runtime/activity").ActivityReconsiderationSnapshot;
    expect(observations.facts.map(f=>f.ref.kind)).toEqual(["published","selected","accepted"]);
  });
  it("carries direct-input losses and keeps scoped judgments distinct from new reuse decisions",()=>{
    const f=open(),m=material(f),original=representation(f,m);
    const loss={id:"loss",source:m.range,kind:"precision" as const,description:"numbers rounded",basis:"method report"};
    const a={...original,ref:{id:"summary",revision:"1"},form:"summary" as const,inputs:[{role:"source" as const,material:m.range,representation:original.ref}],losses:[loss]};
    f.db.representationCommand(f.db.generation,{kind:"record",record:a});
    expect(()=>f.db.representationCommand(f.db.generation,{kind:"record",record:{...a,ref:{id:"second",revision:"1"},inputs:[{role:"source",material:m.range,representation:a.ref}],losses:[]}})).toThrow("inherited_loss_missing");
    const prepared=selection(f,m,a,"reuse");
    const request={id:"reuse:1",runId:scope.runId,judgmentId:prepared.judgment.id,purpose:scope.purpose,target:scope.target,methodRevision:prepared.judgment.methodRevision,subjects:[a.ref],dependencies:prepared.judgment.dependencies};
    expect(f.db.representationCommand(f.db.generation,{kind:"reuse",request}).representationValue).toMatchObject({applicable:true});
    expect(f.db.representationCommand(f.db.generation,{kind:"reuse",request:{...request,id:"reuse:2",dependencies:{inputDigest:"changed"}}}).representationValue).toMatchObject({applicable:false,reasons:["dependencies_changed"]});
  });
});
