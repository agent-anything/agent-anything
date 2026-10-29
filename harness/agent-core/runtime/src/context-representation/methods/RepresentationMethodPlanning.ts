import {modelInputValueDigest} from "@agent-anything/model-interaction/input";
import type {MethodJob,RepresentationMethodProgress,MethodRelationship,MethodCandidate} from "./RepresentationMethod.js";
import {methodSources} from "./RepresentationMethodRanges.js";

export function initialMethodJobs(pathId:string,progress:RepresentationMethodProgress):readonly MethodJob[] {
  const request=progress.request,sources=request.sources.filter(s=>s.role==="source").sort((a,b)=>a.order-b.order).map(s=>s.alias),candidates=request.sources.filter(s=>s.role==="candidate").map(s=>s.alias);
  return [{id:`${pathId}:job:initial`,kind:request.method==="check_combination"?"combination":request.method==="check"?"check":"generate",sources,candidates,level:0,repair:0,feedback:null}];
}
/** Splits only declared contract units. Independent semantics are checked, never inferred from this partition. */
export function splitMethodJob(progress:RepresentationMethodProgress,job:MethodJob):readonly MethodJob[]|null {
  if(job.kind!=="generate"||job.level>=progress.request.bounds.levels)return null;
  const groups=new Map<string,string[]>();
  for(const alias of job.sources) {
    const units=progress.rangeUnits.filter(u=>u.originalAlias===alias);
    if(units.length){for(const unit of units)groups.set(unit.source.indivisibleGroup,[unit.source.alias]);continue;}
    const source=methodSources(progress).find(s=>s.alias===alias);if(!source)return null;
    const group=groups.get(source.indivisibleGroup)??[];group.push(alias);groups.set(source.indivisibleGroup,group);
  }
  if(groups.size<2)return null;
  const entries=[...groups.values()],middle=Math.ceil(entries.length/2);
  return [entries.slice(0,middle).flat(),entries.slice(middle).flat()].map((sources,index)=>({...job,id:`${job.id}:part:${index}`,sources,level:job.level+1,repair:0,feedback:null}));
}
export function methodJobKey(job:MethodJob):string{return modelInputValueDigest({...job,id:null,repair:null});}
/** The declared mapping routes evidence; two independent directions test it. */
export function distributedMethodChecks(progress:RepresentationMethodProgress,job:MethodJob):readonly MethodJob[]|null {
  if(job.kind!=="check"||job.checkScope||job.candidates.length!==1)return null;
  const candidate=progress.candidates.find(c=>c.id===job.candidates[0]);if(!candidate?.segments.length)return null;
  const groups=new Map<string,string[]>();
  for(const alias of job.sources){const group=methodSources(progress).find(s=>s.alias===alias)?.indivisibleGroup??alias;groups.set(group,[...(groups.get(group)??[]),alias]);}
  const forward=[...groups.values()].map((sources,index)=>({...job,id:`${job.id}:source:${index}`,sources,
    candidates:candidate.segments.filter(s=>s.sources.some(a=>sources.includes(a))).map(s=>s.id),checkScope:"source" as const}));
  if(forward.some(j=>!j.candidates.length))return null;
  const reverse=candidate.segments.map((segment,index)=>({...job,id:`${job.id}:candidate:${index}`,sources:segment.sources,candidates:[segment.id],checkScope:"candidate" as const}));
  if(forward.length===1&&reverse.length===1)return null;
  return [...forward,...reverse];
}
export function methodCandidateChecked(progress:RepresentationMethodProgress,id:string):boolean {
  return progress.assessments.some(a=>a.scope==="both"&&a.supported&&a.candidateIds.includes(id))||progress.checkGroups.some(g=>g.candidateId===id&&g.jobs.every(j=>progress.assessments.some(a=>a.jobId===j&&a.supported)));
}
export function remainingMethodRelations(progress:RepresentationMethodProgress):readonly MethodRelationship[] {
  const relationships=[...progress.request.relationships,...progress.candidates.flatMap(c=>c.relationships)];
  return relationships.filter(r=>r.requiresCommonEvidence&&!progress.assessments.some(a=>a.scope==="both"&&a.supported&&r.sources.every(s=>a.sourceAliases.includes(s))));
}
export function nextMethodFinalJobs(pathId:string,progress:RepresentationMethodProgress):readonly MethodJob[] {
  const candidates=progress.candidates.filter(c=>progress.resultIds.includes(c.id));
  const relations=remainingMethodRelations(progress);
  if(relations.length)return relations.map(r=>({id:`${pathId}:relation:${modelInputValueDigest(r)}`,kind:"relation",sources:r.sources,
    candidates:candidates.filter(c=>methodSourceAncestors(progress,c).some(s=>r.sources.includes(s)||r.sources.includes(progress.rangeUnits.find(u=>u.source.alias===s)?.originalAlias??""))).map(c=>c.id),level:0,repair:0,feedback:r.description}));
  if(progress.request.combine==="merge"&&candidates.length>1) {
    // A balanced pairwise level bounds input growth without promising semantic shrinkage.
    const pairs:MethodJob[]=[];
    for(let i=0;i+1<candidates.length;i+=2) {
      const pair=candidates.slice(i,i+2);
      const level=1+Math.max(...pair.map(c=>c.level));
      if(level>progress.request.bounds.levels)return [];
      pairs.push({id:`${pathId}:merge:${modelInputValueDigest(pair.map(c=>c.id))}`,kind:"merge",sources:pair.map(c=>c.id),candidates:[],level,repair:0,feedback:null});
    }
    return pairs;
  }
  return [];
}
export function methodCoverageGaps(progress:RepresentationMethodProgress):readonly string[] {
  const selected=progress.candidates.filter(c=>progress.resultIds.includes(c.id));
  const gaps:string[]=[];
  for(const candidate of selected)if(!methodCandidateChecked(progress,candidate.id))gaps.push(`unchecked_candidate:${candidate.id}`);
  if(progress.request.combine==="merge"&&selected.length>1)gaps.push("merge_level_limit");
  const covered=new Set(selected.flatMap(c=>methodSourceAncestors(progress,c)));
  for(const s of progress.request.sources.filter(s=>s.role==="source"))if(!covered.has(s.alias)) {
    const units=progress.rangeUnits.filter(u=>u.originalAlias===s.alias);
    if(!units.length||units.some(u=>!covered.has(u.source.alias)))gaps.push(`source_not_represented:${s.alias}`);
  }
  for(const r of remainingMethodRelations(progress))gaps.push(`relationship_not_checked:${r.id}`);
  return gaps;
}
function methodSourceAncestors(progress:RepresentationMethodProgress,candidate:MethodCandidate,seen=new Set<string>()):readonly string[] {
  if(seen.has(candidate.id))throw new TypeError("representation_lineage_cycle");seen.add(candidate.id);
  return candidate.sources.flatMap(alias=>{
    const parent=progress.candidates.find(c=>c.id===alias);
    return [alias,...(parent?methodSourceAncestors(progress,parent,new Set(seen)):[])];
  });
}
