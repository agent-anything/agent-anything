module.exports=async function reportService(store,load,agentForRun,purpose,shared){
  const {ActivityPurposeRegistry}=await import("@agent-anything/agent-runtime/activity");
  const {SourceMaterialPublicationWork}=await import("@agent-anything/agent-runtime/context-representation");
  const {HelarcActivityService}=await load("context/HelarcActivityService.js");
  const {createHelarcReportMaterialHandoff}=await load("context/HelarcReportMaterialHandoff.js");
  const {HelarcNativeReportDelivery}=await load("context/HelarcNativeReportDelivery.js"),deliveries=new HelarcNativeReportDelivery(store);
  const registry=shared?.registry??new ActivityPurposeRegistry();
  const publications=new SourceMaterialPublicationWork(store.activityHandoffs,registry,{materials:store.materialCustody,selections:store.contextSelections,
    authorize:async path=>{if(path.intent.permissionBasis!=="isolated-tree")throw new Error("Unexpected publication authority");return {kind:"allowed"};},now:()=>new Date().toISOString()});
  await store.activityHandoffs.command({kind:"bind_resource_pool",pool:{id:"report-local",capacity:2,revision:"1",authority:"isolated-tree"}});
  if(shared)shared.publications=publications;
  const service=shared?null:new HelarcActivityService({store,purposes:registry,purposeIds:[publications.purpose.contract.ref.id],rediscoveryMs:10,
    reconsideration:(owner,subscription)=>owner==="material-source"?(subscription.id===`${subscription.binding?.id}:source-lifecycle`?publications.lifecycle:publications.deliveries):null});
  const handoff=createHelarcReportMaterialHandoff({store,publications,rediscoveryMs:10,deliveryContracts:deliveries,
    host:shared?.host??{assertAvailable:()=>service.assertAvailable(),subscribe:listener=>store.onActivityChange(listener),wake:()=>service.wake()},
    binding:async result=>({child:{runId:result.correlation.child.run.id,recipient:await agentForRun(result.correlation.child.run.id),purpose},
      parent:{runId:result.correlation.origin.parent.run.id,recipient:await agentForRun(result.correlation.origin.parent.run.id),purpose},
      permissionBasis:"isolated-tree",scopeId:"tree",localPoolId:"report-local",deadlineAt:"2030-01-01T00:00:00Z",maximumSourceBytes:1048576}),
    authorize:async(result,binding,signal)=>{signal.throwIfAborted();return result.correlation.origin.root.run.id==="root"&&binding.parent.runId===result.correlation.origin.parent.run.id;}});
  return {handoff,deliveries,close:()=>service?.close()};
};
