const assert=require("node:assert/strict");

exports.verifyRevision=async function({store,work,processor,signal}) {
  const {contextPreparationAcceptance,contextPreparationApplicabilityKey,quoteRepresentationMethod}=await import("@agent-anything/agent-runtime/context-representation");
  const {modelInputValueDigest}=await import("@agent-anything/model-interaction/input");
  const a=command=>store.activityHandoffs.command(command);
  const original=(await store.contextPolicy.investments({scopeId:"normal-policy-scope",afterWorkId:null,limit:64}))[0];
  const scope={...original.input.scope,id:"revision-policy-scope",continuity:"revision-consumer"};
  const scopeInput={...original.input,scope};
  const ref=id=>({owner:"context-representation",kind:"fact",id,revision:"1"});
  const sourcePath=await a({kind:"read_path",pathId:original.investment.pathId});
  const intent={...sourcePath.intent,id:"revision-first",resourceScope:"revision-resource",scheduledWorkId:undefined};
  // Controlled provider returns invalid generated content. Real method interpretation must settle the gap.
  const request={...original.input.options[0].request,objective:"contract fixture: stage budget"};
  const quote=quoteRepresentationMethod(request);
  const option={...original.input.options[0],id:"first-option",request,entries:quote.phases.map(p=>({phase:p.kind,state:"unknown",evidence:ref(`first-entry:${p.kind}`)}))};
  const basis={...scopeInput,options:[option],inFlight:[],explorationHistory:[],optionalInFlight:0};
  let head=await store.contextPolicy.query({kind:"latest",scopeId:scope.id});
  if(!head) {
    await store.contextSelections.command({kind:"scope",scope});
    const proposal=contextPreparationAcceptance({id:"revision-initial",input:basis,expectedDecisionId:null,expectedControlRevision:0,reconsideration:null,methods:work,
      execution:{path:intent,workId:"revision-work",timing:{kind:"unknown"},resources:[{poolId:"helarc:model-execution",capability:"model-access",units:1},{poolId:"helarc:model-execution",capability:"model-measurement",units:1}]}});
    assert.equal((await store.sharedAcceptance.accept(proposal.acceptance)).outcome,"accepted");
    head=await store.contextPolicy.query({kind:"latest",scopeId:scope.id});
  }
  for(let i=0;i<100&&(await work.result("revision-first")).kind==="pending";i++)await processor.drain("parent",signal);
  const first=await a({kind:"read_path",pathId:"revision-first"});
  assert.equal(first.progress.method.state,"gap");assert(first.progress.method.modelCalls>0);
  let before=await a({kind:"resource_allowance",pathId:first.intent.id});
  const schedule=await a({kind:"read_schedule",workId:"revision-work"});
  if(head.investment.pathId==="revision-first") {
    const replacement={...request,method:"preserve",objective:"Retain the complete original version without semantic generation"};
    const quotation=quoteRepresentationMethod(replacement);
    const replaces={workId:"revision-work",pathId:first.intent.id,evidence:ref("generated-content-invalid-preserve-original")};
    const input={...basis,options:[{...option,id:"preserve-original",request:replacement,replaces,
      entries:quotation.phases.map(p=>({phase:p.kind,state:"supported",evidence:ref(`replacement-entry:${p.kind}`)}))}],
      explorationHistory:head.decision.investment.explorationKey?[{key:head.decision.investment.explorationKey,decisionId:head.decision.id}]:[],
      inFlight:[{workId:"revision-work",pathId:first.intent.id,applicabilityKey:contextPreparationApplicabilityKey(basis),producerState:"failed",evidence:ref("actual-method-gap")}]};
    const execution={path:{...first.intent,id:"revision-preserve"},workId:"revision-work",timing:{kind:"unknown"},resources:schedule.intent.resources,original:{path:first,scheduling:schedule}};
    assert.throws(()=>contextPreparationAcceptance({id:"invalid-reset",input,expectedDecisionId:head.decision.id,expectedControlRevision:0,reconsideration:null,methods:work,
      execution:{...execution,path:{...execution.path,resourceScope:"reset-budget"}}}),/cannot_reset_original_work/);
    const proposal=contextPreparationAcceptance({id:"revision-accepted",input,expectedDecisionId:head.decision.id,expectedControlRevision:0,reconsideration:null,methods:work,execution});
    // Simulate a stale professional snapshot: an entrusted dispatch is unresolved after cancellation.
    const firstStage=await a({kind:"read_stage",requestId:"revision-first:stage:1"});
    const requestStage={...firstStage.request,id:"revision-unresolved",dependencies:[],capabilities:[]};
    await a({kind:"submit",request:requestStage});
    await a({kind:"admit",requestId:requestStage.id,expectedControlRevision:first.controlRevision});
    const attempt={id:"revision-unresolved:attempt",requestId:requestStage.id,executor:store.activityJournal.executor,
      inputDigest:modelInputValueDigest(requestStage.input),startedAt:new Date().toISOString()};
    await a({kind:"dispatch",attempt,expectedControlRevision:first.controlRevision});
    await a({kind:"reserve_resources",expectedControlRevision:first.controlRevision,reservation:{id:"revision-known-budget-use",pathId:first.intent.id,
      requestId:requestStage.id,amounts:{modelCalls:before.limits.modelCalls-before.reserved.modelCalls}}});
    before=await a({kind:"resource_allowance",pathId:first.intent.id});
    await a({kind:"cancel",pathId:first.intent.id,expectedControlRevision:first.controlRevision});
    assert.equal((await work.describe(first.intent.id)).state,"unknown");
    const unresolved=await store.sharedAcceptance.accept({...proposal.acceptance,id:"revision-unresolved-rejected"});
    assert.equal(unresolved.outcome,"rejected");assert.equal(unresolved.rejection.code,"investment_predecessor_unsettled");
    assert.equal(await a({kind:"read_path",pathId:"revision-preserve"}),null);
    await a({kind:"save_raw",result:{id:"revision-unresolved:raw",attemptId:attempt.id,completeness:"complete",outcome:"failed",
      value:{code:"controlled_cancel_confirmed"},usage:null,recordedAt:new Date().toISOString()}});
    assert.equal((await work.describe(first.intent.id)).state,"cancelled");
    const costlyRequest={...request,objective:"An explicitly revised semantic attempt with no remaining model allowance"};
    const costlyQuote=quoteRepresentationMethod(costlyRequest);
    const costly=contextPreparationAcceptance({id:"revision-no-model-budget",input:{...input,options:[{...input.options[0],request:costlyRequest,
      entries:costlyQuote.phases.map(p=>({phase:p.kind,state:"supported",evidence:ref(`costly-entry:${p.kind}`)}))}]},
      expectedDecisionId:head.decision.id,expectedControlRevision:0,reconsideration:null,methods:work,execution});
    const insufficient=await store.sharedAcceptance.accept(costly.acceptance);
    assert.equal(insufficient.outcome,"rejected");assert.equal(insufficient.rejection.code,"investment_remaining_resources_insufficient");
    assert.equal(await a({kind:"read_path",pathId:"revision-preserve"}),null);
    const receipt=await store.sharedAcceptance.accept(proposal.acceptance);assert.equal(receipt.outcome,"accepted",JSON.stringify(receipt));
    assert.deepEqual(await store.sharedAcceptance.accept(proposal.acceptance),receipt);
    assert.equal((await a({kind:"read_schedule",workId:"revision-work"})).eligibilitySequence,schedule.eligibilitySequence);
    assert.deepEqual(await a({kind:"resource_allowance",pathId:"revision-preserve"}),before);
  }
  for(let i=0;i<20&&(await work.result("revision-preserve")).kind==="pending";i++)await processor.drain("parent",signal);
  const replacement=await work.result("revision-preserve");assert.equal(replacement.kind,"ready",JSON.stringify(replacement));
  const records=await store.contextPolicy.investments({scopeId:scope.id,afterWorkId:null,limit:64});
  assert.equal(records.length,1);assert.equal(records[0].investment.workId,"revision-work");assert.equal(records[0].investment.previousPathId,"revision-first");
  const allowance=await a({kind:"resource_allowance",pathId:"revision-preserve"});
  assert.equal(allowance.reserved.modelCalls,before.reserved.modelCalls);
  assert.equal((await a({kind:"read_path",pathId:"revision-first"})).cancelled,true);
  return {additionalProviderCalls:first.progress.method.modelCalls,workId:"revision-work",firstPath:first.intent.id,replacementPath:"revision-preserve",reserved:allowance.reserved};
};
