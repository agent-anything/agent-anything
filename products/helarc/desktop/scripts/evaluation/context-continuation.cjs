async function facilities(ctx){
  if(ctx.facilities)return ctx.facilities;
  const {ContextInputPreparationWork,ContextInputMaterializationWork,PreparedInputExecution}=await import("@agent-anything/agent-runtime/context-representation");
  const preparation=new ContextInputPreparationWork(ctx.store.activityHandoffs,ctx.registry,{provider:ctx.provider,materials:ctx.store.materialCustody,now:ctx.now,authorize:ctx.authorize});
  const materialization=new ContextInputMaterializationWork(ctx.store.activityHandoffs,ctx.registry,{materials:ctx.store.materialCustody,preparation,authorize:ctx.authorize,now:ctx.now});
  const purpose=ctx.registry.register({ref:{id:"evaluation.fixed-continuation",revision:"1"},inputOwner:"context-representation",executionOwner:"model-access",interpretationOwner:"fixed-continuation",
    acceptanceOwner:"context-representation",recoveryOwner:"fixed-continuation",stageKinds:["model"],capabilities:["model-access"],continuationKinds:[]},
    new PreparedInputExecution({provider:ctx.provider,selections:ctx.store.contextSelections,inputId:stage=>`${stage.request.pathId}:input`,now:ctx.now,authorize:ctx.authorize,
      interpret:async(_path,stage)=>({progress:{responseId:stage.result.id,outcome:stage.result.value.kind},next:[],participants:[]})}));
  return ctx.facilities={preparation,materialization,purpose};
}
async function until(ctx,read){
  for(let n=0;n<1024;n++){ctx.signal.throwIfAborted();const result=await read();if(result)return result;await ctx.processor.drain(ctx.runId,ctx.signal);}
  throw new Error("Declared continuation work bound exhausted");
}
async function prepare(ctx,id,prompt,candidates=[]){
  const {composeModelInput,organizeOriginalInput,modelInputValueDigest:digest}=await import("@agent-anything/model-interaction/input");
  const f=await facilities(ctx),a=command=>ctx.store.activityHandoffs.command(command);
  const reference={owner:"case-author",kind:"task",id:`${id}:objective`,revision:"1"};
  const lineage={...ctx.lineage,auxiliary:null};
  for(const key of ["instructionBinding","agent","instructions","instructionRelease","instructionResolver","instructionContent","activeContext","contextProjection","projectionManifest","toolSelection","toolExposureContent","toolExposureBasis","toolExposureProof","toolGuidance","controllerControlGuidance","callableDefinitions","protocol","policy"])lineage[key]=reference;
  const composition=composeModelInput({id:`${id}:composition`,providerId:ctx.provider.descriptor.id,model:ctx.provider.modelContext.target.model,interaction:{kind:"text_generation"},lineage,
    composedAt:ctx.projection.input.createdAt,sections:[{id:"objective",source:reference,kind:"task",role:"user",necessity:"mandatory",content:{kind:"text",text:prompt}}]});
  const template={...ctx.template,requestId:composition.id,composition,instructions:composition.instructions,messages:composition.messages,interaction:composition.interaction};
  let demand=organizeOriginalInput({demand:{id:`${id}:demand`,runId:ctx.runId,recipient:ctx.recipient.recipient,purpose:ctx.recipient.purpose,targetRevision:ctx.target,
    historyBoundary:ctx.base.sourceBoundary,deliveryIds:[],dependencies:{source:ctx.base.sourceBoundary},maximumCombinations:8,maximumExternalMeasurements:0,maximumReadBytes:2000000},composition,
    groups:[{id:"objective",owner:"case-author",revision:"1",sectionIds:["objective"],duties:["objective"],deliveryIds:[]}]});
  if(candidates.length)demand={...demand,contributions:[...demand.contributions,...candidates.map((candidate,index)=>({id:`evidence-${index}`,owner:"context-representation",sourceRevision:candidate.representation.revision,deliveryIds:[],currentOptionId:"selected",
    localBudget:{dimension:"input_tokens",grant:null,ceiling:null},options:[{id:"selected",revision:"1",sections:[{position:index+1,section:{id:`evidence-${index}`,source:{owner:"context-representation",kind:"representation",...candidate.representation},
      kind:"evidence",role:"user",necessity:"mandatory",content:{kind:"retained_text",access:candidate.access,prefix:"Retained evidence; source versions remain available.\n",suffix:""}}}],
      duties:["evidence"],requirements:[],findings:[],requires:[],excludes:[],preference:0,estimatedCost:null,omissionBasis:null}]}))]};
  if(!(await a({kind:"read_path",pathId:`${id}:materialization`})))await ctx.accept({id:`${id}:materialization-start`,scope:ctx.runId,actor:"context-representation",parts:f.materialization.prepareSubmission(ctx.intent(`${id}:materialization`),{kind:"context_input_materialization",demand,pageBytes:65536,
    preparationIntent:ctx.intent(`${id}:preparation`),preparation:{kind:"context_input_preparation",template,limits:[],reservations:[],policy:ctx.base.capacity.policy,allowExternalMeasurement:false,
      deliveryMode:"buffered",localMeasurements:[],sharedCapacity:null,materialAccesses:candidates.length?[...candidates.map(c=>c.access),...ctx.base.sources.map(s=>s.access)]:[]}})});
  const materialized=await until(ctx,async()=>{const result=await f.materialization.result(`${id}:materialization`);return result.kind==="pending"?null:result;});
  if(materialized.kind!=="organized")return {kind:"input_unavailable",detail:materialized};
  const result=await until(ctx,async()=>{const r=await f.preparation.result(`${id}:preparation`);return r.kind==="pending"?null:r;});
  if(result.kind!=="prepared")return {kind:"input_unavailable",detail:result};
  const scope={...ctx.recipient,id:`${id}:scope`,continuity:`${id}:continuity`,owner:"context-representation",target:ctx.target,authorityBasis:ctx.projection.branch.authorityId};
  await ctx.store.contextSelections.command({kind:"scope",scope});
  return {kind:"prepared",prepared:result.prepared,scope,digest};
}
async function execute(ctx,id,input,candidates,check){
  const {contextInputAcceptance}=await import("@agent-anything/agent-runtime/context-representation");
  const f=await facilities(ctx),a=command=>ctx.store.activityHandoffs.command(command),c=command=>ctx.store.materialCustody.command(command),s=command=>ctx.store.contextSelections.command(command);
  const ranges=[];
  for(const candidate of candidates){
    const record=await ctx.store.representations.command({kind:"read",ref:candidate.representation});
    const access=[...candidates.map(c=>c.access),...ctx.base.sources.map(s=>s.access)];
    for(const range of [record.body,...record.details,...record.inputs.map(i=>i.material)]){
      if(ranges.some(r=>input.digest(r.range)===input.digest(range)))continue;
      const source=access.find(s=>s.range.materialId===range.materialId&&s.range.version===range.version&&s.range.start<=range.start&&s.range.end>=range.end);
      if(!source)throw new Error("Candidate dependency has no retained authority");
      const descriptor=await c({kind:"describe",holdId:source.holdId,recipient:ctx.recipient});ranges.push({range,instanceId:descriptor.hold.instanceId});
    }
  }
  const holds=responsibility=>ranges.map((r,i)=>({...r,id:`${id}:${responsibility}:${i}`,consumer:ctx.recipient,responsibility,basis:`${id}:${responsibility}`,releaseCondition:"accepted continuation response"}));
  if(!(await a({kind:"read_path",pathId:id})))await a({kind:"open_path",intent:{...await ctx.schedule(id,"task"),owner:f.purpose.contract.acceptanceOwner,purpose:f.purpose}});
  if(!(await ctx.store.querySharedAcceptance(`${id}:adopt`))){
    const args={id:`${id}:adopt`,scope:input.scope,expectedSelectionId:null,expectedControlRevision:0,selection:{id:`${id}:selection`,representations:candidates.map(c=>c.representation),
      judgmentIds:check?check.progress.assessments.at(-1).judgmentIds:[`${id}:original-structure`],holds:holds("selection")},retainedSelectionId:null,prepared:input.prepared,inputId:`${id}:input`,activityId:id,
      stageRequestId:`${id}:model`,stageKind:"model",capabilities:["model-access"],inputHolds:holds("input"),releaseHolds:[]};
    if(check)await ctx.accept(await ctx.work.prepareAdoption(`${id}:check`,args));
    else {
      const judgment={id:`${id}:original-structure`,owner:input.scope.owner,runId:ctx.runId,evidenceSources:[],kind:"combination",subjects:candidates.map(c=>c.representation),inputs:ranges.map(r=>r.range),purpose:ctx.recipient.purpose,target:ctx.target,
        methodRevision:"original-identity:1",dependencies:{inputDigest:input.digest(input.prepared)},coverage:[],conclusion:"supported",limitations:["Original prompt identity only; no semantic preservation assessment"],basis:"Original declared foreground prompt, no transformed content"};
      await ctx.store.representations.command({kind:"judge",judgment});await ctx.accept(contextInputAcceptance({...args,judgment}));
    }
  }
  const stage=await until(ctx,async()=>{const value=await a({kind:"read_stage",requestId:`${id}:model`});return value.status==="accepted"?value:null;});
  await s({kind:"retire_input",inputId:`${id}:input`,basis:"continuation response accepted"});
  for(const hold of holds("input"))await c({kind:"release",holdId:hold.id,basis:"continuation response accepted"});
  const workId=`${id}:scheduled-work`,scheduled=await a({kind:"read_schedule",workId});
  if(scheduled&&!scheduled.closed){await a({kind:"seal_scheduled_paths",workId,expectedRevision:scheduled.revision,basis:"continuation settled"});
    const current=await a({kind:"read_schedule",workId});await a({kind:"close_scheduled_work",workId,expectedRevision:current.revision,basis:"continuation settled",requireSettled:true});}
  return {kind:stage.result.value.kind==="succeeded"?"used":"use_failed",response:stage.result.value.response??null,rawResultId:stage.result.id,stageId:stage.request.id,
    preparedInput:input.prepared,selection:await s({kind:"binding",inputId:`${id}:input`,checkCurrentControl:false})};
}
exports.consumeCandidate=async function(ctx){
  const id="subsequent",a=command=>ctx.store.activityHandoffs.command(command);
  const input=await prepare(ctx,id,ctx.prompt,ctx.candidates);if(input.kind!=="prepared")return input;
  if(!(await a({kind:"read_path",pathId:`${id}:check`})))await ctx.work.submit(ctx.intent(`${id}:check`),{...ctx.base,method:"check_combination",combine:"keep",bounds:{...ctx.base.bounds,repairs:0},
    sources:[...ctx.base.sources,...ctx.candidates.map((candidate,index)=>({alias:`selected-candidate-${index}`,role:"candidate",access:candidate.access,representation:candidate.representation,order:ctx.base.sources.length+index,
      label:"Selected candidate",originalRole:"derived_representation",indivisibleGroup:`selected-candidate-${index}`}))],combinationDigest:input.digest(input.prepared),
    combination:{prepared:input.prepared,scope:input.scope,subjects:ctx.candidates.map(c=>c.representation)}});
  const check=await until(ctx,async()=>{const value=await ctx.work.result(`${id}:check`);return value.kind==="pending"?null:value;});
  if(check.kind!=="ready")return {kind:"adoption_unavailable",check};
  return execute(ctx,id,input,ctx.candidates,check);
};
exports.foregroundEvent=async function(ctx){
  const prompt="FOREGROUND_READY: acknowledge readiness for a later question; reply Ready.";
  const source=await ctx.publish("foreground-prompt",prompt,"source",{id:"foreground-prompt-representation",revision:"1"});
  await ctx.store.representations.command({kind:"record",record:{ref:source.representation,owner:ctx.recipient.recipient,runId:ctx.runId,purpose:ctx.recipient.purpose,target:ctx.target,form:"original",body:source.access.range,
    inputs:[{role:"source",material:source.access.range,representation:null}],declaredCoverage:[source.access.range],details:[],holds:[source.access.holdId],requirements:[],losses:[],restorations:[],method:null}});
  const input=await prepare(ctx,"foreground",prompt);
  if(input.kind!=="prepared")throw new Error("Foreground input unavailable");
  const result=await execute(ctx,"foreground",input,[{representation:source.representation,access:source.access}],null);
  if(result.kind!=="used")throw new Error("Foreground response unavailable");
  return {owner:"fixed-continuation",fact:"foreground_response_accepted",subject:ctx.runId,evidence:{id:result.rawResultId,revision:"1"}};
};
