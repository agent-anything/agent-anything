import {modelInputValueDigest} from "@agent-anything/model-interaction/input";
import {recipientContextDeliveryId} from "./ContextDeliveryFacts.js";
import type {MaterialAccessAdmission,MaterialRecipient} from "@agent-anything/context/custody";
import {validateOriginalInputSources,originalInputDataBody,type OriginalInputSources} from "./OriginalInputSources.js";
import {validateOriginalInputPublication,type OriginalInputPublicationPlan} from "./OriginalInputPublications.js";
import {validateRepresentationMethodRequest,type RepresentationMethodRequest,type MethodSource} from "./methods/RepresentationMethod.js";

export type OriginalInputMethodSpecification=Omit<RepresentationMethodRequest,"sources"|"sourceBoundary"|"deliveryIds">;
export interface OriginalInputMethodSupply {
  readonly request:RepresentationMethodRequest;
  readonly materialAdmissions:readonly MaterialAccessAdmission[];
}

/** Supplies exact published groups. The trusted Host authorizes the new purpose; CRM chooses whether to invest. */
export function supplyOriginalInputMethod(input:{
  readonly sources:OriginalInputSources;
  readonly publications:readonly OriginalInputPublicationPlan[];
  readonly sourceRecipient:MaterialRecipient;
  readonly target:string;
  readonly authorizationBasis:string;
  readonly consumerId:string;
  readonly specification:OriginalInputMethodSpecification;
  readonly groups:readonly {readonly id:string;readonly alias:string;readonly role:MethodSource["role"]}[];
}):OriginalInputMethodSupply {
  const {sources,specification,sourceRecipient}=input;
  validateOriginalInputSources(sources);
  if(!input.authorizationBasis.trim()||!input.consumerId.trim()||sourceRecipient.runId!==sources.runId||sourceRecipient.purpose!==sources.request.purpose||
    specification.recipient.runId!==sources.runId||specification.targetRevision!==input.target||
    !input.groups.length||new Set(input.groups.map(g=>g.id)).size!==input.groups.length)
    throw new TypeError("original_method_supply_binding_invalid");
  const materialAdmissions:MaterialAccessAdmission[]=[],methodSources:MethodSource[]=[],deliveries=new Set<string>();
  for(const selected of input.groups) {
    const group=sources.groups.find(g=>g.id===selected.id);
    const matches=input.publications.filter(p=>p.group.id===selected.id);
    if(!group||matches.length!==1||modelInputValueDigest(group)!==modelInputValueDigest(matches[0]!.group))
      throw new TypeError("original_method_supply_source_mismatch");
    // An original input cannot be relabeled as an already generated candidate.
    if(selected.role==="candidate")throw new TypeError("original_method_supply_candidate_invalid");
    const publication=matches[0]!,published=validateOriginalInputPublication(publication,sourceRecipient,input.target);
    const identity=modelInputValueDigest({source:published.access,recipient:specification.recipient,basis:input.authorizationBasis,consumerId:input.consumerId});
    const hold={id:`method-source:${identity}:hold`,instanceId:publication.request.intent.instanceId,consumer:specification.recipient,
      responsibility:"preparation" as const,range:published.access.range,basis:input.consumerId,
      releaseCondition:"All accepted method and downstream consumer responsibilities explicitly settled"};
    const grant={id:`method-source:${identity}:grant`,instanceId:hold.instanceId,recipient:hold.consumer,range:hold.range,
      revision:0,allowed:true,basis:input.authorizationBasis};
    materialAdmissions.push({source:published.access,grant,hold});
    methodSources.push({alias:selected.alias,role:selected.role,
      access:{id:`method-source:${identity}:access`,holdId:hold.id,recipient:hold.consumer,range:hold.range},
      representation:published.representation.ref,order:Math.min(...group.occurrences.map(o=>o.position)),
      label:`Original source ${group.id}`,originalRole:[...new Set(group.occurrences.map(o=>o.section.role))].join("+"),indivisibleGroup:group.id,
      ...(selected.role==="source"&&originalInputDataBody(group)!==null?{division:{kind:"text_utf8" as const,basis:`Declared Host body ${group.dataTexts![0]!.id}; ranges are partial evidence, not independent meanings`}}:{})});
    for(const delivery of group.deliveries)deliveries.add(recipientContextDeliveryId(delivery.id,sourceRecipient));
  }
  const ordered=methodSources.sort((a,b)=>a.order-b.order).map((source,order)=>({...source,order}));
  const request:RepresentationMethodRequest={...specification,sources:ordered,
    sourceBoundary:modelInputValueDigest(ordered.map(s=>({range:s.access.range,representation:s.representation,group:s.indivisibleGroup}))),
    deliveryIds:[...deliveries].sort()};
  validateRepresentationMethodRequest(request);
  return {request,materialAdmissions};
}
