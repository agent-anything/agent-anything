const assert=require("node:assert/strict");
module.exports=async function nativeTreeStop({store,transport,provider,compositions,checkpoint,phase}){
  const h=await import("@agent-anything/helarc/controller"),stop=await import("@agent-anything/helarc/task-fulfillment");
  const {bindProtocolModelActivity}=await import("@agent-anything/agent-runtime/model-access");
  const ref=id=>({id,revision:"1"}),journal=store.protocolJournal;
  const execution=new h.HelarcNativeStructuredExecution({journal,acceptance:store.sharedAcceptance,generation:store.generation,now:()=>new Date().toISOString(),
    authorize:async(request,context)=>{context.signal.throwIfAborted();assert.deepEqual(request.activity.composition,compositions.get(request.activity.composition.composition.agent.id));
      const admission=await store.readRunCommit(`${request.activity.scope.runId}:commit:0`);assert.equal(admission.admission.lineage.root.id,"root");},
    observe:async(state,request,context)=>{
      const saved=await journal.command({kind:"record",activityId:state.activity.scope.activityId,ref:request.observation});if(saved)return saved;
      const record=await transport.observe(state,request,context.signal,async()=>context.signal.throwIfAborted());
      if(phase==="stop-observed")await checkpoint("Stop original response retained before purpose acceptance",state.activity);
      return record;
    }});
  return stop.createHelarcNativeStopEvaluation({execution,prepare:async source=>{
    const composition=compositions.get(source.event.agent.id);assert(composition);
    const activity=bindProtocolModelActivity({composition,scope:{runId:source.event.run.id,activityId:source.activityId,recipientId:source.event.agent.id,
      purpose:ref("helarc.task-fulfillment"),compositionDigest:composition.digest},conditions:{input:source.source,authority:ref("isolated-tree"),resources:ref("bounded-stop"),control:ref("active")}});
    const prepared=await stop.prepareHelarcResponsesStop(source,activity,{journal,contextSelections:store.contextSelections},{stream:false,store:false});
    return transport.prepare(activity,prepared,provider.configuration);
  }});
};
