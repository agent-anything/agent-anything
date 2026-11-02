import {modelInputValueDigest} from "@agent-anything/model-interaction/input";
import type {RepresentationCatalogPort,RepresentationJudgment} from "@agent-anything/context/representation";
import type {ActivityHandoffPort,ActivityStageState} from "../../activity/ActivityHandoff.js";
import type {InheritedMethodCheck,MethodAssessment,MethodCandidate,MethodSource,RepresentationMethodProgress,RepresentationMethodRequest} from "./RepresentationMethod.js";
import {findMethodAssessmentReuse,methodInputSources} from "./RepresentationMethodReuse.js";
import {representationMethodRequirements} from "./RepresentationMethod.js";
import {methodPreservationSupport,methodSupportCovers,qualifiedMethodRelation} from "./MethodPreservationSupport.js";
import {remainingMethodRelations} from "./RepresentationMethodPlanning.js";

interface EvidencePorts {
  readonly producerPathId:string;readonly method:RepresentationMethodProgress;
  readonly activities:ActivityHandoffPort;readonly representations:RepresentationCatalogPort;readonly signal:AbortSignal;
}
const equal=(a:unknown,b:unknown)=>modelInputValueDigest(a)===modelInputValueDigest(b);

/** Resolves the original accepted stage, not merely a copied judgment label in progress. */
export async function validateMethodAssessmentEvidence(input:EvidencePorts,assessment:MethodAssessment):Promise<boolean> {
  const {method,signal}=input;
  if(!assessment.supported||assessment.scope!=="both"||assessment.judgmentIds.length!==1)return false;
  signal.throwIfAborted();
  const judgment=await input.representations.command({kind:"read_judgment",id:assessment.judgmentIds[0]!}) as RepresentationJudgment|null;
  if(!judgment||judgment.runId!==method.request.recipient.runId||judgment.kind!=="semantic"||!judgment.dependencies.stage)return false;
  const stage=await input.activities.command({kind:"read_stage",requestId:judgment.dependencies.stage}) as ActivityStageState|null;
  const inputState=stage?.request.input as {method?:RepresentationMethodProgress;kind?:string;preparationStageId?:string;demand?:{dependencies:Readonly<Record<string,string>>}}|undefined;
  let prior=inputState?.method;
  if(!prior&&stage?.request.stageKind==="model"&&inputState?.kind==="prepared_context_input"&&inputState.preparationStageId) {
    const preparation=await input.activities.command({kind:"read_stage",requestId:inputState.preparationStageId}) as ActivityStageState|null;
    if(preparation?.status!=="accepted"||preparation.request.pathId!==input.producerPathId)return false;
    prior=(preparation.request.input as {method?:RepresentationMethodProgress}).method;
    if(!prior||inputState.demand?.dependencies.scope!==modelInputValueDigest({request:prior.request,job:prior.current}))return false;
  }
  const job=prior?.current;
  if(!stage||stage.request.pathId!==input.producerPathId||!prior||!job||!["check","relation"].includes(job.kind)||job.checkScope||
    job.id!==assessment.jobId||!equal(prior.request,method.request)||!equal(job.sources,assessment.sourceAliases)||
    !equal(job.candidates,assessment.candidateIds)||!equal(job.relationshipBasis??null,assessment.relationshipBasis??null))return false;
  const accepted=(stage.receipt?.progress as {method?:RepresentationMethodProgress}|undefined)?.method;
  if(!accepted?.assessments.some(a=>equal(a,assessment)))return false;
  for(const alias of [...job.sources,...job.candidates]) {
    const candidate=method.candidates.find(c=>c.id===alias||c.segments.some(s=>s.id===alias));
    if(candidate&&!prior.candidates.some(c=>equal(c,candidate)))return false;
  }
  if(job.relationshipBasis){
    const {relationshipBasis,...base}=job;
    const rebuilt=qualifiedMethodRelation(prior,{...base,id:job.id.slice(0,-":qualified".length),
      sources:relationshipBasis.relationship.sources,candidates:job.sources});
    if(!rebuilt||!equal(rebuilt,job))return false;
  }
  const reuse=await findMethodAssessmentReuse(input.representations,input.activities,
    {...method.request,reuseJudgments:assessment.judgmentIds},job,methodInputSources(prior,job),signal);
  return reuse!==null;
}

/** Complete local support may have several accepted edges; no edge claims to reread originals. */
export async function qualifiedMethodSources(input:EvidencePorts&{readonly candidates:readonly MethodCandidate[]}):Promise<{
  sources:MethodSource[];relationships:RepresentationMethodRequest["relationships"];inheritedChecks:InheritedMethodCheck;
}|null> {
  const {method,candidates}=input;
  const aliases=method.request.sources.filter(s=>s.role==="source").map(s=>s.alias);
  if(method.state!=="ready"||!equal(method.resultIds,candidates.map(c=>c.id)))return null;
  const support=methodPreservationSupport(method,candidates);
  if(!support||!methodSupportCovers(method,support,aliases))return null;
  const assessments=new Map(support.assessments.map(a=>[a.id,a]));
  for(const relation of [...method.request.relationships,...candidates.flatMap(c=>c.relationships)]) {
    const checked=[...method.assessments].reverse().find(a=>a.supported&&a.scope==="both"&&
      (a.relationshipBasis?equal(a.relationshipBasis.relationship,relation):relation.sources.every(s=>a.sourceAliases.includes(s))));
    if(checked)assessments.set(checked.id,checked);
    else if(relation.requiresCommonEvidence&&remainingMethodRelations(method).some(r=>r.id===relation.id))return null;
  }
  for(const assessment of [...assessments.values()])for(const id of assessment.relationshipBasis?.supportingJudgments??[]) {
    const parent=method.assessments.find(a=>a.judgmentIds.includes(id));if(!parent)return null;assessments.set(parent.id,parent);
  }
  for(const assessment of assessments.values())if(!await validateMethodAssessmentEvidence(input,assessment))return null;
  const sources:MethodSource[]=method.request.sources.filter(s=>s.role==="background");
  const names=new Set(method.request.sources.map(s=>s.alias)),mapping=new Map<string,string[]>();
  const qualified=candidates.map(candidate=>{
    let suffix=0;while(names.has("qualified_"+suffix))suffix++;
    const alias="qualified_"+suffix;names.add(alias);
    const local=methodPreservationSupport(method,[candidate])!;
    for(const source of local.coverage)mapping.set(source.sourceAlias,[...mapping.get(source.sourceAlias)??[],alias]);
    sources.push({alias,role:"source",access:candidate.access,representation:candidate.representation,
      order:Math.max(-1,...sources.map(s=>s.order))+1,label:"Previously checked derived evidence",originalRole:"qualified_representation",indivisibleGroup:alias});
    return {id:candidate.id,representation:candidate.representation,qualifiedSource:alias,losses:candidate.losses,unknowns:candidate.unknowns};
  });
  const relationsById=new Map<string,RepresentationMethodRequest["relationships"][number]>();
  for(const relation of [...method.request.relationships,...candidates.flatMap(c=>c.relationships)]) {
    const existing=relationsById.get(relation.id);
    if(existing&&!equal(existing,relation))return null;
    if(relation.sources.some(alias=>!method.request.sources.some(s=>s.alias===alias)))return null;
    relationsById.set(relation.id,relation);
  }
  const relationships=[...relationsById.values()];
  return {sources,relationships:relationships.map(r=>({...r,sources:[...new Set(r.sources.flatMap(s=>mapping.get(s)??[s]))]})),
    inheritedChecks:{producerPathId:input.producerPathId,runId:method.request.recipient.runId,requestDigest:modelInputValueDigest(method.request),assessments:[...assessments.values()],
      objective:method.request.objective,sourceRanges:method.request.sources.map(s=>s.access.range),requirements:representationMethodRequirements(method.request),
      requirementBindings:representationMethodRequirements(method.request).map(r=>({originalId:r.id,combinedId:r.id})),relationships,candidates:qualified}};
}
