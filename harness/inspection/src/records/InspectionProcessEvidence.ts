import type {InspectionSubjectRef} from "./InspectionRecord.js";

export const INSPECTION_PROCESS_PROJECTION_VERSION = "1" as const;
export const INSPECTION_PROCESS_CATEGORIES = ["source","demand","decision","measurement","representation","method","coordination","selection","input","delivery","material","responsibility","recovery","timing"] as const;
export interface InspectionEvidenceOrigin {
  readonly owner:string; readonly id:string; readonly runId:string|null; readonly revision:string;
}
export interface InspectionEvidenceBasis {
  readonly origin:InspectionEvidenceOrigin;
  /** Digest of the original owner evidence, not its capture time or redacted display. */
  readonly digest:string;
}
export interface InspectionProcessEvidence extends InspectionEvidenceBasis {
  readonly version:"1";
  readonly category:typeof INSPECTION_PROCESS_CATEGORIES[number];
  readonly subject:InspectionSubjectRef;
  readonly name:string;
  readonly status:string|null;
  readonly purpose:string|null;
  readonly recipient:{readonly runId:string;readonly recipient:string;readonly purpose:string}|null;
  readonly relationCount:number;
  /** Original execution arrangement declared by its owner, never inferred from an id. */
  readonly executionPath?:InspectionSubjectRef;
  readonly judgment?: {
    readonly foreground:string;readonly investment:string;readonly adoption:string|null;
    /** Exact ordinal in this observation's protected content descriptors. */
    readonly detailsContentOrdinal:number;
  };
}
/** Public owner judgment body; variable-length detail is not part of an index header. */
export interface InspectionJudgmentContent {
  readonly version:"1";
  readonly foreground:string;readonly investment:string;readonly adoption:string|null;readonly reason:string|null;
  readonly reconsiderOn:readonly string[];readonly limitations:readonly string[];
  readonly excluded:readonly {readonly optionId:string;readonly reasons:readonly string[]}[];
}
export interface InspectionProcessRelationship {
  readonly version:"1";
  readonly evidence:InspectionEvidenceBasis;
  readonly ordinal:number;
  readonly total:number;
}
export interface InspectionWorkTiming {
  readonly category?:"work"|"resource_wait"|"dependency_wait";
  readonly version:"1";
  readonly intervalId:string;
  readonly owner:string;
  readonly runId:string;
  readonly pathId:string;
  readonly stageId:string;
  readonly attemptId:string|null;
  readonly workId:string|null;
  readonly purposeDigest:string;
  readonly phase:string;
  readonly boundary:"started"|"finished";
  readonly clock:{readonly domain:string;readonly monotonicMs:number};
  readonly durationMs:number|null;
  readonly outcome:"returned"|"threw"|null;
}

export function inspectionEvidenceKey(origin:InspectionEvidenceOrigin):string {
  return JSON.stringify([origin.owner,origin.runId,origin.id,origin.revision]);
}
