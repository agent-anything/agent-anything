const assert=require("node:assert/strict");
module.exports=async function({store,transport,provider,compositions,checkpoint,phase,cancel,methodPurpose="method"}){
  const {createHelarcResponsesStructuredPurposes,createHelarcDeepSeekStructuredPurposes,createHelarcOllamaStructuredPurposes}=await import("@agent-anything/helarc/composition");
  const compose=provider.configuration.protocol==="openai.responses"?createHelarcResponsesStructuredPurposes:
    provider.configuration.protocol==="deepseek.chat-completions"?createHelarcDeepSeekStructuredPurposes:createHelarcOllamaStructuredPurposes;
  const ref=id=>({id,revision:"1"});
  return compose({methodPurpose:ref(methodPurpose),selections:store.contextSelections,
    composition:async runId=>{const admission=await store.readRunCommit(`${runId}:commit:0`);
      assert.equal(admission?.admission.lineage.root.id,"root");const binding=compositions.get(admission.state.activeAgent.id);assert(binding);return binding;},
    conditions:async source=>({input:source.source,authority:ref("isolated-tree"),resources:ref("bounded-auxiliary"),control:ref("active")}),
    retainTransport:async request=>transport.prepare(request.activity,request,provider.configuration),
    execution:{journal:store.protocolJournal,acceptance:store.sharedAcceptance,generation:store.generation,now:()=>new Date().toISOString(),
      interrupt:async(state,request)=>transport.interrupt(state,request,`${state.activity.scope.activityId}:cancel`),
      authorize:async(request,context)=>{context.signal.throwIfAborted();assert.deepEqual(request.activity.composition,compositions.get(request.activity.composition.composition.agent.id));},
      observe:async(state,request,context)=>{
        const saved=await store.protocolJournal.command({kind:"record",activityId:state.activity.scope.activityId,ref:request.observation});if(saved)return saved;
        const record=await transport.observe(state,request,context.signal,async()=>context.signal.throwIfAborted());
        if(phase==="ordinary-observed"&&state.activity.scope.purpose.id==="context_representation")await checkpoint("Original normal-policy method observation",state.activity);
        if(phase==="stop-observed"&&state.activity.scope.purpose.id==="helarc.task-fulfillment")await checkpoint("Original Stop observation before purpose acceptance",state.activity);
        if(phase==="conversion-observed"&&state.activity.scope.purpose.id==="method"){
          if(cancel){
            await cancel();
            const pathId=state.activity.scope.activityId.slice(0,-":job:initial:native-method".length);
            const path=await store.activityHandoffs.command({kind:"read_path",pathId});assert(path);
            await store.activityHandoffs.command({kind:"cancel",pathId,expectedControlRevision:path.controlRevision});
          }
          await checkpoint("Original conversion observation before purpose acceptance",state.activity);
        }
        return record;
      }}},{stream:false,store:false});
};
