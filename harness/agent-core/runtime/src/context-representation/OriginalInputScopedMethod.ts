import {snapshotProviderRequest,type ProviderRequest} from "@agent-anything/model-interaction";
import {composeModelInput,modelInputValueDigest} from "@agent-anything/model-interaction/input";
import type {MaterialRecipient} from "@agent-anything/context/custody";
import {supplyOriginalInputMethod,type OriginalInputMethodSupply} from "./OriginalInputMethodSupply.js";
import type {OriginalInputMethodScope} from "./OriginalInputMethodScope.js";
import type {OriginalInputSources} from "./OriginalInputSources.js";
import type {OriginalInputPublicationPlan} from "./OriginalInputPublications.js";
import type {RepresentationMethodRequest} from "./methods/RepresentationMethod.js";
import {quoteRepresentationMethod} from "./methods/RepresentationMethodQuotation.js";
import type {ContextPolicyEvidence,ContextPreparationOption} from "./ContextPreparationPolicy.js";

export interface OriginalInputScopedMethodSupply<S extends OriginalInputMethodScope> extends OriginalInputMethodSupply {
  readonly scope:S;
  readonly option:ContextPreparationOption;
  readonly consumerId:string;
}

/** Freezes source duties and exact auxiliary bindings; it does not grant adoption or semantic approval. */
export function supplyOriginalInputScopedMethod<S extends OriginalInputMethodScope>(input:{
  readonly sources:OriginalInputSources;
  readonly scope:S;
  readonly kind:"historical_account"|"result_text"|"data_text";
  readonly objective:string;
  readonly sourceExtentBytes:number;
  readonly publications:readonly OriginalInputPublicationPlan[];
  readonly sourceRecipient:MaterialRecipient;
  readonly target:string;
  readonly authorizationBasis:string;
  readonly capacity:RepresentationMethodRequest["capacity"];
  readonly bounds:RepresentationMethodRequest["bounds"];
  readonly limits:ContextPreparationOption["limits"];
  readonly addresses:readonly string[];
}):OriginalInputScopedMethodSupply<S> {
  const {scope,sources}=input;
  const purpose="context_representation",recipient={runId:sources.runId,recipient:"context-representation",purpose};
  const capacity={...input.capacity,policy:{...input.capacity.policy,purpose}};
  const identity={kind:input.kind,objective:input.objective,scope:scope.id,target:input.target,authority:input.authorizationBasis,recipient,
    capacity,bounds:input.bounds,limits:input.limits,modelContext:{...sources.request.modelContext,assessment:null}};
  const consumerId=`${sources.runId}:${input.kind}-method:${modelInputValueDigest(identity)}`;
  const publication=input.publications.find(p=>p.group.id===scope.groups.find(g=>g.role==="source")!.id);
  if(!publication?.published)throw new TypeError("original_input_publication_pending");
  const template=methodTemplate(sources.request,consumerId,purpose,publication.request.intent.version.origin.occurredAt!,scope);
  const supplied=supplyOriginalInputMethod({...input,consumerId,groups:scope.groups,specification:{
    kind:"representation_method",method:"summarize",methodRevision:"1",recipient,
    objective:input.objective,
    requirements:scope.requirements,relationships:scope.relationships,combinationDigest:null,combine:"merge",omission:null,search:null,
    template,targetRevision:input.target,capacity,bounds:input.bounds}});
  const evidence=(id:string):ContextPolicyEvidence=>({id,owner:"context-representation",kind:"fact",revision:"1"});
  const quotation=quoteRepresentationMethod(supplied.request);
  const option:ContextPreparationOption={id:consumerId,request:supplied.request,stableScope:evidence(scope.id),addresses:input.addresses,
    sourceExtent:{utf8Bytes:input.sourceExtentBytes,evidence:{id:scope.id,owner:scope.owner,kind:"fact",revision:"1"}},
    entries:quotation.phases.map(p=>({phase:p.kind,state:"supported",evidence:evidence(`${consumerId}:entry:${p.kind}`)})),
    limits:input.limits,capability:["generation","assessment"].map(duty=>({duty:duty as "generation"|"assessment",conclusion:"unknown",
      targetRevision:input.target,methodRevision:"1",evidence:{...evidence(`${consumerId}:capability:${duty}:unassessed`),kind:"policy"},response:null})),comparisons:[]};
  return {scope,...supplied,consumerId,option};
}

/** The recipient supplies its own complete-input check template, independently of producer templates. */
export function originalInputReceptionTemplate(sources:OriginalInputSources):ProviderRequest {
  const scope={id:sources.id,runId:sources.runId,groups:sources.groups.map(g=>({id:g.id,revision:g.revision,role:"source" as const}))};
  return methodTemplate(sources.request,`${sources.id}:reception-check`,"context_representation",sources.request.composition.composedAt,scope);
}

function methodTemplate(original:ProviderRequest,id:string,purpose:string,createdAt:string,scope:Pick<OriginalInputMethodScope,"id"|"runId">&{
  readonly groups:readonly Pick<OriginalInputMethodScope["groups"][number],"id"|"revision"|"role">[]}):ProviderRequest {
  const ref={owner:"context-representation",kind:"method_scope",id:scope.id,revision:"1"};
  const lineage={auxiliary:{purpose:"context_generation" as const,method:{...ref,kind:"method",id:"representation-generation"},basis:ref},
    instructionBinding:null,agent:null,instructions:null,instructionRelease:null,instructionResolver:null,instructionContent:null,
    instructionModel:original.composition.lineage.instructionModel,instructionBlocks:[],activeContext:null,contextProjection:null,projectionManifest:null,
    toolSelection:null,toolExposureContent:null,toolExposureBasis:null,toolExposureProof:null,toolGuidance:null,controllerControlGuidance:null,callableDefinitions:null,
    modelQualification:null,interactionHistory:null,protocol:ref,policy:ref};
  const composition=composeModelInput({id,providerId:original.composition.providerId,model:original.composition.model,
    interaction:{kind:"text_generation"},lineage,sections:[{id:`${id}:scope`,source:ref,kind:"transformation_data",role:"user",necessity:"mandatory",
      content:{kind:"structured",value:{scopeId:scope.id,sourceGroups:scope.groups.map(g=>({id:g.id,revision:g.revision,role:g.role}))}}}],composedAt:createdAt});
  return snapshotProviderRequest({requestId:id,purpose,correlation:{controllerRequestId:id,branchId:"representation"},
    instructions:composition.instructions,messages:composition.messages,interaction:composition.interaction,composition,
    modelContext:{...original.modelContext,assessment:null},continuation:null,metadata:{runId:scope.runId,sourceScope:scope.id}});
}
