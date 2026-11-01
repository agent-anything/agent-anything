const {app}=require("electron");
const assert=require("node:assert/strict");
const {join}=require("node:path");
const {pathToFileURL}=require("node:url");
const {createHash}=require("node:crypto");
const {writeFile}=require("node:fs/promises");
const [directory,phase,endpoint]=process.argv.slice(2);
app.setPath("userData",join(directory,"electron"));app.disableHardwareAcceleration();
let store,service,inspection,queries,finished=false;
async function main() {
  await app.whenReady();
  const load=path=>import(pathToFileURL(join(__dirname,"../../dist/main",path)));
  const {HelarcExecutionStore}=await load("execution-storage/HelarcExecutionStore.js");
  const {HelarcActivityService}=await load("context/HelarcActivityService.js");
  const {ActivityPurposeRegistry}=await import("@agent-anything/agent-runtime/activity");
  const {SourceMaterialPublicationWork}=await import("@agent-anything/agent-runtime/context-representation");
  store=await HelarcExecutionStore.open(join(directory,"execution"));
  const registry=new ActivityPurposeRegistry();
  const work=new SourceMaterialPublicationWork(store.activityHandoffs,registry,{materials:store.materialCustody,now:()=>new Date().toISOString(),
    authorize:async(_path,_stage,_signal,action)=>{if(phase!=="save-raw")assert.equal(action,"interpretation");return {kind:"allowed"};}});
  if(phase==="save-raw") {
    await store.activityHandoffs.command({kind:"bind_resource_pool",pool:{id:"local",revision:"1",authority:"fixture",capacity:1}});
    const original=await(await fetch(endpoint,{method:"POST",body:JSON.stringify({source:"original completed effect"})})).json();
    const bytes=Buffer.from(JSON.stringify(original)),digest=`sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    const parts=work.prepareIndependentSubmission({id:"publication",runId:"root",permissionBasis:"fixture-grant",resourceScope:"source",scheduledWorkId:"source-work",maximumStages:1,maximumAttempts:1,maximumConcurrent:1,deadlineAt:"2030-01-01T00:00:00Z"},
      {kind:"source_material_publication",bytesBase64:bytes.toString("base64"),purpose:"task",target:"fixed-target",recipient:{runId:"root",recipient:"root-agent",purpose:"task"},
        intent:{id:"custody",instanceId:"instance",activityId:"publication",owner:"material-source",maximumBytes:bytes.length,
          version:{ref:{materialId:"original-effect",version:digest},origin:{runId:"root",owner:"fixture-source",recordId:"effect:1",revision:"1",occurredAt:new Date().toISOString()},
            label:"Original completed effect",format:"json",mediaType:"application/json",bytes:bytes.length,digest,capture:"complete",limitations:[]}}},
      {id:"source-scheduling",workId:"source-work",runId:"root",owner:"material-source",scopeId:"source-tree",decisionId:"original-source",
        policyRevision:"fixture:1",reason:"necessary",delayImpact:"Original publication",timing:{kind:"unknown"},allowedPathIds:["publication"],
        resources:[{capability:"material-write",poolId:"local",units:1}]});
    const accepted=await store.sharedAcceptance.accept({id:"publish-source",scope:"root",actor:"material-source",parts});
    assert.equal(accepted.outcome,"accepted",JSON.stringify(accepted));
  }
  const purposes={resolve(binding,scope) {
    const handler=registry.resolve(binding,scope);
    if(phase!=="save-raw")return handler;
    return {authorize:handler.authorize.bind(handler),execute:handler.execute.bind(handler),reconcile:handler.reconcile.bind(handler),settle:handler.settle.bind(handler),
      interpret:async()=>{app.exit(73);return new Promise(()=>{});}};
  }};
  service=new HelarcActivityService({store,purposes,purposeIds:[work.purpose.contract.ref.id],rediscoveryMs:10,
    reconsideration:phase==="finish"?()=>work.lifecycle:undefined,
    report:async cycle=>{
      assert.deepEqual(cycle.failures,[]);for(const run of cycle.runs)assert.deepEqual(run.result.failures,[]);
      for(const run of cycle.reconsiderations){assert.deepEqual(run.result.failures,[]);assert.deepEqual(run.result.rejected,[]);}
      if(phase==="save-raw"||finished)return;
      const result=await work.result("publication");if(!result)return;
      const scheduling=await store.activityHandoffs.command({kind:"read_schedule",workId:"source-work"});
      if(phase==="finish"&&!scheduling.settlementConfirmed)return;
      finished=true;
      const path=await store.activityHandoffs.command({kind:"read_path",pathId:"publication"});
      assert.equal(path.progressRevision,1);assert.equal(path.dispatchedAttempts,1);
      const page=await store.materialCustody.command({kind:"read",access:result.access,offset:0,length:65536});
      assert.equal(JSON.parse(page.text).call,1);
      assert.equal(result.representation.form,"original");
      const deliveries=await store.contextSelections.command({kind:"pending_deliveries",recipient:result.access.recipient,after:0,through:null,limit:10});
      assert.deepEqual(deliveries.entries,[]);
      if(phase==="accept-and-expand"){assert(!scheduling.closed);app.exit(73);return;}
      assert(scheduling.closed&&scheduling.pathsSealed&&scheduling.settlementConfirmed);
      const subscription=await store.activityHandoffs.command({kind:"read_reconsideration",subscriptionId:"publication:source-lifecycle",limit:1});assert(subscription.state.closed);
      const {HelarcInspection}=await load("inspection/HelarcInspection.js");
      inspection=await HelarcInspection.create(join(directory,"settings.json"),join(directory,"inspection"));
      await inspection.activityObserver.replay("root",store.activityHandoffs);
      const {InspectionQueryService}=await import("@agent-anything/inspection/query");queries=new InspectionQueryService(join(directory,"inspection"));
      const {selection}=await require("./inspection-settlement.cjs").settleInspection(inspection.recorder,queries);
      const health=inspection.recorder.health();assert.equal(health.dropped,0);assert.equal(health.rejected,0);
      const facts=await store.activityHandoffs.command({kind:"facts",runId:"root",after:0,limit:64});
      assert.equal(facts.filter(f=>f.kind==="dispatched").length,1);
      const closure=facts.find(f=>f.kind==="reconsideration_accepted"&&f.details.receipt.close).details.receipt;
      const subject=inspection.recorder.ref("material-source","contribution","publication","root",closure.decision.revision);
      const detail=await queries.query({kind:"get_subject",...selection,subject});
      assert(detail.records.some(r=>r.payload.executionKind==="source_publication_lifecycle"&&r.payload.status==="closed"));
      const execution=await queries.query({kind:"get_execution",...selection,subject});
      assert(execution.graph.links.some(l=>l.kind==="settles"&&l.from.owner==="shared_acceptance"&&l.from.id===closure.id));
      const data=await queries.query({kind:"get_data_flow",...selection,subject});assert(!data.graph.links.some(l=>l.kind==="delivers"));
      const capture=await queries.query({kind:"get_execution",...selection,subject:inspection.recorder.ref("activity","contribution","publication:capture","root")});
      assert(capture.graph.links.some(l=>l.kind==="binding"&&l.to.owner==="activity-scheduling"&&l.to.id==="source-work"));
      await writeFile(join(directory,"verification.json"),JSON.stringify({electron:process.versions.electron,node:process.versions.node,
        storageGeneration:store.generation,sourceEffects:1,captures:1,publications:1,deliveryReceipts:0,
        recovery:"captured raw -> original publication -> independent source closure",hostService:true,sourceLifecycleClosed:true,
        retainedMaterialReadable:true,sourceClosureRecorded:true,inspection:health},null,2));
      setImmediate(async()=>{await service.close();await inspection.close();await queries.close();await store.close();store=null;app.exit(0);});
    }});
}
main().catch(async error=>{console.error(error);if(service)await service.close(100);if(inspection)await inspection.close();if(queries)await queries.close();if(store)await store.close().catch(()=>{});app.exit(1);});
