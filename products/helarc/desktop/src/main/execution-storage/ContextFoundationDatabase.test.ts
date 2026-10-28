import {afterEach,describe,expect,it} from "vitest";
import {mkdtempSync,rmSync} from "node:fs";
import {join,dirname,resolve,basename} from "node:path";
import {tmpdir} from "node:os";
import {createHash} from "node:crypto";
import {modelInputValueDigest} from "@agent-anything/model-interaction/input";
import {ActivityPurposeRegistry,type ActivityHandoffCommand,type SharedAcceptanceProposal} from "@agent-anything/agent-runtime/activity";
import type {MaterialCustodyCommand,MaterialCustodyIntent,MaterialHold,MaterialRange,MaterialSearchPage,MaterialReadPage,MaterialGrant} from "@agent-anything/context/custody";
import {CustodyMaterialAccess} from "@agent-anything/context/custody";
import type {RepresentationRecord,RepresentationJudgment} from "@agent-anything/context/representation";
import type {ContextAcceptancePart,ContextSelectionProposal,ContextSelectionSnapshot,ContextUseScope} from "@agent-anything/context/selection";
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
function selection(f:ReturnType<typeof open>,m:ReturnType<typeof material>,r:RepresentationRecord,id="first",previous:string|null=null,keep=false,deliveryIds:readonly string[]=[]) {
  f.db.selectionCommand(f.db.generation,{kind:"scope",scope});
  const inputId=`input:${id}`,selectionId=keep?previous!:`selection:${id}`,exactInput={messages:[{role:"user",content:`${m.text}:${id}`}],model:scope.target};
  const judgment:RepresentationJudgment={id:`judgment:${id}`,owner:scope.owner,kind:"combination",subjects:[r.ref],inputs:[m.range],purpose:scope.purpose,target:scope.target,
    methodRevision:"fixture:1",dependencies:{inputDigest:modelInputValueDigest(exactInput)},coverage:[m.range],conclusion:"supported",limitations:["Controlled complete input, not a semantic compaction test"],basis:"independent fixture expectations"};
  f.db.representationCommand(f.db.generation,{kind:"judge",judgment});
  const inputHold:MaterialHold={...m.hold,id:`input-hold:${id}`,responsibility:"input",basis:inputId};
  const selectionHold:MaterialHold={...m.hold,id:`selection-hold:${id}`,responsibility:"selection",basis:selectionId};
  const proposal:ContextSelectionProposal={id:`accept:${id}`,scopeId:scope.id,expectedSelectionId:previous,expectedControlRevision:0,
    selection:keep?null:{id:selectionId,representations:[r.ref],judgmentIds:[judgment.id],holds:[selectionHold]},
    input:{id:inputId,activityId:`model-path:${id}`,stageRequestId:`request:${id}`,scopeId:scope.id,selectionId,exactInput,target:scope.target,deliveries:deliveryIds.map(id=>({id,position:"user:0"})),holds:[inputHold],combinationJudgmentId:judgment.id},releaseHolds:[]};
  const purpose=new ActivityPurposeRegistry<null>().register({ref:{id:"task",revision:"1"},inputOwner:"root-agent",executionOwner:"model",interpretationOwner:"root-agent",acceptanceOwner:"root-agent",recoveryOwner:"root-agent",stageKinds:["model"],capabilities:[],continuationKinds:[]},null);
  f.a({kind:"open_path",intent:{id:proposal.input.activityId,runId:"root",owner:"root-agent",purpose,permissionBasis:"host",resourceScope:proposal.input.activityId,maximumStages:1,maximumAttempts:1,maximumConcurrent:1,deadlineAt:"2030-01-01T00:00:00Z"}});
  const parts:SharedAcceptanceProposal["parts"]=[
    {owner:"material_custody",kind:"holds",proposal:{acquire:keep?[inputHold]:[selectionHold,inputHold],release:[],basis:proposal.id}},
    {owner:"context_selection",kind:"selection_input",proposal},
    {owner:"context_delivery",kind:"select",proposal:{inputId,scopeId:scope.id,deliveryIds}},
    {owner:"activity",kind:"stage_submission",proposal:{id:proposal.input.stageRequestId,pathId:proposal.input.activityId,stageKind:"model",input:exactInput,dependencies:[],capabilities:[]}},
  ];
  return {proposal,parts,judgment,inputHold,selectionHold,accept:()=>f.accept(proposal.id,parts)};
}
describe("material custody and consistent selection",()=>{
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
  });
  it("carries direct-input losses and keeps scoped judgments distinct from new reuse decisions",()=>{
    const f=open(),m=material(f),original=representation(f,m);
    const loss={id:"loss",source:m.range,kind:"precision" as const,description:"numbers rounded",basis:"method report"};
    const a={...original,ref:{id:"summary",revision:"1"},form:"summary" as const,inputs:[{role:"source" as const,material:m.range,representation:original.ref}],losses:[loss]};
    f.db.representationCommand(f.db.generation,{kind:"record",record:a});
    expect(()=>f.db.representationCommand(f.db.generation,{kind:"record",record:{...a,ref:{id:"second",revision:"1"},inputs:[{role:"source",material:m.range,representation:a.ref}],losses:[]}})).toThrow("inherited_loss_missing");
    const prepared=selection(f,m,a,"reuse");
    const request={id:"reuse:1",judgmentId:prepared.judgment.id,purpose:scope.purpose,target:scope.target,methodRevision:prepared.judgment.methodRevision,subjects:[a.ref],dependencies:prepared.judgment.dependencies};
    expect(f.db.representationCommand(f.db.generation,{kind:"reuse",request}).representationValue).toMatchObject({applicable:true});
    expect(f.db.representationCommand(f.db.generation,{kind:"reuse",request:{...request,id:"reuse:2",dependencies:{inputDigest:"changed"}}}).representationValue).toMatchObject({applicable:false,reasons:["dependencies_changed"]});
  });
});
