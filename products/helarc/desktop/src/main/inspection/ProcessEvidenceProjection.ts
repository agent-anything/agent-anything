import {modelInputValueDigest} from "@agent-anything/model-interaction/input";
import type {InspectionProcessEvidence,InspectionRecordInput} from "@agent-anything/inspection/records";
import type {InspectionProjectionRefs} from "./InspectionReplay.js";
import {inspectionRelationshipRecords} from "./InspectionRelationships.js";

interface ProcessProjection {readonly observation:InspectionRecordInput["subject"];
  readonly occurredAt:string|null;readonly evidence:Omit<InspectionProcessEvidence,"version"|"relationCount">;
  readonly contents?:InspectionRecordInput["contents"];readonly links:NonNullable<InspectionRecordInput["links"]>}
export function* processEvidenceRecords(r:InspectionProjectionRefs,input:ProcessProjection):Generator<InspectionRecordInput> {
  const evidence={version:"1" as const,...input.evidence,relationCount:input.links.length};
  yield {subject:input.observation,occurredAt:input.occurredAt,payload:{kind:"process_evidence",...evidence},...(input.contents?{contents:input.contents}:{})};
  yield* inspectionRelationshipRecords(r,input.observation,input.occurredAt,input.links,{origin:evidence.origin,digest:evidence.digest});
}
export function processObservationRef(r:InspectionProjectionRefs,origin:InspectionProcessEvidence["origin"],digest:string) {
  return r.ref("inspection","event",`process:${modelInputValueDigest({origin,digest})}`,origin.runId);
}
