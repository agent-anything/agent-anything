import type {RunTreeResourceDimension,RunTreeResourceMeasurement} from "./RunTreeResourceAccount.js";

/** A cumulative contribution, not an incremental debit or a task response. */
export interface RunResourceContribution {
  readonly source:string;
  readonly runId:string;
  readonly sequence:number;
  readonly revision:string;
  /** Opaque source-owned collection cursor, not an execution/recovery instruction. */
  readonly cursor?:string;
  readonly usage:Partial<Record<RunTreeResourceDimension,{
    readonly knownValue:number;
    readonly status:RunTreeResourceMeasurement["status"];
  }>>;
}

export interface RunResourceContributionSource {
  readonly id:string;
  /** These dimensions must not also be charged through legacy response items. */
  readonly dimensions:readonly RunTreeResourceDimension[];
  read(runId:string,previous:RunResourceContribution|null):Promise<RunResourceContribution>;
}
