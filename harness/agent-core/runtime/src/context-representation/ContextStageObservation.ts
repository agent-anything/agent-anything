import {modelInputValueDigest} from "@agent-anything/model-interaction/input";
import type {ActivityPathState,ActivityStageState} from "../activity/ActivityHandoff.js";
import type {PreparedContextInput} from "./ContextInputPreparation.js";
import type {ContextInputMaterializationRequest} from "./ContextInputMaterialization.js";
import type {SourceMaterialPublicationRequest} from "./SourceMaterialPublication.js";
import type {ContextInputUnavailability} from "./ContextInputUnavailability.js";
import type {RepresentationMethodProgress} from "./methods/RepresentationMethod.js";
import type {MaterialReadPage} from "@agent-anything/context/custody";
import type {RepresentationRef} from "@agent-anything/context/representation";

/** Public read of retained professional evidence. No processing, access or new semantic judgment. */
export function contextStageObservation(path:ActivityPathState,stage:ActivityStageState) {
  const runId=path.intent.runId,purpose=path.intent.purpose;
  if(stage.request.pathId!==path.intent.id||modelInputValueDigest(purpose.contract)!==purpose.digest)throw new TypeError("context_observation_scope_invalid");
  const scope={runId,pathId:stage.request.pathId,stageId:stage.request.id,purpose,revision:modelInputValueDigest(stage)};
  const inputOwned=purpose.contract.inputOwner==="context-representation",methodOwned=purpose.contract.executionOwner==="representation-execution";
  const raw=stage.result?.value as {kind?:string;prepared?:PreparedContextInput}|null;
  const accepted=stage.receipt?.progress as {state?:string;prepared?:PreparedContextInput}|null;
  const prepared=accepted?.state==="prepared"?accepted.prepared:raw?.kind==="prepared"?raw.prepared:
    (stage.request.input as {kind?:string})?.kind==="prepared_context_input"?stage.request.input as PreparedContextInput:undefined;
  const source=stage.request.input as SourceMaterialPublicationRequest|null;
  const unavailable=stage.request.input as ContextInputUnavailability|null;
  const request=(stage.request.input as {request?:ContextInputMaterializationRequest}|null)?.request;
  const materialization=inputOwned&&request?.kind==="context_input_materialization"?materializationObservation(stage,request):null;
  const method=(stage.receipt?.progress as {method?:RepresentationMethodProgress}|null)?.method;
  const methodObservation=(stage.receipt?.progress as {methodObservation?:{resourcesDelta:{readBytes:number|null;storedBytes:number|null};generated:readonly RepresentationRef[]}}|null)?.methodObservation;
  return {scope,coverage:{preparation:inputOwned,publication:purpose.contract.inputOwner==="material-source",method:methodOwned},prepared:inputOwned?prepared??null:null,
    publication:purpose.contract.inputOwner==="material-source"&&source?.kind==="source_material_publication"&&source.lifecycle?{lifecycle:source.lifecycle,subscriptionId:`${stage.request.pathId}:source-lifecycle`}:null,
    limitation:(inputOwned||purpose.contract.interpretationOwner==="task-decision")&&unavailable?.kind==="context_input_unavailable"?unavailable:null,
    materialization,method:methodOwned&&method?{
      resourcesDelta:methodObservation?.resourcesDelta??{readBytes:null,storedBytes:null},
      progress:{state:method.state,current:method.current,queue:method.queue,sourceBoundary:method.request.sourceBoundary,
        deliveriesNotConsumedByMethod:method.request.deliveryIds,readPages:method.pages,rangeUnits:method.rangeUnits,candidates:method.candidates,
        assessments:method.assessments,checkGroups:method.checkGroups,resultIds:method.resultIds,gap:method.gap,
        resources:{readBytes:method.readBytes,storedBytes:method.storedBytes,modelCalls:method.modelCalls},
        interpretationMs:stage.receipt?.interpretationMs??null,executionUsage:stage.result?.usage??null},
      generated:methodObservation?.generated??[],
      judgments:method.assessments.filter(assessment=>assessment.rawResultId===stage.result?.id).flatMap(assessment=>assessment.judgmentIds),
    }:null};
}
function materializationObservation(stage:ActivityStageState,request:ContextInputMaterializationRequest) {
  const declarations=request.demand.contributions.flatMap(contribution=>contribution.options.flatMap(option=>option.sections.flatMap(occurrence=>{
    const content=occurrence.section.content;
    const positions=content.kind==="retained_text"?[{access:content.access,slot:null}]:content.kind==="retained_result_text"?content.replacements:[];
    return positions.map(part=>({contribution:contribution.id,option:option.id,section:occurrence.section.id,position:occurrence.position,role:occurrence.section.role,access:part.access,
      resultTextSlot:part.slot,bindings:[...(option.resultTextBindings??[]).filter(b=>b.sectionId===occurrence.section.id&&part.slot&&modelInputValueDigest(b.slot)===modelInputValueDigest(part.slot)),
        ...(part.slot?[]:(option.dataTextBindings??[]).filter(b=>b.sectionId===occurrence.section.id))]}));
  })));
  const read=stage.result?.value as {kind?:string;page?:MaterialReadPage}|null;
  const progress=stage.receipt?.progress as {state?:string;preparationPathId?:string;pages?:readonly {stageId:string;rawResultId:string}[]}|null;
  return {demandId:request.demand.id,recipient:request.demand.recipient,purpose:request.demand.purpose,historyBoundary:request.demand.historyBoundary,
    declarations,maximumReadBytes:request.demand.maximumReadBytes,pageBytes:request.pageBytes,progress:stage.receipt?.progress??null,
    read:read?.kind==="page"&&read.page?{version:read.page.version,start:read.page.start,end:read.page.end,encodedPayloadBytes:read.page.bytesBase64.length}:null,
    pageResults:progress?.pages??[],preparationStageId:progress?.state==="organized"&&progress.preparationPathId?`${progress.preparationPathId}:stage:1`:null};
}
export type ContextStageObservation=ReturnType<typeof contextStageObservation>;
