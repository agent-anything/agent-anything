import type {ProviderRequest} from "@agent-anything/model-interaction";
import {modelInputValueDigest} from "@agent-anything/model-interaction/input";
import type {ContextUseScope} from "@agent-anything/context/selection";
import type {MaterialHold} from "@agent-anything/context/custody";
import type {RepresentationJudgment} from "@agent-anything/context/representation";
import type {ActivityInputNeed} from "../activity/index.js";
import {validateOriginalInputSources,type OriginalInputSources} from "./OriginalInputSources.js";
import {validateOriginalInputPublication,type OriginalInputPublicationPlan} from "./OriginalInputPublications.js";
import {validatePreparedContextInput,type PreparedContextInput} from "./ContextInputPreparation.js";
import {contextInputAcceptance} from "./ContextInputAcceptance.js";
import {recipientContextDeliveryId} from "./ContextDeliveryFacts.js";

/** Establishes exact preservation, not semantic truth or the quality of a transformed representation. */
export function prepareOriginalInputSelection(input:{
  readonly id:string;
  readonly sources:OriginalInputSources;
  readonly publications:readonly Omit<OriginalInputPublicationPlan,"group">[];
  readonly prepared:PreparedContextInput;
  readonly scope:ContextUseScope;
  readonly need:ActivityInputNeed;
  readonly expectedSelectionId:string|null;
  readonly expectedControlRevision:number;
  readonly selectionId:string;
  readonly inputId:string;
  readonly releaseHolds:readonly string[];
}) {
  const {sources,prepared,scope,need}=input;
  validateOriginalInputSources(sources);validatePreparedContextInput(prepared);
  const equal=(a:unknown,b:unknown)=>modelInputValueDigest(a)===modelInputValueDigest(b);
  const recipient={runId:scope.runId,recipient:scope.recipient,purpose:scope.purpose};
  if(sources.runId!==scope.runId||sources.request.purpose!==scope.purpose||need.supplier!==scope.owner||
    prepared.demand.runId!==scope.runId||prepared.demand.recipient!==scope.recipient||prepared.demand.purpose!==scope.purpose||
    prepared.demand.historyBoundary!==sources.boundary||prepared.demand.dependencies.source!==sources.id||prepared.demand.targetRevision!==scope.target||
    !equal(unchangedRequest(prepared.request),unchangedRequest(sources.request)))throw new TypeError("original_input_combination_changed");
  if(prepared.demand.contributions.length!==sources.groups.length||input.publications.length!==sources.groups.length||
    new Set(input.publications.map(p=>p.request.intent.version.ref.materialId)).size!==sources.groups.length)throw new TypeError("original_input_combination_coverage_missing");
  const retained=sources.groups.map(group=>{
    const contribution=prepared.demand.contributions.find(c=>c.id===group.id);
    const selected=contribution?.options.find(o=>o.id===prepared.choice[group.id]);
    const publication=input.publications.find(p=>p.request.intent.version.ref.materialId===group.id);
    if(!contribution||contribution.owner!==group.owner||contribution.sourceRevision!==group.revision||!selected||selected.revision!==group.revision||
      !equal(selected.sections,group.occurrences)||!equal(selected.duties,group.duties)||
      !equal(contribution.deliveryIds,group.deliveries.map(d=>recipientContextDeliveryId(d.id,recipient)))||!publication)
      throw new TypeError("original_input_contribution_changed");
    return {publication,published:validateOriginalInputPublication({...publication,group},recipient,scope.target)};
  });
  const inputDigest=modelInputValueDigest(prepared);
  const judgment:RepresentationJudgment={id:`original-input-combination:${modelInputValueDigest({scope:scope.id,sources:sources.id,inputDigest})}`,
    owner:scope.owner,kind:"combination",subjects:retained.map(p=>p.published.representation.ref),inputs:retained.map(p=>p.published.access.range),
    purpose:scope.purpose,target:scope.target,methodRevision:"original-input-equality:1",
    dependencies:{inputDigest,inputSource:sources.id,originalSource:sources.originalSourceId,encodedInput:prepared.encoded.id,stage:prepared.preparationStageId},
    coverage:retained.map(p=>p.published.access.range),conclusion:"supported",
    limitations:["Exact original preservation only; source truth and transformed semantic quality are not assessed"],
    basis:"Complete original request content, ordered occurrences, declared duties, native groups and published source versions match"};
  const holds=(responsibility:"input"|"selection"):readonly MaterialHold[]=>retained.map(({publication,published})=>({
    id:`original-input-hold:${modelInputValueDigest({scope:scope.id,inputId:input.inputId,selectionId:input.selectionId,source:publication.pathId,responsibility})}`,
    instanceId:publication.request.intent.instanceId,consumer:recipient,responsibility,range:published.access.range,
    basis:responsibility==="input"?input.inputId:input.selectionId,releaseCondition:"Explicit release after the original consumer responsibility settles"}));
  const acceptance=contextInputAcceptance({id:input.id,scope,expectedSelectionId:input.expectedSelectionId,expectedControlRevision:input.expectedControlRevision,
    selection:{id:input.selectionId,representations:judgment.subjects,judgmentIds:[judgment.id],holds:holds("selection")},retainedSelectionId:null,
    prepared,judgment,inputId:input.inputId,activityId:need.stage.pathId,stageRequestId:need.stage.id,stageKind:need.stage.stageKind,
    capabilities:need.stage.capabilities,dependencies:need.stage.dependencies,inputHolds:holds("input"),releaseHolds:input.releaseHolds});
  return {judgment,acceptance:{...acceptance,parts:[
    {owner:"context_selection",kind:"scope",proposal:scope},
    {owner:"representation",kind:"judge",proposal:judgment},...acceptance.parts]}};
}

function unchangedRequest(request:ProviderRequest):unknown {
  // Identity, derived working-view bookkeeping and capacity annotation may change; model content may not.
  const {requestId:_,composition,modelContext,...content}=request;
  const {id:__,workingView:___,...compositionContent}=composition;
  return {...content,composition:compositionContent,modelContext:{requestedOutput:modelContext.requestedOutput,headroom:modelContext.headroom}};
}
