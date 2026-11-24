const assert=require("node:assert/strict");
module.exports=async function({store,h,retained,at}){
  const {ActivityPurposeRegistry,ActivityHandoffProcessor}=await import("@agent-anything/agent-runtime/activity");
  const {SourceMaterialPublicationWork}=await import("@agent-anything/agent-runtime/context-representation");
  const registry=new ActivityPurposeRegistry(),signal=new AbortController().signal,now=()=>at;
  const work=new SourceMaterialPublicationWork(store.activityHandoffs,registry,{materials:store.materialCustody,authorize:async()=>({kind:"allowed"}),now});
  const processor=new ActivityHandoffProcessor(store.activityHandoffs,registry,store.activityJournal.executor,now),s=retained.manifest.scope;
  const plan=()=>h.planHelarcNativeSourcePublications({items:retained.manifest.groups.flatMap(g=>g.items),sources:retained.workingSources,
    recipient:{runId:s.runId,recipient:s.recipientId,purpose:s.purpose.id},target:retained.manifest.target.configuration,observedAt:at,
    maximumSourceBytes:8*1024*1024,activities:store.activityHandoffs,signal});
  for(const p of await plan())if(p.state==="new"){
    const r=await store.sharedAcceptance.accept({id:`${p.pathId}:start`,scope:s.runId,actor:"material-source",parts:work.prepareSubmission({
      id:p.pathId,runId:s.runId,permissionBasis:retained.manifest.target.disclosure,resourceScope:p.pathId,maximumStages:1,maximumAttempts:1,
      maximumConcurrent:1,deadlineAt:"2030-01-01T00:00:00Z"},p.request)});
    assert.equal(r.outcome,"accepted",JSON.stringify(r));
  }
  let publications;
  for(let n=0;n<8;n++){
    publications=await plan();if(publications.every(p=>p.state==="published"))break;
    const cycle=await processor.drain(s.runId,signal);assert.equal(cycle.failures.length,0,JSON.stringify(cycle.failures));
  }
  assert(publications.every(p=>p.state==="published"));
  const originals=[];
  for(const p of publications){
    const stage=await store.activityHandoffs.command({kind:"read_stage",requestId:`${p.pathId}:capture`});
    assert.equal(stage.attemptCount,1,"Source capture must not repeat");
    const access=p.published.access,description=await store.materialCustody.command({kind:"describe",holdId:access.holdId,recipient:access.recipient});
    originals.push({record:p.published.representation,holds:[description.hold],grant:{id:`${p.request.intent.id}:grant:1`,instanceId:p.request.intent.instanceId,
      recipient:access.recipient,range:access.range,revision:0,allowed:true,basis:p.pathId}});
  }
  return {publications,originals};
};
