import type {ActivityHandoffFact,ActivityPathState,ActivityStageState} from "@agent-anything/agent-runtime/activity";
import {contextStageObservation,type ContextStageObservation} from "@agent-anything/agent-runtime/context-representation";
import type {InspectionRecordInput,InspectionMeasurementData} from "@agent-anything/inspection/records";
import {modelInputValueDigest} from "@agent-anything/model-interaction/input";
import type {InspectionProjectionRefs} from "./InspectionReplay.js";

export function* stageMeasurements(r:InspectionProjectionRefs,path:ActivityPathState,stage:ActivityStageState,observed?:ContextStageObservation):Generator<InspectionRecordInput> {
  const observation=observed??contextStageObservation(path,stage),runId=path.intent.runId;
  const emit=(id:string,target:string|null,purpose:string|null,data:InspectionMeasurementData):InspectionRecordInput=>({
    subject:r.ref("activity-measurement","contribution",id,runId),occurredAt:stage.result?.recordedAt??null,
    payload:{kind:"work_measurement",version:"1",origin:{owner:"activity-measurement",id,runId,revision:"1"},purpose,target,data}});
  const prepared=observation.prepared;
  if(prepared)for(const m of prepared.measurement){
    const q=m.quantity,id=modelInputValueDigest({measurement:m.id,encoded:prepared.encoded.id});
    yield emit(id,m.targetRevision,prepared.demand.purpose,{kind:"quantity",metric:"capacity",
      unit:m.dimension.includes("tokens")?"tokens":m.dimension==="request_bytes"?"bytes":"items",
      evidence:q.kind==="exact"?"actual":q.kind,value:q.kind==="unknown"?null:q.kind==="bounds"?q.lower:q.value,
      upper:q.kind==="bounds"?q.upper:null,method:JSON.stringify([m.methodRevision,m.dimension]),complete:m.coverage==="complete"});
  }
  const material=observation.materialization;
  if(material?.read&&stage.result)yield emit(stage.result.id,JSON.stringify(material.read.version.ref),material.purpose,
    {kind:"quantity",metric:"material_read",unit:"bytes",evidence:"actual",value:material.read.end-material.read.start,upper:null,method:"material-range-bytes",complete:true});
  if(material?.read&&stage.result)yield emit(`${stage.result.id}:transfer`,JSON.stringify(material.read.version.ref),material.purpose,
    {kind:"quantity",metric:"material_transfer",unit:"bytes",evidence:"actual",value:material.read.encodedPayloadBytes,upper:null,method:"base64-material-payload-excluding-envelope",complete:true});
  if(observation.method&&stage.result)for(const [metric,value] of [["material_read",observation.method.resourcesDelta.readBytes],["material_stored",observation.method.resourcesDelta.storedBytes]] as const)
    yield emit(`${stage.result.id}:${metric}`,path.intent.id,path.intent.purpose.contract.ref.id,{kind:"quantity",metric,unit:"bytes",evidence:value===null?"unknown":"actual",value,
      upper:null,method:metric==="material_stored"?"method-retained-logical-bytes":"method-logical-read-bytes",complete:value!==null});
}

/** State is selected by the owner's durable sequence, never by capture order. */
export function responsibilityMeasurement(r:InspectionProjectionRefs,fact:ActivityHandoffFact):InspectionRecordInput|null {
  const stage=fact.requestId;
  let id:string|null=null,state:"open"|"closed"="open";
  if(stage&&["stage_submitted","accepted","settled"].includes(fact.kind)){id=stage;state=fact.kind==="stage_submitted"?"open":"closed";}
  else if(stage&&fact.kind==="professional_stopped"&&fact.details.unexecuted===true){id=stage;state="closed";}
  else if(fact.kind==="scheduling_accepted")id=(fact.details.acceptance as import("@agent-anything/agent-runtime/activity").ActivitySchedulingAcceptance).intent.workId;
  else if(fact.kind==="scheduling_closed"&&fact.details.settlementChecked===true){id=fact.pathId;state="closed";}
  if(!id)return null;
  const owner=stage?"activity-stage":"activity-work";
  return {subject:r.ref(owner,"contribution",id,fact.runId),occurredAt:fact.occurredAt,payload:{kind:"work_measurement",version:"1",
    origin:{owner,id,runId:fact.runId,revision:"1"},purpose:null,target:null,data:{kind:"responsibility",sequence:fact.sequence,state}}};
}
