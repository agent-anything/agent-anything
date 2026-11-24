const assert=require("node:assert/strict"),{createHash}=require("node:crypto"),{join}=require("node:path"),{pathToFileURL}=require("node:url");

module.exports=async function createConversion({store,h,native,profile,structured,checkpoint,phase}){
  const {modelInputValueDigest:digest,readModelResultContentTextSlot}=await import("@agent-anything/model-interaction/input");
  const {helarcResultTextDeclaration}=await import("@agent-anything/helarc/prompt");
  const {ActivityPurposeRegistry,ActivityChangeWait}=await import("@agent-anything/agent-runtime/activity");
  const {contextPreparationAdoption,contextPreparationAcceptance,quoteRepresentationMethod}=await import("@agent-anything/agent-runtime/context-representation");
  const load=name=>import(pathToFileURL(join(__dirname,"../../dist/main/context",name)));
  const {bindHelarcNativeContextMethods}=await load("HelarcNativeContextMethods.js"),{HelarcActivityService}=await load("HelarcActivityService.js");
  const ref=id=>({id,revision:"1"}),now=()=>new Date().toISOString(),m=c=>store.materialCustody.command(c),journal=store.protocolJournal;
  const registry=new ActivityPurposeRegistry(),bound=bindHelarcNativeContextMethods({store,registry,model:structured.methodParticipant,now,
    authorize:async p=>{assert.equal(p.intent.permissionBasis,"isolated-tree");return {kind:"allowed"};}}),work=bound.methods;
  let failure;
  const service=new HelarcActivityService({store,purposes:registry,purposeIds:bound.purposeIds,rediscoveryMs:10,reconsideration:bound.reconsideration,
    report:async cycle=>{failure??=cycle.runs.flatMap(r=>r.result.failures)[0]?.error??cycle.failures[0]?.error??cycle.reconsiderations.flatMap(r=>r.result.failures)[0]?.error;}});
  const accept=async(id,scope,actor,parts)=>{const r=await store.sharedAcceptance.accept({id,scope,actor,parts});assert.equal(r.outcome,"accepted",JSON.stringify(r));return r;};
  async function publish(id,text,recipient,source){
    const bytes=Buffer.from(text),range={materialId:id,version:`sha256:${createHash("sha256").update(bytes).digest("hex")}`,coordinate:"bytes",start:0,end:bytes.length};
    await m({kind:"begin",intent:{id:`${id}:capture`,instanceId:id,activityId:source.id,owner:recipient.recipient,maximumBytes:bytes.length,
      version:{ref:{materialId:id,version:range.version},origin:{runId:source.runId,owner:recipient.recipient,recordId:source.id,revision:"1",occurredAt:"2026-11-15T00:00:00Z"},
        label:"Original native result source",format:"utf8",mediaType:"text/plain",bytes:bytes.length,digest:range.version,capture:"complete",limitations:[]}}});
    for(let offset=0;offset<bytes.length;offset+=65536)await m({kind:"append",id:`${id}:${offset}`,intentId:`${id}:capture`,offset,bytesBase64:bytes.subarray(offset,offset+65536).toString("base64")});
    await m({kind:"complete",intentId:`${id}:capture`});
    const hold={id:`${id}:hold`,instanceId:id,consumer:recipient,responsibility:"preparation",range,basis:id,releaseCondition:"explicit responsibility transfer"};
    await accept(`${id}:publish`,source.runId,recipient.recipient,[{owner:"material_custody",kind:"publish",proposal:{intentId:`${id}:capture`,holds:[hold],
      grants:[{id:`${id}:grant`,instanceId:id,recipient,range,revision:0,allowed:true,basis:"isolated-tree"}]}}]);
    return {hold,access:{id:`${id}:access`,holdId:hold.id,recipient,range}};
  }
  const convert=async(arranged,input,context)=>{
    const {activity,prepared}=arranged,deliveries=h.helarcNativeTaskResultDeliveries(prepared,input);
    const result=deliveries.find(d=>d.result.content?.output?.report?.status==="retained_material"||
      typeof d.result.content?.output?.summary==="string"&&d.result.content.output.summary.length>2000);
    if(!result)return arranged;
    const original=result.result,declaration=helarcResultTextDeclaration(original,"original","1");assert(declaration);
    const pathId=`${activity.scope.activityId}:result-conversion`;
    const recipient={runId:input.runId,recipient:"context-representation",purpose:"method"},taskRecipient={runId:input.runId,recipient:input.agent.id,purpose:activity.scope.purpose.id};
    const inputId=`${pathId}:task-input`,scopeId=`${pathId}:scope`,selectionId=`${pathId}:selection`,target=activity.composition.composition.configuration.configuration.id+":"+activity.composition.composition.configuration.configuration.revision;
    const existing=await store.contextSelections.command({kind:"lookup_scope",scopeId});
    if(existing?.selection){
      return {...arranged,prepared:await h.adoptHelarcNativeTaskInput(prepared,input,inputId,store.contextSelections,{materials:store.materialCustody,representations:store.representations,maximumReadBytes:1000000})};
    }
    let source;
    if(declaration.source.kind==="retained_material"){
      const originalAccess=await m({kind:"resolve_reference",reference:declaration.source.reference,recipient:taskRecipient});
      const hold={...originalAccess.hold,id:`${pathId}:source-hold`,consumer:recipient,responsibility:"preparation",basis:pathId};
      await accept(`${pathId}:source-admission`,input.runId,"context-representation",[{owner:"material_custody",kind:"admit_access",proposal:{
        source:{id:`${pathId}:source`,holdId:originalAccess.hold.id,recipient:taskRecipient,range:originalAccess.hold.range},hold,
        grant:{id:`${pathId}:source-grant`,instanceId:hold.instanceId,recipient,range:hold.range,revision:0,allowed:true,basis:"isolated-tree"}}}]);
      source={hold,access:{id:`${pathId}:read`,holdId:hold.id,recipient,range:hold.range}};
    }else source=await publish(`${pathId}:original-body`,readModelResultContentTextSlot(original,declaration.slot),recipient,{id:original.modelCallRef.id,runId:original.content.childRunId});
    if(!await store.activityHandoffs.command({kind:"read_path",pathId})){
      const request={kind:"representation_method",method:"summarize",methodRevision:"1",recipient,objective:"CHILD_BODY_CONVERSION: Preserve result code, uncertainty and source availability.",
        sources:[{alias:"source",role:"source",access:source.access,representation:null,order:0,label:"Original Child report",originalRole:"child_result",indivisibleGroup:original.modelCallRef.id}],
        requirements:declaration.requirements,relationships:[],sourceBoundary:digest(original),deliveryIds:[],combinationDigest:null,combine:"keep",omission:null,search:null,
        nativeComposition:activity.composition,targetRevision:target,
        capacity:{limits:[{id:"body-bytes",targetRevision:target,dimension:"request_bytes",maximum:1000000,source:"controlled transport boundary"}],reservations:[],
          policy:{id:"fixture",revision:"1",purpose:"method",basis:"Exact native bytes, unknown token capacity explicitly allowed",allowEstimatedFit:false,allowUnknown:true},maximumCombinations:4,maximumMeasurements:0},
        bounds:{readBytes:2000000,storedBytes:100000,modelCalls:4,repairs:1,levels:3,pageBytes:8192,ranges:16}};
      const quotation=quoteRepresentationMethod(request),evidence={id:original.modelCallRef.id,revision:"1",owner:"context-representation",kind:"fact"};
      const methodScope={...recipient,id:`${pathId}:investment`,owner:"context-representation",continuity:input.runId,target,authorityBasis:"isolated-tree"};
      await store.contextSelections.command({kind:"scope",scope:methodScope});
      await store.activityHandoffs.command({kind:"bind_resource_pool",pool:{id:"native-method-model",capacity:1,revision:"1",authority:"isolated-tree"}});
      const policy={scope:methodScope,boundary:digest(original),requirementsDigest:digest(declaration.requirements),
        current:{kind:"gap",gap:{reason:"controlled_large_result_conversion",demandId:pathId,targetRevision:target,information:[],capacity:[],untested:false,responsibility:"request_owner"},evidence},
        currentRejectedInputId:null,alternatives:[],pressure:[],inFlight:[],explorationHistory:[],optionalInFlight:0,autoPrepare:true,consumerActive:true,
        options:[{id:pathId,request,quotation,stableScope:evidence,addresses:[evidence.id],entries:quotation.phases.map(p=>({phase:p.kind,state:"supported",evidence})),
          limits:{maximumStages:64,maximumAttempts:64},capability:[],comparisons:[]}]};
      const submission=contextPreparationAcceptance({id:`${pathId}:submitted`,input:policy,expectedDecisionId:null,expectedControlRevision:0,reconsideration:null,methods:work,
        execution:{path:{id:pathId,runId:input.runId,permissionBasis:"isolated-tree",resourceScope:pathId,maximumStages:64,maximumAttempts:64,maximumConcurrent:1,deadlineAt:"2030-01-01T00:00:00Z"},
          workId:pathId,schedulingScopeId:"native-tree",resources:[{capability:"model-access",poolId:"native-method-model",units:1}],timing:{kind:"unknown"}}});
      assert.equal(submission.decision.investment.kind,"propose");
      assert.equal((await store.sharedAcceptance.accept(submission.acceptance)).outcome,"accepted");
    }
    let produced;
    const wake=new ActivityChangeWait({subscribe:listener=>store.onActivityChange(listener)},context.cancellation.signal);
    try{for(;;){
      context.cancellation.signal.throwIfAborted();service.assertAvailable();if(failure)throw failure;
      const version=wake.version;produced=await work.result(pathId);if(produced.kind==="ready")break;
      assert.equal(produced.kind,"pending",JSON.stringify(produced));service.wake();await wake.wait(version,100);
    }}finally{wake.close();}
    assert.equal(produced.kind,"ready");assert.equal(produced.progress.modelCalls,2);
    const candidate=produced.progress.candidates.find(c=>produced.progress.resultIds.includes(c.id)),record=await store.representations.command({kind:"read",ref:candidate.representation});
    const page=await m({kind:"read",access:candidate.access,offset:0,length:Math.min(65536,candidate.access.range.end)});assert(page.text.includes("8422"));
    assert(!await store.contextSelections.command({kind:"current",scopeId}).catch(()=>null),"Auxiliary reading is not Parent acceptance");
    const originalWire=JSON.parse(prepared.wire.body),originalItems=originalWire.input??originalWire.messages;
    const history=await publish(`${pathId}:original-input`,JSON.stringify(originalItems),taskRecipient,{id:prepared.binding.controllerRequestId,runId:input.runId});
    const historyRecord={ref:ref(`${pathId}:original-input`),runId:input.runId,owner:taskRecipient.recipient,purpose:taskRecipient.purpose,target,form:"original",body:history.access.range,
      inputs:[{role:"source",material:history.access.range,representation:null}],declaredCoverage:[history.access.range],details:[history.access.range],holds:[history.hold.id],requirements:[],losses:[],restorations:[],method:null};
    await store.representations.command({kind:"record",record:historyRecord});
    const scope={...taskRecipient,id:scopeId,continuity:input.runId,owner:"context-representation",target,authorityBasis:"isolated-tree"};
    const received=await h.prepareHelarcNativeResultReception({activity,prepared,input,scope,inputId,selectionId,methodPathId:pathId,
      callId:original.modelCallRef.id,candidateId:candidate.id,history:{record:historyRecord,hold:history.hold},sourceHold:source.hold,maximumReadBytes:1000000,
      capacity:{...produced.progress.request.capacity,policy:{...produced.progress.request.capacity.policy,purpose:scope.purpose}},continuity:{kind:"responses",policy:"native_replay",previous:null,
        conditions:{basis:"Original native replay configuration",authorized:true,disclosureRevision:scope.authorityBasis,remoteStorage:false,
          targetSupport:"established",predecessor:"unavailable",reestablish:false,policyChange:false}}},
      {methods:work,materials:store.materialCustody,representations:store.representations},context.cancellation.signal);
    assert.equal(received.kind,"ready");
    const {selected,judgment,proposal}=received,judgmentId=judgment.id;
    await store.contextSelections.command({kind:"scope",scope});await store.representations.command({kind:"judge",judgment});
    const policy={scope,boundary:prepared.sourceDigest,requirementsDigest:digest(declaration.requirements),
      current:{kind:"recipient_prepared",scope,inputId,bodyDigest:received.preparation.encoded.bodyDigest,exactInputDigest:digest(selected),judgmentId,
        allowed:true,risks:["token_capacity_unknown"],capacity:received.capacityEvidence,evidence:{owner:scope.owner,id:judgmentId,revision:"1",kind:"fact"}},
      currentRejectedInputId:null,alternatives:[],pressure:[],options:[],inFlight:[],explorationHistory:[],optionalInFlight:0,autoPrepare:true,consumerActive:true};
    const joint=contextPreparationAdoption({policy:{id:proposal.id,input:policy,expectedDecisionId:null,expectedControlRevision:0,
      reconsideration:null,execution:null,methods:work},checkedInput:proposal});
    for(const field of ["judgmentId","bodyDigest","exactInputDigest"]){
      const changed=structuredClone(joint);changed.id+=`:changed:${field}`;
      changed.parts.find(p=>p.owner==="context_preparation_policy").proposal.input.current[field]="unrelated";
      const rejected=await store.sharedAcceptance.accept(changed);
      assert.equal(rejected.outcome,"rejected",`${field} must refer to the same checked native input`);
      assert.equal(await store.contextSelections.command({kind:"current",scopeId}),null,"Rejected readiness must not partially select input");
    }
    const accepted=await store.sharedAcceptance.accept(joint);assert.equal(accepted.outcome,"accepted",JSON.stringify(accepted));
    assert.equal((await store.contextPolicy.query({kind:"latest",scopeId})).decision.foreground.preparedInputId,inputId);
    assert.equal(await store.activityHandoffs.command({kind:"read_path",pathId:activity.scope.activityId}),null,"No artificial task Stage");
    if(phase==="conversion-selected")await checkpoint("selected native input before native claim; no repeated conversion",activity);
    return {...arranged,prepared:await h.adoptHelarcNativeTaskInput(prepared,input,inputId,store.contextSelections,{materials:store.materialCustody,representations:store.representations,maximumReadBytes:1000000})};
  };
  convert.settled=async pathId=>{
    const wake=new ActivityChangeWait({subscribe:listener=>store.onActivityChange(listener)},new AbortController().signal);
    try{for(;;){const version=wake.version;service.assertAvailable();if(failure)throw failure;
      const scheduled=await store.activityHandoffs.command({kind:"read_schedule",workId:pathId});assert(scheduled);
      if(scheduled.settlementConfirmed)return;
      service.wake();await wake.wait(version,100);
    }}finally{wake.close();}
  };
  convert.close=()=>service.close();return convert;
};
