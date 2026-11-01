import {modelInputValueDigest} from "@agent-anything/model-interaction/input";
import type {MaterialAccess,MaterialAccessDescription,MaterialCustodyPort} from "@agent-anything/context/custody";
import type {RepresentationCatalogPort,RepresentationRecord} from "@agent-anything/context/representation";
import type {ActivityHandoffPort} from "../../activity/index.js";
import {representationMethodRequirements,type CombinationProducerEvidence,type InheritedMethodCheck,type MethodCandidate,type MethodRelationship,type MethodRequirement,type MethodSource,type RepresentationMethodProgress} from "./RepresentationMethod.js";
import {qualifiedMethodSources} from "./QualifiedMethodSources.js";

/** Combines attributable evidence, not the conclusions or authority of its producers. */
export async function methodCombinationEvidence(input:{
  readonly producers:readonly {readonly pathId:string;readonly method:RepresentationMethodProgress;readonly candidates:readonly MethodCandidate[]}[];
  readonly qualified:boolean;readonly activities:ActivityHandoffPort;readonly materials:MaterialCustodyPort;
  readonly representations:RepresentationCatalogPort;readonly signal:AbortSignal;
}) {
  const sources:MethodSource[]=[],requirements:MethodRequirement[]=[],relationships:MethodRelationship[]=[],inheritedChecks:InheritedMethodCheck[]=[],dependencies:MaterialAccess[]=[],producerEvidence:CombinationProducerEvidence[]=[];
  if(!input.producers.length||new Set(input.producers.map(p=>p.pathId)).size!==input.producers.length)
    throw new TypeError("method_combination_producers_invalid");
  for(const [index,{pathId,method,candidates}] of input.producers.entries()) {
    input.signal.throwIfAborted();
    const prefix=input.producers.length===1?"":`producer_${index}:`,name=(id:string)=>prefix+id;
    dependencies.push(...method.request.dependencyAccesses??[]);
    for(const candidate of candidates) {
      const representation=await input.representations.command({kind:"read",ref:candidate.representation}) as RepresentationRecord|null;
      if(!representation)throw new TypeError("method_input_representation_missing");
      for(const holdId of representation.holds) {
        input.signal.throwIfAborted();
        const description=await input.materials.command({kind:"describe",holdId,recipient:method.request.recipient}) as MaterialAccessDescription|null;
        if(!description)throw new TypeError("method_input_dependency_unavailable");
        dependencies.push({id:`${pathId}:dependency:${holdId}`,holdId,recipient:method.request.recipient,range:description.hold.range});
      }
    }
    const qualified=input.qualified?await qualifiedMethodSources({producerPathId:pathId,method,candidates,
      activities:input.activities,representations:input.representations,signal:input.signal}):null;
    if(qualified)dependencies.push(...method.request.sources.map(s=>s.access));
    const originalSources=qualified?.sources??method.request.sources;
    const aliasBindings=originalSources.map((s,i)=>({originalAlias:s.alias,combinedAlias:prefix?`producer_${index}_source_${i}`:s.alias}));
    const alias=(id:string)=>{const binding=aliasBindings.find(b=>b.originalAlias===id);if(!binding)throw new TypeError("method_combination_source_missing");return binding.combinedAlias;};
    for(const source of [...originalSources].sort((a,b)=>a.order-b.order))sources.push({...source,alias:alias(source.alias),indivisibleGroup:name(source.indivisibleGroup),order:sources.length});
    const originalRequirements=representationMethodRequirements(method.request),requirementBindings=originalRequirements.map(r=>({originalId:r.id,combinedId:name(r.id)}));
    requirements.push(...originalRequirements.map(r=>({...r,id:name(r.id)})));
    producerEvidence.push({pathId,requestDigest:modelInputValueDigest(method.request),sourceBoundary:method.request.sourceBoundary,
      sources:aliasBindings,requirements:requirementBindings,candidates:candidates.map(c=>({id:c.id,representation:c.representation}))});
    const declared=new Map<string,MethodRelationship>();
    for(const relation of qualified?.relationships??[...method.request.relationships,...candidates.flatMap(c=>c.relationships)]) {
      const prior=declared.get(relation.id);
      if(prior&&modelInputValueDigest(prior)!==modelInputValueDigest(relation)||relation.sources.some(alias=>!originalSources.some(s=>s.alias===alias)))
        throw new TypeError("method_combination_relationship_ambiguous");
      declared.set(relation.id,relation);
    }
    relationships.push(...[...declared.values()].map(r=>({...r,id:name(r.id),sources:r.sources.map(alias)})));
    if(qualified)inheritedChecks.push({...qualified.inheritedChecks,
      requirementBindings,
      candidates:qualified.inheritedChecks.candidates.map(c=>({...c,qualifiedSource:alias(c.qualifiedSource)}))});
    const aliases=new Set(sources.map(s=>s.alias));
    for(const candidate of candidates) {
      const candidateName=(suffix:number)=>prefix?`producer_${index}_candidate_${suffix}`:`input_candidate_${suffix}`;
      let suffix=0;while(aliases.has(candidateName(suffix)))suffix++;
      const alias=candidateName(suffix);aliases.add(alias);
      sources.push({alias,role:"candidate",access:candidate.access,representation:candidate.representation,
        order:Math.max(-1,...sources.map(s=>s.order))+1,label:"Candidate in the recipient input",originalRole:"derived_representation",indivisibleGroup:alias});
    }
  }
  input.signal.throwIfAborted();
  return {sources,requirements,relationships,inheritedChecks,producerEvidence,
    sourceBoundary:modelInputValueDigest(input.producers.map(p=>({pathId:p.pathId,boundary:p.method.request.sourceBoundary,request:modelInputValueDigest(p.method.request)}))),
    deliveryIds:[...new Set(input.producers.flatMap(p=>p.method.request.deliveryIds))],
    dependencyAccesses:[...new Map(dependencies.map(a=>[modelInputValueDigest(a),a])).values()]};
}
