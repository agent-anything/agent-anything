import type {ContextPreparationPolicyInput,ContextPreparationDecision} from "./ContextPreparationPolicy.js";

export interface ContextPreparationInvestment {
  readonly workId:string;
  readonly pathId:string;
  readonly previousPathId?:string;
}
export interface ContextPreparationDecisionProposal {
  readonly input:ContextPreparationPolicyInput;
  readonly expectedDecisionId:string|null;
  readonly expectedControlRevision:number;
  readonly investment:ContextPreparationInvestment|null;
}
export interface ContextPreparationDecisionRecord {
  readonly decision:ContextPreparationDecision;
  readonly input:ContextPreparationPolicyInput;
  readonly acceptanceId:string;
  readonly investment:ContextPreparationInvestment|null;
}
export type ContextPreparationDecisionQuery =
  | {readonly kind:"decision";readonly id:string}
  | {readonly kind:"latest";readonly scopeId:string}
  | {readonly kind:"exploration";readonly scopeId:string;readonly key:string};
export interface ContextPreparationDecisionStore {
  query(query:ContextPreparationDecisionQuery):Promise<ContextPreparationDecisionRecord|null>;
  investments(input:{readonly scopeId:string;readonly afterWorkId:string|null;readonly limit:number}):Promise<readonly ContextPreparationDecisionRecord[]>;
}
