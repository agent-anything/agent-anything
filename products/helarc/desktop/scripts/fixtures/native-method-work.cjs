const assert=require("node:assert/strict"),{createHash}=require("node:crypto"),{writeFile}=require("node:fs/promises"),{join}=require("node:path");

module.exports=async function({app,store,executionPorts,composition,p,protocolName,phase,directory,h,runtime,digest,ref}){
  const {ActivityPurposeRegistry,ActivityHandoffProcessor}=await import("@agent-anything/agent-runtime/activity");
  const {RepresentationMethodWork}=await import("@agent-anything/agent-runtime/context-representation");
  const registry=new ActivityPurposeRegistry(),recipient={runId:"root",recipient:"context-representation",purpose:"method"};
  const signal=new AbortController().signal,now=()=>new Date().toISOString(),journal=store.protocolJournal;
  const factories=await import("@agent-anything/helarc/composition");
  const factory=protocolName==="responses"?factories.createHelarcResponsesStructuredPurposes:
    protocolName==="deepseek"?factories.createHelarcDeepSeekStructuredPurposes:factories.createHelarcOllamaStructuredPurposes;
  const purposes=factory({execution:executionPorts,selections:store.contextSelections,methodPurpose:ref("method"),composition:async()=>composition,
    conditions:async source=>({input:source.source,authority:ref("original-disclosure"),resources:ref("bounded-method"),control:ref("active")}),
    retainTransport:async request=>request},protocolName==="responses"?{stream:false,store:false}:
      protocolName==="deepseek"?{stream:false,thinking:{type:"disabled"}}:{stream:false,think:false});
  const work=new RepresentationMethodWork({nativeModel:purposes.methodParticipant,
    materials:store.materialCustody,representations:store.representations,selections:store.contextSelections,activities:store.activityHandoffs,now,
    authorize:async path=>{assert.equal(path.intent.permissionBasis,"original-disclosure");return {kind:"allowed"};}},registry);
  const processor=new ActivityHandoffProcessor(store.activityHandoffs,registry,store.activityJournal.executor,now);
  const m=c=>store.materialCustody.command(c),a=c=>store.activityHandoffs.command(c);
  const text="Verification code 7391 is unconfirmed. "+"Read-only measurements; no effects. ".repeat(150),bytes=Buffer.from(text);
  const range={materialId:"original-report",version:`sha256:${createHash("sha256").update(bytes).digest("hex")}`,coordinate:"bytes",start:0,end:bytes.length};
  const access={id:"method-source",holdId:"method-source",recipient,range};
  if(phase==="observation"){
    await m({kind:"begin",intent:{id:"capture",instanceId:"original-report",activityId:"source",owner:"source-owner",maximumBytes:bytes.length,
      version:{ref:{materialId:range.materialId,version:range.version},origin:{runId:"child",owner:"source-owner",recordId:"original-result",revision:"1",occurredAt:"2026-11-15T00:00:00Z"},
        label:"Full report",format:"utf8",mediaType:"text/plain",bytes:bytes.length,digest:range.version,capture:"complete",limitations:[]}}});
    await m({kind:"append",id:"source-bytes",intentId:"capture",offset:0,bytesBase64:bytes.toString("base64")});await m({kind:"complete",intentId:"capture"});
    const hold={id:access.holdId,instanceId:"original-report",consumer:recipient,responsibility:"preparation",range,basis:"method-path",releaseCondition:"explicit owner settlement"};
    const detail={...hold,id:"parent-detail",consumer:{runId:"root",recipient:"parent-agent",purpose:"task"},responsibility:"detail"};
    const accepted=await store.sharedAcceptance.accept({id:"source-publication",scope:"child",actor:"source-owner",parts:[{owner:"material_custody",kind:"publish",proposal:{intentId:"capture",
      holds:[hold,detail],grants:[hold,detail].map(h=>({id:`${h.id}:grant`,instanceId:h.instanceId,recipient:h.consumer,range,revision:0,allowed:true,basis:"original-disclosure"}))}}]});assert.equal(accepted.outcome,"accepted");
    const request={kind:"representation_method",method:"summarize",methodRevision:"1",recipient,objective:"this purpose: method. Preserve the code, uncertainty and absence of effects.",
      sources:[{alias:"source",role:"source",access,representation:null,order:0,label:"Full report",originalRole:"child_result",indivisibleGroup:"report"}],
      requirements:[{id:"code",revision:"1",basis:"original-report",description:"Keep 7391 and original uncertainty."}],relationships:[],sourceBoundary:"original-report-v1",
      deliveryIds:[],combinationDigest:null,combine:"keep",omission:null,search:null,nativeComposition:composition,targetRevision:"original",
      capacity:{limits:[{id:"request-bytes",targetRevision:"original",dimension:"request_bytes",maximum:100000,source:"controlled fixture transport budget"}],reservations:[],
        policy:{id:"fixture",revision:"1",purpose:"method",basis:"Exact native body bytes; token capacity unknown, explicitly allowed",allowEstimatedFit:false,allowUnknown:true},maximumCombinations:4,maximumMeasurements:0},
      bounds:{readBytes:1000000,storedBytes:100000,modelCalls:6,repairs:1,levels:3,pageBytes:4096,ranges:16}};
    await work.submit({id:"method-path",runId:"root",permissionBasis:"original-disclosure",resourceScope:"method-path",maximumStages:64,maximumAttempts:64,maximumConcurrent:1,
      deadlineAt:"2030-01-01T00:00:00Z"},request);
  }
  if(phase==="purpose"){
    const accept=store.sharedAcceptance.accept.bind(store.sharedAcceptance);
    store.sharedAcceptance.accept=async proposal=>{const receipt=await accept(proposal);
      if(receipt.outcome==="accepted"&&proposal.parts.some(p=>p.owner==="protocol_execution"&&p.kind==="purpose")){app.exit(73);await new Promise(()=>{});}return receipt;};
  }
  let result;
  for(let i=0;i<128;i++){
    result=await work.result("method-path");
    if(result.kind==="gap")throw new Error(JSON.stringify(result.progress.gap));
    if(result.kind==="ready")break;
    await processor.drain("root",signal);
  }
  assert.equal(result.kind,"ready");assert.equal(result.progress.modelCalls,4,"Failed preservation check must cause exactly one repair and recheck");
  assert.equal(result.progress.candidates.length,2);assert.equal(result.progress.assessments.length,2);
  assert.equal(result.progress.assessments[0].supported,false);assert.equal(result.progress.assessments[1].supported,true);
  if(phase==="ready"){app.exit(73);await new Promise(()=>{});}
  assert.equal(phase,"verify");
  const candidate=result.progress.candidates.find(c=>result.progress.resultIds.includes(c.id)),page=await m({kind:"read",access:candidate.access,offset:0,length:candidate.access.range.end});
  assert(page.text.includes("7391")&&page.text.includes("unconfirmed"));
  const parent={runId:"root",recipient:"parent-agent",purpose:"task"};
  assert((await m({kind:"read",access:{id:"parent-read",holdId:"parent-detail",recipient:parent,range},offset:0,length:range.end})).text===text);
  const facts=await journal.command({kind:"facts",runId:"root",after:0,limit:128}),accepted=facts.filter(f=>f.kind==="purpose_accepted");assert.equal(accepted.length,4);
  const pending=await a({kind:"pending",runId:"root",after:0,limit:256});assert.equal(pending.length,0);
  for(const assessment of result.progress.assessments){
    const judgment=await store.representations.command({kind:"read_judgment",id:assessment.judgmentIds[0]});
    const stage=await a({kind:"read_stage",requestId:judgment.dependencies.stage});
    assert.equal(stage.result.value.evidence.scope.purpose.id,"method");assert.equal(stage.result.value.evidence.scope.recipientId,"context-representation");
    assert(stage.result.value.evidence.sources.length);assert.equal(stage.receipt.id,judgment.dependencies.acceptance);
  }
  await work.releaseInputs("method-path");
  await writeFile(join(directory,"verification.json"),JSON.stringify({protocol:protocolName,generation:store.generation,accepted:accepted.length,modelCalls:4,candidates:2,
    rejectedChecks:1,acceptedChecks:1,originalDetailRetained:true,nativePurposeToProfessionalJudgment:true},null,2));
};
