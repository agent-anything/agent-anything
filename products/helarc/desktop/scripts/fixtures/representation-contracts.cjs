const assert=require("node:assert/strict");
const {createHash}=require("node:crypto");

exports.verifyContracts=async function({store,work,processor,signal,now,request,initial}) {
  const a=command=>store.activityHandoffs.command(command),m=command=>store.materialCustody.command(command),s=command=>store.contextSelections.command(command);
  const accept=async proposal=>{const result=await store.sharedAcceptance.accept(proposal);assert.equal(result.outcome,"accepted",JSON.stringify(result));};
  const recipient=request.recipient,results={};let calls=0;
  const submit=async(id,override={},limits={})=>{
    const next={...request,deliveryIds:[],...override};
    await work.submit({id,runId:recipient.runId,permissionBasis:"isolated-method-permission",resourceScope:id,maximumStages:128,maximumAttempts:128,maximumConcurrent:1,deadlineAt:"2030-01-01T00:00:00.000Z",...limits},next);
  };
  const finish=async id=>{
    for(let i=0;i<256;i++) {const result=await work.result(id);if(result.kind!=="pending"){if(result.progress)calls+=result.progress.modelCalls;return result;}await processor.drain(recipient.runId,signal);}
    throw new Error(`Unsettled contract fixture: ${id}`);
  };
  const source=request.sources[0],base={sources:[source],requirements:[],relationships:[],bounds:{...request.bounds,modelCalls:0}};
  await submit("preserve",{...base,method:"preserve"});
  const preserved=await finish("preserve");assert.equal(preserved.kind,"ready");assert.deepEqual(preserved.progress.candidates[0].access,source.access);
  assert.equal(preserved.progress.pages.length,0);results.preserveWithoutModel=true;
  await submit("excerpt",{...base,method:"excerpt",sources:[{...source,access:{...source.access,range:{...source.access.range,end:80}}}]});
  const excerpt=await finish("excerpt");assert.equal(excerpt.kind,"ready");
  const er=await store.representations.command({kind:"read",ref:excerpt.progress.candidates[0].representation});assert.equal(er.declaredCoverage[0].end,80);results.exactRange=true;
  await submit("search",{...base,method:"search",search:{query:"Inspection",caseMode:"sensitive",maximumMatches:1}});
  const searched=await finish("search");assert.equal(searched.kind,"ready");
  assert(searched.progress.candidates[0].unknowns.some(u=>u.description.includes("search incomplete")));results.searchCompleteness=true;
  await submit("omit",{...base,method:"omit",omission:{basis:"owner explicitly allows a locator here; not a claim about task adequacy",body:"Prior image-method details retained at the original source."}});
  const omitted=await finish("omit");assert.equal(omitted.kind,"ready");const omittedCandidate=omitted.progress.candidates[0];
  const omittedRecord=await store.representations.command({kind:"read",ref:omittedCandidate.representation});assert.equal(omittedRecord.losses[0].kind,"omitted");
  const artifactSource=(candidate,order)=>({alias:candidate.id,role:"source",access:candidate.access,representation:candidate.representation,order,label:candidate.id,originalRole:"derived_representation",indivisibleGroup:candidate.id});
  await submit("restore",{method:"restore",sources:[...request.sources,artifactSource(omittedCandidate,2)],restorations:[{lossId:omittedRecord.losses[0].id,sourceAlias:source.alias,range:source.access.range,description:"Original radius and alpha method"}]});
  const restored=await finish("restore");assert.equal(restored.kind,"ready",JSON.stringify(restored));
  const restoredRecord=await store.representations.command({kind:"read",ref:restored.progress.candidates[0].representation});
  assert(restoredRecord.losses.some(l=>l.id===omittedRecord.losses[0].id));assert.equal(restoredRecord.restorations[0].lossId,omittedRecord.losses[0].id);results.scopedRestoration=true;

  const initialCandidate=initial.candidates[0],checkSources=[...request.sources,{...artifactSource(initialCandidate,request.sources.length),role:"candidate"}];
  const reuse={method:"check",sources:checkSources,reuseJudgments:initial.assessments[0].judgmentIds,bounds:{...request.bounds,modelCalls:0}};
  await submit("reuse",reuse);const reused=await finish("reuse");assert.equal(reused.kind,"ready",JSON.stringify(reused));assert.equal(reused.progress.modelCalls,0);
  const judgment=await store.representations.command({kind:"read_judgment",id:reused.progress.assessments[0].judgmentIds[0]});assert.equal(judgment.dependencies.reusedJudgment,initial.assessments[0].judgmentIds[0]);results.judgmentReuse=true;
  await submit("reuse-changed",{...reuse,objective:"New objective, not covered by the original judgment"});
  const changed=await finish("reuse-changed");assert.equal(changed.kind,"gap");assert.equal(changed.progress.gap.code,"representation_model_budget_exhausted");results.changedConditionsNotReused=true;

  await submit("fixed-background",{capacity:{...request.capacity,limits:[{id:"tiny",targetRevision:request.targetRevision,dimension:"request_bytes",maximum:100,source:"deliberate no-entry fixture"}]}});
  const noEntry=await finish("fixed-background");assert.equal(noEntry.kind,"gap");assert.equal(noEntry.progress.gap.code,"representation_fixed_background_unavailable");assert.equal(noEntry.progress.modelCalls,0);results.noRecursivePreparation=true;
  const minimum=request.sources.reduce((n,s)=>n+Math.max(1,Math.ceil((s.access.range.end-s.access.range.start)/request.bounds.pageBytes)),0)+10;
  await submit("stage-bound",{objective:"contract fixture: stage budget",bounds:{...request.bounds,repairs:4}},{maximumStages:minimum,maximumAttempts:minimum});
  const bounded=await finish("stage-bound");assert.equal(bounded.kind,"gap");assert.equal(bounded.progress.gap.code,"representation_execution_budget_exhausted");
  assert(!(await a({kind:"pending",runId:recipient.runId,after:0,limit:256})).some(i=>i.pathId==="stage-bound"));results.stageBudgetSettled=true;

  const bytes=Buffer.from([0,255,254,1]),range={materialId:"native",version:"1",coordinate:"bytes",start:0,end:bytes.length};
  await m({kind:"begin",intent:{id:"native-capture",instanceId:"native-instance",activityId:"native-producer",owner:"native-owner",maximumBytes:bytes.length,
    version:{ref:{materialId:range.materialId,version:range.version},origin:{runId:recipient.runId,owner:"native-owner",recordId:"native-record",revision:"1",occurredAt:now()},label:"Opaque native item",format:"opaque",mediaType:"application/octet-stream",bytes:bytes.length,digest:`sha256:${createHash("sha256").update(bytes).digest("hex")}`,capture:"complete",limitations:["No text transformation is supported"]}}});
  await m({kind:"append",id:"native-append",intentId:"native-capture",offset:0,bytesBase64:bytes.toString("base64")});await m({kind:"complete",intentId:"native-capture"});
  const hold={id:"native-hold",instanceId:"native-instance",consumer:recipient,responsibility:"preparation",range,basis:"native-preserve",releaseCondition:"explicit disposal"};
  const grant={id:"native-grant",instanceId:hold.instanceId,recipient,range,revision:0,allowed:true,basis:"fixture authorization"};
  await accept({id:"native-publish",scope:recipient.runId,actor:"native-owner",parts:[{owner:"material_custody",kind:"publish",proposal:{intentId:"native-capture",holds:[hold],grants:[grant]}}]});
  const native={...source,alias:"native",access:{id:"native-access",holdId:hold.id,recipient,range}};
  await submit("native-preserve",{...base,method:"preserve",sources:[native]});assert.equal((await finish("native-preserve")).kind,"ready");results.nativePreserved=true;
  await submit("native-text",{method:"summarize",sources:[native],requirements:[],relationships:[]});
  const unsupported=await finish("native-text");assert.equal(unsupported.kind,"gap");assert.equal(unsupported.progress.gap.code,"representation_text_method_unsupported");assert.equal(unsupported.progress.modelCalls,0);results.unsupportedTextSettled=true;
  await submit("revoked",{...base,method:"preserve",sources:[native]});
  await m({kind:"grant",grant:{...grant,revision:1,allowed:false,basis:"revoked before dispatch"},expectedRevision:0});
  await assert.rejects(()=>processor.drain(recipient.runId,signal),error=>{
    assert(error instanceof AggregateError);
    assert.equal(error.errors.length,1);
    assert.match(String(error.errors[0]),/disclos|grant|permission|unavailable/);
    return true;
  });
  assert.equal((await a({kind:"read_stage",requestId:"revoked:stage:1"})).status,"submitted");await work.cancel("revoked");results.currentPermissionChecked=true;

  // Cancel after actual Provider return, before interpretation: raw survives, no candidate or successor is accepted.
  await submit("cancel-late",{method:"check",sources:checkSources,reuseJudgments:[]});let rawStage;
  for(let i=0;i<128;i++) {
    const pending=await a({kind:"pending",runId:recipient.runId,after:0,limit:256});
    for(const item of pending.filter(p=>p.pathId==="cancel-late")){const stage=await a({kind:"read_stage",requestId:item.requestId});if(stage.request.stageKind==="model"&&stage.status==="raw_result")rawStage=stage;}
    if(rawStage)break;await processor.drain(recipient.runId,signal);
  }
  assert(rawStage);calls++;await work.cancel("cancel-late");await processor.drain(recipient.runId,signal);
  const late=await a({kind:"read_stage",requestId:rawStage.request.id});assert.deepEqual(late.result,rawStage.result);assert.equal(late.receipt,null);assert.equal((await work.result("cancel-late")).kind,"cancelled");
  await work.releaseInputs("cancel-late");results.cancelledRawNotAdopted=true;

  const revokedScope=initial.acceptedInputs[0].scopeId;
  await s({kind:"control",control:{scopeId:revokedScope,revision:1,allowed:false,basis:"completed auxiliary use revoked"},expectedRevision:0});
  await work.releaseInputs("method-path");await work.releaseInputs("method-path");assert.equal(await s({kind:"current",scopeId:revokedScope}),null);results.releaseUsesCurrentControl=true;
  const description=await m({kind:"describe",holdId:initialCandidate.access.holdId,recipient});
  const transferred={...description.hold,id:"transferred-detail",responsibility:"detail",basis:"retained-result",releaseCondition:"recipient explicit release"};
  await work.cancel("method-path");
  const part=await work.prepareResultRetention("method-path",[transferred],[initialCandidate.id],"result retained by recipient");
  await accept({id:"result-transfer",scope:recipient.runId,actor:recipient.recipient,parts:[part]});
  await assert.rejects(()=>m({kind:"describe",holdId:initialCandidate.access.holdId,recipient}));assert(await m({kind:"describe",holdId:transferred.id,recipient}));
  assert(await m({kind:"describe",holdId:"parent-hold-0",recipient:{runId:"parent",recipient:"parent-agent",purpose:"task"}}));results.independentRetention=true;
  return {additionalProviderCalls:calls,results};
};
