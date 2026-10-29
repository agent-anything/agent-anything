import {modelInputValueDigest} from "@agent-anything/model-interaction/input";
import type {RepresentationCatalogPort,RepresentationJudgment} from "@agent-anything/context/representation";
import type {MethodJob,MethodSource,RepresentationMethodRequest} from "./RepresentationMethod.js";
import type {AssessedRepresentation} from "./RepresentationMethodOutput.js";
import type {ActivityHandoffPort,ActivityStageState} from "../../activity/ActivityHandoff.js";
import type {RepresentationMethodProgress} from "./RepresentationMethod.js";

/** Original response provenance is retained separately from semantic compatibility conditions. */
export function methodAssessmentConditions(request:RepresentationMethodRequest,job:MethodJob,sources:readonly MethodSource[]):string {
  return modelInputValueDigest({methodRevision:request.methodRevision,objective:request.objective,requirements:request.requirements,restorations:request.restorations??[],relationships:request.relationships,
    sourceBoundary:request.sourceBoundary,target:request.combination?.scope.target??request.targetRevision,purpose:request.combination?.scope.purpose??request.recipient.purpose,
    combination:request.combinationDigest,scope:job.checkScope??"both",details:(request.dependencyAccesses??[]).map(a=>a.range),sources:sources.map(s=>({alias:s.alias,role:s.role,range:s.access.range,representation:s.representation,order:s.order,label:s.label,originalRole:s.originalRole}))});
}
export async function findMethodAssessmentReuse(catalog:RepresentationCatalogPort,activities:ActivityHandoffPort,request:RepresentationMethodRequest,job:MethodJob,sources:readonly MethodSource[],signal:AbortSignal):Promise<{judgmentId:string;output:AssessedRepresentation}|null> {
  if(!["check","relation","combination"].includes(job.kind))return null;
  const conditions=methodAssessmentConditions(request,job,sources);
  for(const id of request.reuseJudgments??[]) {
    signal.throwIfAborted();const judgment=await catalog.command({kind:"read_judgment",id}) as RepresentationJudgment|null;
    if(!judgment||judgment.conclusion!=="supported"||judgment.dependencies.conditions!==conditions||judgment.methodRevision!=="bidirectional:1"||judgment.kind!==(job.kind==="combination"?"combination":"semantic"))continue;
    const subjects=sources.filter(s=>job.candidates.includes(s.alias)).map(s=>s.representation);
    if(subjects.some(ref=>!ref)||modelInputValueDigest(request.combination?.subjects??subjects)!==modelInputValueDigest(judgment.subjects))continue;
    const requestId=judgment.dependencies.stage;if(!requestId)continue;
    const stage=await activities.command({kind:"read_stage",requestId}) as ActivityStageState|null;
    if(stage?.status!=="accepted"||stage.receipt?.id!==judgment.dependencies.acceptance||stage.result?.id!==judgment.dependencies.rawResult)continue;
    const progress=(stage.receipt.progress as {method?:RepresentationMethodProgress})?.method;
    const assessment=progress?.assessments.find(a=>a.judgmentIds.includes(id)&&a.rawResultId===stage.result!.id);
    if(!assessment?.supported||assessment.scope!==(job.checkScope??"both"))continue;
    const output:AssessedRepresentation={kind:"assessment",findings:assessment.findings,requirements:assessment.requirements,missing:[]};
    return {judgmentId:id,output};
  }
  return null;
}
