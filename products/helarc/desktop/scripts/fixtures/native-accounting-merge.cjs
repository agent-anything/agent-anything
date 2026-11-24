const {app}=require("electron");
const assert=require("node:assert/strict");
const {join}=require("node:path");
const {pathToFileURL}=require("node:url");
const {mkdir,readFile,writeFile}=require("node:fs/promises");
const [directory,phase]=process.argv.slice(2);
app.setPath("userData",join(directory,"electron"));app.disableHardwareAcceleration();
let store;
const ref=id=>({id,revision:"1"}),at="2026-11-13T00:00:00.000Z";
async function main(){
  const runtime=await import("@agent-anything/agent-runtime/model-access");
  const model=await import("@agent-anything/model-interaction/protocol");
  const native=await import("@agent-anything/provider-integrations/native");
  const helarc=await import("@agent-anything/helarc/controller");
  const {HelarcExecutionStore}=await import(pathToFileURL(join(__dirname,"../../dist/main/execution-storage/HelarcExecutionStore.js")));
  const {ProtocolJournalInspectionAdapter}=await import(pathToFileURL(join(__dirname,"../../dist/main/inspection/ProtocolJournalInspectionAdapter.js")));
  await mkdir(directory,{recursive:true});
  store=await HelarcExecutionStore.open(join(directory,"execution"),pathToFileURL(join(__dirname,"native-input-accounting-worker.mjs")));
  let bodyReads=0;
  const journal={command:command=>{if(command.kind==="content_read")bodyReads++;return store.protocolJournal.command(command);}};
  const participant=id=>({implementation:ref(id),protocol:model.OPENAI_RESPONSES});
  const composition=model.bindModelAgentComposition({agent:ref("agent"),protocol:model.OPENAI_RESPONSES,
    configuration:{configuration:ref("original-config"),protocol:model.OPENAI_RESPONSES,model:"fixture",connectionBinding:ref("connection")},
    adapter:participant("adapter"),task:{purpose:ref("task"),input:participant("input"),interpreter:participant("task-interpreter")},auxiliary:[]});
  const activity=runtime.bindProtocolModelActivity({composition,scope:{runId:"root",activityId:"a",recipientId:"task",purpose:ref("task"),compositionDigest:composition.digest},
    conditions:{input:ref("input"),authority:ref("authority"),resources:ref("resources"),control:ref("control")}});
  const scope={id:"accounting",runId:"root",recipientId:"task",purpose:ref("task"),compositionDigest:composition.digest,owner:"adapter"};
  const accept=async(id,parts,actor="adapter")=>{
    const receipt=await store.sharedAcceptance.accept({id,scope:"root",actor,parts});assert.equal(receipt.outcome,"accepted",JSON.stringify(receipt));return receipt;
  };
  const jp=(kind,proposal)=>({owner:"protocol_execution",kind,proposal});
  const state=()=>journal.command({kind:"state",activityId:"a"});
  const query={activityId:"a",scopeId:scope.id};
  const evidence=(key,revision)=>journal.command({kind:"evidence",...query,evidenceKind:"usage",key,...revision===undefined?{}:{revision}});
  const retain=(id,value)=>runtime.retainProtocolContent(journal,id,"a",Buffer.from(JSON.stringify(value)));
  const decode=async value=>JSON.parse((await runtime.readProtocolContent(journal,value.content,"a",16*1024*1024)).toString());
  const source=id=>({protocol:model.OPENAI_RESPONSES,scope:activity.scope,interpretation:ref("adapter"),operationId:id,
    record:ref(`observation:${id}`),position:{format:"json-pointer",value:""},nativeIdentity:{kind:"response",id:"same-response"}});
  const base={journal,acceptance:store.sharedAcceptance,scope,cost:null};
  const page=options=>helarc.readHelarcNativeWorkPage({...query,journal,afterKey:null,limit:128,...options});
  if(phase==="merge-seed"){
    const input=await retain("input",{protocol:"openai.responses",model:"fixture",input:[{role:"user",content:"Synthetic accounting recovery only."}]});
    await accept("prepare",[jp("prepare",{activity,input}),jp("evidence_scope",{activityId:"a",scope})],"execution-coordinator");
    await accept("claim:1",[jp("claim",{activityId:"a",expectedEpoch:0})]);
    const fence=(await state()).fence;
    let ledger=native.createNativeAccountingState();
    const originals=[];
    for(const id of ["first","second"]){
      const submission={id,protocol:model.OPENAI_RESPONSES,scope:activity.scope,endpoint:"https://fixture.invalid",account:"synthetic",operation:"generation",
        submittedAt:at,model:"fixture",requestedTier:null,reportedTier:null,region:null,modality:"text",reconciliationOwner:"adapter",beneficiaries:["parent",id],stage:null};
      ledger=native.applyNativeAccountingCommand(ledger,{id:`register:${id}`,kind:"register",submission});
      ledger=native.applyNativeAccountingCommand(ledger,{id:`reserve:${id}`,kind:"reserve",reservation:{id:`reservation:${id}`,submissionId:id,
        resource:"synthetic-budget",amount:"1",unit:"USD",guarantee:"estimate",admissionBasis:ref("budget")}});
      const usage={input_tokens:100,output_tokens:20,total_tokens:120,input_tokens_details:{cached_tokens:0}};
      const raw=await retain(`raw:${id}`,{id:"same-response",usage});
      const dispatch={ref:ref(`dispatch:${id}`),activityId:"a",operationId:id,kind:"dispatch_intent",content:input,source:null,dependencies:[]};
      const observation={ref:ref(`observation:${id}`),activityId:"a",operationId:id,kind:"observation",content:raw,source:source(id),dependencies:[dispatch.ref]};
      await accept(`records:${id}`,[jp("record",{record:dispatch,fence}),jp("record",{record:observation,fence})]);
      ledger=native.applyNativeAccountingCommand(ledger,{id:`usage:${id}`,kind:"observe",observation:{id:`usage:${id}`,submissionId:id,source:source(id),receivedAt:at,
        channel:"get",finality:"terminal",authority:"fixture",revisionDomain:"response",cumulativeRevision:null,
        profile:{kind:"openai.responses",revision:"1",cacheWrites:"not_applicable",basis:ref("usage")},usage}});
      const any={match:"any"};
      const cost=native.calculateNativeCost({work:native.nativeWorkForSubmission(ledger,id),calculation:ref(`price:${id}`),decisionAt:at,
        context:{protocol:model.OPENAI_RESPONSES,endpoint:submission.endpoint,account:"synthetic",operation:"generation",occurredAt:at,model:"fixture",reportedTier:null,region:null,modality:"text",basis:ref("price-context")},
        rates:[{ref:ref(`rate:${id}`),source:"Synthetic fixture, not a provider price",kind:"synthetic",protocol:model.OPENAI_RESPONSES,effectiveFrom:at,effectiveUntil:null,
          endpoint:any,account:any,model:any,reportedTier:any,region:any,modality:any,operation:"generation",inputBand:null,currency:"USD",
          rates:[{component:"input_tokens.ordinary",unit:"tokens",amount:"2",perUnits:"1000000"}]}],additional:[],chargeCoverage:{state:"unknown",basis:ref("price-coverage")}});
      ledger=native.applyNativeAccountingCommand(ledger,{id:`cost:${cost.revision}`,kind:"record_cost",submissionId:id,calculation:cost});
      const args={fence,expectedRevision:null,state:native.nativeAccountingWorkSnapshot(ledger,id),submissionId:id,cost,
        references:[input,raw],dependencies:[{activityId:"a",ref:observation.ref}]};
      originals.push({args,accepted:await helarc.retainHelarcNativeWork({...base,...args})});
    }
    assert.equal((await page()).entries.length,2);
    const before=await page({limit:1});assert(before.next);
    for(const id of ["first","second"])ledger=native.applyNativeAccountingCommand(ledger,{id:`bind:${id}`,kind:"bind_remote",submissionId:id,remote:{kind:"response",id:"same-response"},evidence:source(id)});
    const args={fence,expectedRevision:0,state:ledger,submissionId:"first",cost:null,references:[input],dependencies:[]};
    let acceptedProposal;
    const acceptance={query:id=>store.sharedAcceptance.query(id),accept:async proposal=>{
      const original=proposal.parts[0].proposal;
      assert.equal(proposal.parts[0].kind,"usage_merge");
      const stale={...proposal,id:`${proposal.id}:stale`,parts:[jp("usage_merge",{...original,retired:original.retired.map(item=>({...item,expectedRevision:99}))})]};
      const rejected=await store.sharedAcceptance.accept(stale);assert.equal(rejected.outcome,"rejected");assert.match(rejected.rejection.code,/revision_conflict/);
      assert.equal((await page()).entries.length,2);assert.equal((await page()).version,before.version);
      assert.equal(await journal.command({kind:"usage_retirement",...query,key:original.retired[0].key}),null);
      const receipt=await store.sharedAcceptance.accept(proposal);assert.equal(receipt.outcome,"accepted",JSON.stringify(receipt));
      acceptedProposal=proposal;throw new Error("synthetic_lost_merge_ack");
    }};
    await assert.rejects(()=>helarc.retainHelarcNativeWork({...base,...args,acceptance}),/synthetic_lost_merge_ack/);
    await writeFile(join(directory,"original.json"),JSON.stringify({args,originals,before,acceptedProposal}));
    await writeFile(join(directory,`${phase}.json`),JSON.stringify({phase,pid:process.pid,generation:store.generation,electron:process.versions.electron,atomicRollback:true,lostMergeAck:true}));
    app.exit(73);return new Promise(()=>{});
  }
  assert.equal(phase,"merge-verify");
  const original=JSON.parse(await readFile(join(directory,"original.json"),"utf8"));
  const saved=await state();assert.equal(saved.fence.generation,1);assert.equal(store.generation,2);
  await accept("claim:2",[jp("claim",{activityId:"a",expectedEpoch:saved.fence.epoch})]);
  const fence=(await state()).fence;
  let repeatedAcceptance=0;
  const acknowledgementOnly={query:id=>store.sharedAcceptance.query(id),accept:async()=>{repeatedAcceptance++;throw new Error("Do not repeat accepted reconciliation");}};
  const recovered=await helarc.retainHelarcNativeWork({...base,...original.args,fence,acceptance:acknowledgementOnly});
  assert.equal(repeatedAcceptance,0);assert.equal(recovered.key,original.originals[0].accepted.key);
  const restored=native.restoreNativeAccountingState((await decode(recovered)).state);
  const work=native.nativeWorkForSubmission(restored,"first");
  assert.deepEqual(work.submissionIds,["first","second"]);assert.equal(work.costCalculations.length,2);
  assert.deepEqual(Object.values(restored.reservations).map(value=>value.status),["held","held"]);
  assert.equal(work.contribution.fields.input_tokens.value,100);
  for(const prior of original.originals){
    assert.deepEqual(await evidence(prior.accepted.key,0),prior.accepted);
    const old=await helarc.retainHelarcNativeWork({...base,...prior.args,fence,acceptance:acknowledgementOnly});assert.deepEqual(old,prior.accepted);
  }
  const retired=original.originals[1].accepted;
  const alias=await journal.command({kind:"usage_retirement",...query,key:retired.key});assert(alias);assert.equal(alias.survivor.key,recovered.key);
  const staleCreate=await store.sharedAcceptance.accept({id:"cannot-revive",scope:"root",actor:"adapter",parts:[jp("evidence",{fence,expectedRevision:0,evidence:{...retired,revision:1}})]});
  assert.equal(staleCreate.outcome,"rejected");assert.match(staleCreate.rejection.code,/key_retired/);
  await assert.rejects(()=>page({afterKey:original.before.next,expectedVersion:original.before.version}),/page_version_conflict/);
  bodyReads=0;
  for(let n=0;n<24;n++){const active=await page();assert.equal(active.entries.length,1);assert.equal(active.entries[0].inputTokens,100);assert.equal(active.entries[0].heldReservations,2);}
  assert.equal(bodyReads,0);
  const retry={journal,acceptance:store.sharedAcceptance,scope,kind:"continuation",key:"new-evidence",expectedRevision:null,value:{basis:"fixture-no-dispatch"},references:[],dependencies:[],metadata:{},memberships:[]};
  const attempts=[];
  const recordAttempt={query:id=>store.sharedAcceptance.query(id),accept:proposal=>{attempts.push(proposal);return store.sharedAcceptance.accept(proposal);}};
  await assert.rejects(()=>helarc.retainHelarcNativeEvidence({...retry,fence:original.args.fence,acceptance:recordAttempt}),/fenced/);
  const accepted=await helarc.retainHelarcNativeEvidence({...retry,fence,acceptance:recordAttempt});
  assert.equal(attempts.length,2);assert.notEqual(attempts[0].id,attempts[1].id);assert.equal(accepted.revision,0);
  assert.deepEqual(attempts[0].parts[0].proposal.evidence,attempts[1].parts[0].proposal.evidence);
  const offers=[];
  const inspection=new ProtocolJournalInspectionAdapter({ref:(owner,kind,id,runId,revision)=>({owner,kind,id,runId,revision}),offer:value=>offers.push(value)});
  bodyReads=0;
  await inspection.replay((after,limit)=>journal.command({kind:"facts",runId:"root",after,limit}));
  const mergeOffer=offers.find(value=>value.payload.name==="execution.usage_merge");assert(mergeOffer);
  assert(mergeOffer.links.some(link=>link.to.id===`${scope.id}:usage:${recovered.key}`));
  assert(mergeOffer.links.some(link=>link.from.id===`${scope.id}:usage-retirement:${retired.key}`));
  assert(mergeOffer.links.some(link=>link.from.id===retired.content.id));
  assert(mergeOffer.links.some(link=>link.from.owner==="shared_acceptance"&&link.from.id===alias.acceptanceId));
  assert.equal(bodyReads,0);
  const summary={phase,pid:process.pid,generation:store.generation,electron:process.versions.electron,originalMerge:alias.mergeId,
    lostAckRecoveredUnderNewFence:true,repeatedAcceptance,originalRevisionsPreserved:true,originalCostBases:work.costCalculations.length,
    heldReservations:2,canonicalInputTokens:100,activeContributions:1,retiredCannotRevive:true,mixedPagingRejected:true,
    metadataRefreshes:24,metadataBodyReads:0,inspectorMergeLinked:true,inspectorBodyReads:0,oldFenceRejected:true,newFenceAccepted:true,remoteRequests:0,effects:0};
  await writeFile(join(directory,`${phase}.json`),JSON.stringify(summary,null,2));
}
app.whenReady().then(main).then(async()=>{await store?.close();app.exit(0);}).catch(async error=>{
  await mkdir(directory,{recursive:true});await writeFile(join(directory,`failure-${phase}.txt`),error.stack??String(error));
  try{await store?.close();}finally{app.exit(1);}
});
