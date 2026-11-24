const assert=require("node:assert/strict");
module.exports=async function({store,h,native,source,original,retained,publications,session,custody,activity,endpoint,at,digest,ref,closeProduction=false}){
  const {join}=require("node:path"),{pathToFileURL}=require("node:url");
  const {ActivityPurposeRegistry,ActivityChangeWait}=await import("@agent-anything/agent-runtime/activity");
  const load=name=>import(pathToFileURL(join(__dirname,"../../dist/main",name)));
  const {bindHelarcNativeContextMethods}=await load("context/HelarcNativeContextMethods.js");
  const {HelarcActivityService}=await load("context/HelarcActivityService.js");
  const {runActivityLifetime}=await load("execution-storage/RunActivityLifetime.js");
  const {contextPreparationAcceptance,decideContextPreparation}=await import("@agent-anything/agent-runtime/context-representation");
  const {retainProtocolContent}=await import("@agent-anything/agent-runtime/model-access");
  const registry=new ActivityPurposeRegistry(),signal=new AbortController().signal;
  const offer=h.supplyHelarcResponsesCompactMethod({native:retained,publications,composition:activity.composition,purpose:source.methodRequest.purpose,
    authorityBasis:source.dependencies.authority,probeRequired:false,addresses:["fixed-history"],limits:{maximumStages:5,maximumAttempts:5},
    bounds:{readBytes:8*1024*1024,storedBytes:8*1024*1024,modelCalls:2,repairs:0,levels:1,pageBytes:65536,ranges:16}},source.groups.length);
  assert.deepEqual(offer.source,source);const pathId=offer.pathId;
  const findings=candidate=>source.duties.map(d=>({id:`synthetic-calibration:${d.id}`,dutyId:d.id,dutyRevision:d.revision,kind:"method_assurance",conclusion:"supported",subject:candidate.digest,
    dependencies:source.dependencies,evidence:["controlled fixture preserves blue"],limitations:["Controlled evidence, not a real model semantic quality claim"]}));
  const bound=bindHelarcNativeContextMethods({store,registry,now:()=>at,
    model:{execute:async()=>{throw new Error("Native compact must not dispatch a text method");},recover:async()=>{throw new Error("Native compact must not recover a text method");}},
    authorize:async path=>{assert.equal(path.intent.permissionBasis,"original-disclosure");return {kind:"allowed"};},
    compact:{probeRequired:false,
    prepareInput:async s=>({allowed:Buffer.byteLength(s.methodRequest.encoded)<8*1024*1024,requestDigest:s.methodRequest.digest,
      basis:"Controlled endpoint accepts the exact bounded compact input; native token capacity remains unmeasured",limitations:["controlled_capacity_not_live_measurement"]}),
    compact:async(s,context)=>{
      let candidate=session.candidate();
      if(!candidate){
        if(context.recover)return null;
        await session.execute({now:Date.now(),authorize:async()=>true,dispatch:retainChunk=>native.dispatchResponsesCompact(s.methodRequest,
          {baseUrl:endpoint,apiKey:"synthetic"},{signal:context.signal,retainChunk})});
        candidate=session.candidate();
      }
      assert(candidate);const terminal=await custody.retainTerminal(session,ref("compact-terminal"));
      const evidence={scope:activity.scope,interpreter:ref("context-representation"),acceptance:ref("compact-accepted"),sources:[terminal.source]};
      const result=await retainProtocolContent(store.protocolJournal,"compact-purpose-result","compact",Buffer.from(JSON.stringify({candidateDigest:candidate.digest,sourceDigest:s.sourceDigest})));
      const accepted=await store.sharedAcceptance.accept({id:"compact-purpose",scope:"root",actor:"context-representation",parts:[{owner:"protocol_execution",kind:"purpose",
        proposal:{fence:custody.custody.fence,acceptance:{evidence,result,effects:[],deliveries:[]}}}]});
      assert.equal(accepted.outcome,"accepted",JSON.stringify(accepted));return {candidate,evidence};
    },
    assess:async(_s,result)=>findings(result.candidate),
    publish:async(s,outcome,assessment)=>{
      const checkedAcceptance={query:id=>store.sharedAcceptance.query(id),accept:async proposal=>{
        const record=proposal.parts.find(p=>p.owner==="representation").proposal;
        if(!await store.representations.command({kind:"read",ref:record.ref}))for(const field of ["rawRevision","acceptanceRevision"]){
          const invalid=structuredClone(proposal);invalid.id+=`:invalid:${field}`;
          invalid.parts.find(p=>p.owner==="representation").proposal.method.protocolConfirmation[field]="wrong";
          assert.equal((await store.sharedAcceptance.accept(invalid)).outcome,"rejected");
          const publication=proposal.parts.find(p=>p.owner==="material_custody"&&p.kind==="publish");
          assert.notEqual((await store.materialCustody.command({kind:"state",intentId:publication.proposal.intentId})).state,"published");
          for(const admission of proposal.parts.filter(p=>p.owner==="material_custody"&&p.kind==="admit_access"))
            await assert.rejects(()=>store.materialCustody.command({kind:"describe",holdId:admission.proposal.hold.id,recipient:admission.proposal.hold.consumer}),/material_unavailable/);
        }
        return store.sharedAcceptance.accept(proposal);
      }};
      const publication=await h.retainHelarcResponsesCompactMaterial({materials:store.materialCustody,representations:store.representations,acceptance:checkedAcceptance,
        source:s,candidate:outcome.candidate,owner:"context-representation",purpose:"task",activityId:"compact",observationId:"compact-terminal",occurredAt:at,
        sources:[original],sourceAdmissions:require("./native-compact-material-admissions.cjs")({source:s,sources:[original],owner:"context-representation",purpose:"task",digest}),
        confirmation:{rawRevision:"1",acceptanceId:"compact-accepted",acceptanceRevision:"1"}});
      const judgment=await h.retainHelarcResponsesCompactAssessment({catalog:store.representations,assessment,record:publication.record,observationId:"compact-terminal"});
      return {representation:publication.record.ref,judgmentId:judgment.id};
    }}}),work=bound.compact;
  const lifetime=runActivityLifetime("root");
  await store.activityHandoffs.command({kind:"register_fact_source",source:lifetime.source});
  if(!await store.activityHandoffs.command({kind:"read_path",pathId})){
    const evidence={id:"fixed-history",revision:"1",owner:"context-representation",kind:"fact"};
    const scope={id:retained.manifest.scope.id,runId:"root",recipient:"task",purpose:"task",owner:"context-representation",continuity:"task",target:source.dependencies.target,authorityBasis:"original-disclosure"};
    await store.contextSelections.command({kind:"scope",scope});
    await store.activityHandoffs.command({kind:"bind_resource_pool",pool:{id:"compact-model-pool",capacity:1,revision:"1",authority:"fixture"}});
    const input={scope,boundary:retained.manifest.selection.boundary,requirementsDigest:digest(h.helarcNativeInputRequirements(retained.workingSources.groups)),
      current:{kind:"gap",gap:{reason:"controlled_input_needs_compact",demandId:"task-input",targetRevision:scope.target,information:[],capacity:[],untested:false,responsibility:"request_owner"},evidence},
      currentRejectedInputId:null,alternatives:[],pressure:[],inFlight:[],explorationHistory:[],optionalInFlight:0,autoPrepare:true,consumerActive:true,
      options:[offer.option]};
    const arrangement={path:{id:pathId,runId:"root",permissionBasis:"original-disclosure",resourceScope:pathId,maximumStages:5,maximumAttempts:5,maximumConcurrent:1,deadlineAt:"2030-01-01T00:00:00Z"},
      workId:pathId,schedulingScopeId:"compact-tree",resources:[{capability:"model-access",poolId:"compact-model-pool",units:1}],timing:{kind:"unknown"},
      materialAdmissions:offer.materialAdmissions};
    const decision=decideContextPreparation(input);assert.equal(decision.investment.kind,"propose",JSON.stringify(decision));
    const proposal=contextPreparationAcceptance({id:"compact-investment",input,expectedDecisionId:null,expectedControlRevision:0,reconsideration:null,execution:arrangement,methods:bound.preparationMethods});
    assert.equal(proposal.decision.investment.kind,"propose");
    const invalid=structuredClone(proposal.acceptance);invalid.id+="-wrong-owner";
    const path=invalid.parts.find(p=>p.owner==="activity"&&p.kind==="path_opening").proposal;
    path.purpose.contract.executionOwner="text-summary";path.purpose.digest=digest(path.purpose.contract);
    assert.equal((await store.sharedAcceptance.accept(invalid)).outcome,"rejected");
    assert.equal(await store.activityHandoffs.command({kind:"read_path",pathId}),null);
    assert.equal((await store.sharedAcceptance.accept(proposal.acceptance)).outcome,"accepted");
  }
  let failure;
  const service=new HelarcActivityService({store,purposes:registry,purposeIds:bound.purposeIds,reconsideration:bound.reconsideration,rediscoveryMs:10,
    report:async cycle=>{failure??=cycle.runs.flatMap(r=>r.result.failures)[0]?.error??cycle.failures[0]?.error??cycle.reconsiderations.flatMap(r=>r.result.failures)[0]?.error;}});
  const wake=new ActivityChangeWait({subscribe:listener=>store.onActivityChange(listener)},signal);
  try{for(;;){
    service.assertAvailable();if(failure)throw failure;const version=wake.version;
    const result=await work.result(pathId);
    if(result?.state==="ready"){
      assert(result.assessment.quality.allowed);assert.equal(result.compact.candidate.digest,session.candidate().digest);
      const description=await bound.preparationMethods.describe(pathId);
      assert.equal(description.state,"ready");assert.equal(description.used.stages,5);assert.equal(description.used.attempts,5);
      assert.equal(description.used.modelCalls,null);assert.equal(description.used.readBytes,null);assert.equal(description.used.storedBytes,null);
      assert.equal(description.allowance.reserved.modelCalls,1);assert.equal(description.remaining.modelCalls,1);
      const path=await store.activityHandoffs.command({kind:"read_path",pathId});assert.equal(path.dispatchedAttempts,5);
      assert.equal((await store.contextPolicy.query({kind:"latest",scopeId:retained.manifest.scope.id})).investment.pathId,pathId);
      if(closeProduction){
      await store.activityHandoffs.command({kind:"publish_fact",fact:{id:lifetime.closedFactId,sourceId:lifetime.source.id,
        ref:{owner:lifetime.source.owner,kind:"run_scope_closed",id:"root",revision:"controlled-terminal"}}});
      for(;;){
        service.assertAvailable();if(failure)throw failure;const cursor=wake.version;
        const scheduled=await store.activityHandoffs.command({kind:"read_schedule",workId:pathId});
        if(scheduled.settlementConfirmed)break;
        service.wake();await wake.wait(cursor,100);
      }
      assert.equal((await work.result(pathId)).state,"ready","Closing production must not erase its retained result");
      assert.equal((await bound.preparationMethods.describe(pathId)).state,"ready");
      assert.equal((await store.activityHandoffs.command({kind:"read_path",pathId})).cancelled,false);
      }else assert.equal((await store.activityHandoffs.command({kind:"read_schedule",workId:pathId})).settlementConfirmed,false,
        "Producing a candidate does not close its Run lifetime");
      return {result,methods:work,pathId,registry,bound};
    }
    assert(result===null||result.state==="working",JSON.stringify(result));
    service.wake();await wake.wait(version,100);
  }}finally{wake.close();await service.close();}
};
