import type {ActivityResourceAllowance} from "../activity/ActivityHandoff.js";

/** Owner-reported evidence for policy, not a shared method state machine or cost forecast. */
export interface ContextPreparationWorkEvidence {
  readonly assessmentIssues?:import("./ContextInputUnavailability.js").ContextInputUnavailability["assessmentIssues"];
  readonly state:"accepted"|"active"|"ready"|"failed"|"cancelled"|"unknown";
  readonly revision:number;
  readonly limitationEvidence?:import("./ContextPreparationPolicy.js").ContextPolicyEvidence;
  readonly used:{readonly stages:number;readonly attempts:number;readonly readBytes:number|null;
    readonly storedBytes:number|null;readonly modelCalls:number|null};
  readonly remaining:{readonly stages:number;readonly attempts:number;readonly readBytes:number;
    readonly storedBytes:number;readonly modelCalls:number};
  readonly allowance:ActivityResourceAllowance;
  readonly limitations:readonly string[];
}
