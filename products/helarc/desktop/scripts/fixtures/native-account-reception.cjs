const assert=require("node:assert/strict"),{createHash}=require("node:crypto");
module.exports=async function({store,publications,processor,producers,published,originalItems,originalSources,scope,inputId,composition,protocolName,intent,accept,signal,now,capacity}){
  const {modelInputValueDigest:digest}=await import("@agent-anything/model-interaction/input");
  const {bindProtocolModelActivity}=await import("@agent-anything/agent-runtime/model-access");
  const {sourceMaterialOutcome}=await import("@agent-anything/agent-runtime/context-representation");
  const a=c=>store.activityHandoffs.command(c);
  const recipient={runId:scope.runId,recipient:scope.recipient,purpose:scope.purpose};
  const bytes=Buffer.from(JSON.stringify(originalItems)),pathId="native-complete-history",stageId=`${pathId}:capture`;
  if(!await a({kind:"read_path",pathId})){
    const request={kind:"source_material_publication",recipient,purpose:scope.purpose,target:scope.target,bytesBase64:bytes.toString("base64"),
      intent:{id:`${pathId}:custody`,instanceId:`${pathId}:instance`,activityId:pathId,owner:"material-source",maximumBytes:bytes.length,
        version:{ref:{materialId:pathId,version:digest(originalItems)},origin:{runId:scope.runId,owner:"helarc-native-input",recordId:"original-task-source",revision:"1",occurredAt:now()},
          label:"Complete original native items",format:"json",mediaType:"application/json",bytes:bytes.length,digest:`sha256:${createHash("sha256").update(bytes).digest("hex")}`,capture:"complete",limitations:[]}}};
    await accept({id:`${pathId}:start`,scope:scope.runId,actor:"material-source",parts:publications.prepareSubmission(intent(pathId),request)});
  }
  let capture;
  for(let n=0;n<4;n++){
    capture=await a({kind:"read_stage",requestId:stageId});if(capture.status==="accepted")break;
    const cycle=await processor.drain(scope.runId,signal);assert.deepEqual(cycle.failures,[]);
  }
  const publishedHistory=sourceMaterialOutcome(await a({kind:"read_path",pathId}),capture);assert.equal(publishedHistory.kind,"published_source_material");
  const access=publishedHistory.access,description=await store.materialCustody.command({kind:"describe",holdId:access.holdId,recipient});
  const activity=bindProtocolModelActivity({composition,scope:{runId:scope.runId,recipientId:scope.recipient,activityId:"original-native-task",purpose:composition.composition.task.purpose,compositionDigest:composition.digest},
    conditions:{input:{id:"original-task-source",revision:"1"},authority:{id:scope.authorityBasis,revision:"1"},resources:{id:"bounded",revision:"1"},control:{id:"active",revision:"1"}}});
  const body={model:composition.composition.configuration.model,[protocolName==="responses"?"input":"messages"]:originalItems,...(protocolName==="responses"?{store:false}:{})};
  const prepared={format:"helarc.native-prepared-task.v1",binding:{scope:activity.scope,protocol:composition.composition.protocol},previous:null,
    sourceDigest:"original-task-source",wire:{body:JSON.stringify(body),digest:digest(body)},workingSources:originalSources,results:[],delivery:[]};
  const continuity=protocolName==="responses"?{kind:"responses",policy:"native_replay",previous:null,conditions:{basis:"original",authorized:true,disclosureRevision:scope.authorityBasis,remoteStorage:false,
    targetSupport:"established",predecessor:"unavailable",reestablish:false,policyChange:false}}:{kind:"explicit"};
  const receptionInput={activity,prepared,scope,inputId,selectionId:`${inputId}:selection`,judgmentId:"native-combination-check:job:initial:judgment",
    members:producers.map(({supply,result})=>({methodPathId:supply.consumerId,candidateId:result.progress.resultIds[0],supply})),
    publications:published,history:{record:publishedHistory.representation,hold:description.hold},continuity,
    capacity:{...(capacity??producers[0].supply.request.capacity),policy:{...(capacity??producers[0].supply.request.capacity).policy,purpose:scope.purpose}},maximumReadBytes:1000000};
  return {receptionInput,historyCapture:{stageId,receipt:capture.receipt.id,result:capture.result.id,attempt:capture.attempt.id}};
};
