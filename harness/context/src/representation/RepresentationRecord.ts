import type {MaterialRange} from "../custody/MaterialCustody.js";

export interface RepresentationRef {readonly id:string;readonly revision:string;}
export interface RepresentationInput {
  readonly role:"source"|"background"|"method";
  readonly material:MaterialRange;
  readonly representation:RepresentationRef|null;
}
export interface RepresentationLoss {
  readonly id:string;
  readonly source:MaterialRange;
  readonly kind:"omitted"|"precision"|"unknown";
  readonly description:string;
  readonly basis:string;
}
export interface RepresentationRecord {
  readonly ref:RepresentationRef;
  readonly owner:string;
  readonly runId:string;
  readonly form:"original"|"excerpt"|"summary"|"structured"|"detail_bundle"|"native";
  readonly body:MaterialRange;
  readonly purpose:string;
  readonly target:string;
  readonly inputs:readonly RepresentationInput[];
  readonly declaredCoverage:readonly MaterialRange[];
  readonly details:readonly MaterialRange[];
  readonly holds:readonly string[];
  readonly requirements:readonly {readonly id:string;readonly revision:string;readonly basis:string;readonly description:string}[];
  readonly losses:readonly RepresentationLoss[];
  readonly restorations:readonly {readonly lossId:string;readonly range:MaterialRange;readonly judgmentId:string}[];
  readonly method:{readonly id:string;readonly revision:string;readonly activityId:string;readonly rawResultId:string;readonly acceptanceId:string}|null;
}
export interface RepresentationJudgment {
  readonly id:string;
  readonly owner:string;
  readonly kind:"structure"|"measurement"|"semantic"|"combination"|"policy";
  readonly subjects:readonly RepresentationRef[];
  readonly inputs:readonly MaterialRange[];
  readonly purpose:string;
  readonly target:string;
  readonly methodRevision:string;
  readonly dependencies:Readonly<Record<string,string>>;
  readonly coverage:readonly MaterialRange[];
  readonly conclusion:"supported"|"unsupported"|"unknown";
  readonly limitations:readonly string[];
  readonly basis:string;
}
export interface RepresentationReuse {
  readonly id:string;
  readonly judgmentId:string;
  readonly purpose:string;
  readonly target:string;
  readonly methodRevision:string;
  readonly subjects:readonly RepresentationRef[];
  readonly dependencies:Readonly<Record<string,string>>;
}
export type RepresentationCommand =
  | {readonly kind:"record";readonly record:RepresentationRecord}
  | {readonly kind:"read";readonly ref:RepresentationRef}
  | {readonly kind:"read_judgment";readonly id:string}
  | {readonly kind:"judge";readonly judgment:RepresentationJudgment}
  | {readonly kind:"reuse";readonly request:RepresentationReuse};
export type RepresentationValue = RepresentationRecord | RepresentationJudgment | null |
  {readonly id:string;readonly judgmentId:string;readonly applicable:boolean;readonly reasons:readonly string[]};
export interface RepresentationCatalogPort {command(command:RepresentationCommand):Promise<RepresentationValue>;}
