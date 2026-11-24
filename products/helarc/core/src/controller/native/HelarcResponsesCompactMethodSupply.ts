import {modelInputValueDigest as digest} from "@agent-anything/model-interaction/input";
import {OPENAI_RESPONSES,requireModelPurpose,type ModelAgentCompositionBinding,type ProtocolRevisionRef} from "@agent-anything/model-interaction/protocol";
import type {MaterialAccessAdmission} from "@agent-anything/context/custody";
import type {ContextPreparationOption,ProtocolRepresentationMethodRequest} from "@agent-anything/agent-runtime/context-representation";
import {RESPONSES_COMPACT_METHOD} from "@agent-anything/provider-integrations/native";
import type {HelarcRetainedNativeInput} from "./HelarcNativeInputAcceptance.js";
import {helarcNativeInputRequirements} from "./HelarcNativeInputRequirements.js";
import {bindHelarcResponsesCompactPrefix,helarcResponsesCompactScopes} from "./HelarcResponsesCompactScopes.js";
import type {HelarcNativeSourcePublication} from "./HelarcNativeSourcePublications.js";
import {quoteHelarcResponsesCompact} from "./HelarcResponsesCompaction.js";

export interface HelarcResponsesCompactMethodBasis {
  readonly native:HelarcRetainedNativeInput;
  readonly publications:readonly HelarcNativeSourcePublication[];
  readonly composition:ModelAgentCompositionBinding;
  readonly purpose:ProtocolRevisionRef;
  readonly authorityBasis:string;
  readonly probeRequired:boolean;
  readonly assessmentModelCalls?:number;
  readonly assessmentInput?:import("./HelarcResponsesCompaction.js").HelarcResponsesCompactSource["assessmentInput"];
  readonly bounds:ProtocolRepresentationMethodRequest["bounds"];
  readonly limits:ContextPreparationOption["limits"];
  readonly addresses:readonly string[];
}

/** Original native scopes and custody admissions; investment remains a shared policy decision. */
export function supplyHelarcResponsesCompactMethod(b:HelarcResponsesCompactMethodBasis,throughGroups:number){
  requireModelPurpose(b.composition,b.purpose);
  const n=b.native,{scope,target}=n.manifest,c=b.composition.composition.configuration;
  if(b.composition.composition.protocol.id!==OPENAI_RESPONSES.id||scope.compositionDigest!==b.composition.digest||
    target.configuration!==`${c.configuration.id}:${c.configuration.revision}`||target.disclosure!==b.authorityBasis||
    target.model!==c.model||!n.workingSources)throw new TypeError("compact_method_composition_changed");
  const source={...bindHelarcResponsesCompactPrefix(n,b.publications,throughGroups,b.purpose),
    ...(b.assessmentInput?{assessmentInput:b.assessmentInput}:{}),
    ...(b.assessmentModelCalls!==undefined?{assessmentModelCalls:b.assessmentModelCalls}:{})};
  const recipient={runId:scope.runId,recipient:"context-representation",purpose:b.purpose.id};
  const pathId=`${scope.runId}:native-compact-method:${digest({source,bounds:b.bounds,limits:b.limits,probeRequired:b.probeRequired,recipient})}`;
  const materialAdmissions:MaterialAccessAdmission[]=source.groups.map((g,index)=>{
    const native=source.manifest.groups[index]!,publication=b.publications.find(p=>p.published&&digest(p.published.representation.ref)===digest(native.representation));
    if(!publication?.published)throw new TypeError("compact_method_publication_missing");
    const access=publication.published.access,id=`${pathId}:source:${g.id}`;
    const hold={id:`${id}:hold`,instanceId:publication.request.intent.instanceId,consumer:recipient,responsibility:"preparation" as const,
      range:access.range,basis:pathId,releaseCondition:"Original compact production and dependent consumers settled"};
    return {source:access,hold,grant:{id:`${id}:grant`,instanceId:hold.instanceId,recipient,range:hold.range,revision:0,allowed:true,basis:b.authorityBasis}};
  });
  const materialAccesses=materialAdmissions.map(a=>({id:`${a.hold.id}:read`,holdId:a.hold.id,recipient,range:a.hold.range}));
  const quote=quoteHelarcResponsesCompact({source,bounds:b.bounds,probeRequired:b.probeRequired,materialAccesses});
  const evidence={id:source.sourceDigest,owner:RESPONSES_COMPACT_METHOD.id,revision:"1",kind:"fact" as const};
  const option:ContextPreparationOption<ProtocolRepresentationMethodRequest>={id:pathId,request:quote.request,quotation:quote.quotation,
    stableScope:evidence,addresses:b.addresses,limits:b.limits,
    sourceExtent:{utf8Bytes:Buffer.byteLength(JSON.stringify(source.manifest.groups.slice(0,throughGroups).flatMap(g=>g.items))),evidence},
    independentReception:{boundary:n.manifest.selection.boundary,requirementsDigest:digest(helarcNativeInputRequirements(n.workingSources.groups)),evidence},
    entries:quote.quotation.phases.map(p=>({phase:p.kind,state:"supported",evidence})),
    capability:["generation","assessment"].map(duty=>({duty:duty as "generation"|"assessment",conclusion:"unknown",targetRevision:target.configuration,
      methodRevision:source.dependencies.method,evidence:{...evidence,kind:"policy",id:`${pathId}:${duty}`},response:null})),comparisons:[]};
  return {option,pathId,source,request:quote.request,materialAdmissions};
}

export function supplyHelarcResponsesCompactMethods(b:HelarcResponsesCompactMethodBasis,maximum:number){
  const inventory=helarcResponsesCompactScopes(b.native,b.publications,b.purpose,maximum);
  const offers=inventory.scopes.map(s=>supplyHelarcResponsesCompactMethod(b,s.groups.length));
  return {offers,report:{owner:RESPONSES_COMPACT_METHOD.id,revision:"1",sourceBoundary:b.native.manifest.selection.boundary,
    enumeration:inventory.enumeration,unavailable:inventory.exclusions.map(e=>({groupId:e.groupId,reasons:e.reasons})),
    offers:offers.map(o=>({optionId:o.option.id,scopeId:o.source.sourceDigest,requirementIds:o.source.duties.map(d=>d.id),
      sources:o.materialAdmissions.map(a=>({role:"source" as const,materialId:a.source.range.materialId,version:a.source.range.version}))}))}};
}
