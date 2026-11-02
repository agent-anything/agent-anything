import type {InspectionReadManifest,InspectionRecordingRead} from "./InspectionProcessQuery.js";

export interface InspectionMetricScope {readonly manifest:InspectionReadManifest;readonly runIds:readonly string[];}
export type InspectionMetricQuery = InspectionMetricScope & (
  | {readonly kind:"advance_process_metrics";readonly cursor?:string;readonly limit?:number}
  | {readonly kind:"read_process_metrics";readonly cursor:string;readonly section:"metrics"|"members"|"evidence"|"intervals";readonly metricId?:string;readonly identity?:string;readonly after?:string;readonly limit?:number}
  | {readonly kind:"release_process_metrics";readonly cursor:string});
export interface InspectionMetric {
  readonly id:string;readonly metric:string;readonly unit:string;readonly evidence:"actual"|"estimate"|"bounds"|"unknown";
  readonly dimensions:Readonly<Record<string,string|null>>;readonly operation:"sum"|"range";
  /** Null is not zero. knownValue is a subtotal only; range samples are never summed. */
  readonly value:number|null;readonly knownValue:number|null;readonly minimum:number|null;readonly maximum:number|null;
  readonly observed:number;readonly missing:number;readonly conflicts:number;readonly missingUpperBounds:number;
}
export interface InspectionMetricEvidence {
  readonly ordinal:number;readonly identity:string;readonly variant:string;readonly part:string;
  readonly location:{readonly sourceId:string;readonly datasetId:string;readonly recordId:string;readonly sequence:number};
}
export interface InspectionMetricInterval {
  readonly identity:string;readonly runId:string|null;readonly phase:string;readonly clock:string;
  readonly start:number;readonly end:number;readonly durationMs:number;readonly category:string;
}
export interface InspectionMetricRead {
  readonly version:"1";readonly calculationVersion:"1";readonly scope:InspectionMetricScope;
  readonly status:"collecting"|"reducing"|"intervals"|"complete"|"limited"|"released";
  readonly cursor:string;readonly expiresAt:string;readonly scanned:number;readonly identities:number;
  readonly recordings:readonly InspectionRecordingRead[];
  readonly metrics:readonly InspectionMetric[];readonly evidence:readonly InspectionMetricEvidence[];readonly intervals:readonly InspectionMetricInterval[];
  readonly members:readonly {readonly metricId:string;readonly identity:string}[];
  readonly next:string|null;readonly limitations:readonly string[];
  readonly overhead:{readonly readMs:number;readonly storeOpenMs:number;readonly verifyMs:number;readonly reduceMs:number;readonly transactionMs:number;readonly closeMs:number;readonly resultMs:number;readonly contentExpansionMs:number;readonly totalMs:number};
}
