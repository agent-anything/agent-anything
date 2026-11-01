import {modelInputValueDigest} from "@agent-anything/model-interaction/input";
import type {MaterialRange} from "@agent-anything/context/custody";
import {representationMethodRequirements,type MethodAssessment,type MethodCandidate,type MethodJob,type RepresentationMethodProgress} from "./RepresentationMethod.js";
import {methodSources} from "./RepresentationMethodRanges.js";

export interface MethodPreservationSupport {
  readonly assessments:readonly MethodAssessment[];
  readonly coverage:readonly {readonly sourceAlias:string;readonly ranges:readonly MaterialRange[]}[];
}

/** A structural support graph, not a new semantic judgment. Each edge must be independently accepted. */
export function methodPreservationSupport(method:RepresentationMethodProgress,candidates:readonly MethodCandidate[]):MethodPreservationSupport|null {
  const assessments=new Map<string,MethodAssessment>(),ranges=new Map<string,MaterialRange[]>(),seen=new Set<string>();
  const equal=(a:unknown,b:unknown)=>modelInputValueDigest(a)===modelInputValueDigest(b);
  const visit=(candidate:MethodCandidate):boolean=>{
    if(seen.has(candidate.id)||candidate.unknowns.some(u=>u.kind==="preservation_gap"))return false;
    seen.add(candidate.id);
    const check=[...method.assessments].reverse().find(a=>a.supported&&a.scope==="both"&&a.judgmentIds.length===1&&
      equal(a.candidateIds,[candidate.id])&&equal(a.sourceAliases,candidate.sources)&&!a.relationshipBasis&&
      representationMethodRequirements(method.request).every(r=>a.requirements.some(x=>x.id===r.id&&x.conclusion==="supported")));
    if(!check)return false;assessments.set(check.id,check);
    for(const alias of candidate.sources){
      const parent=method.candidates.find(c=>c.id===alias);
      if(parent){if(!visit(parent))return false;continue;}
      const source=methodSources(method).find(s=>s.alias===alias),root=method.rangeUnits.find(u=>u.source.alias===alias)?.originalAlias??alias;
      if(!source||source.role!=="source"||!method.request.sources.some(s=>s.alias===root&&s.role==="source"))return false;
      ranges.set(root,[...ranges.get(root)??[],source.access.range]);
    }
    seen.delete(candidate.id);return true;
  };
  if(!candidates.length||!candidates.every(visit))return null;
  return {assessments:[...assessments.values()],coverage:[...ranges].map(([sourceAlias,ranges])=>({sourceAlias,ranges}))};
}

export function methodSupportCovers(method:RepresentationMethodProgress,support:MethodPreservationSupport,aliases:readonly string[]):boolean {
  return aliases.every(alias=>{
    const source=method.request.sources.find(s=>s.alias===alias);if(!source)return false;
    if(source.role==="background")return true;
    const r=source.access.range,covered=support.coverage.find(c=>c.sourceAlias===alias)?.ranges??[];
    let end=r.start;
    for(const range of [...covered].sort((a,b)=>a.start-b.start)){
      if(range.materialId!==r.materialId||range.version!==r.version||range.coordinate!==r.coordinate||range.start<r.start||range.end>r.end||range.start>end)return false;
      end=Math.max(end,range.end);
    }
    return end===r.end;
  });
}

export function qualifiedMethodRelation(method:RepresentationMethodProgress,job:MethodJob):MethodJob|null {
  if(job.kind!=="relation"||job.relationshipBasis)return null;
  const candidates=method.candidates.filter(c=>job.candidates.includes(c.id)),support=methodPreservationSupport(method,candidates);
  if(!support||!methodSupportCovers(method,support,job.sources))return null;
  const relationships=[...method.request.relationships,...method.candidates.flatMap(c=>c.relationships)].filter(r=>
    r.requiresCommonEvidence&&modelInputValueDigest(r.sources)===modelInputValueDigest(job.sources)&&r.description===job.feedback);
  if(relationships.length!==1)return null;
  return {...job,id:`${job.id}:qualified`,sources:candidates.map(c=>c.id),candidates:[],
    relationshipBasis:{relationship:relationships[0]!,supportingJudgments:support.assessments.flatMap(a=>a.judgmentIds),coverage:support.coverage}};
}
