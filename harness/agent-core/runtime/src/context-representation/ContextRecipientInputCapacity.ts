import {assessInputCapacity,modelInputValueDigest,type InputCapacityAssessment,type InputCapacityLimit,
  type InputMeasurementEvidence} from "@agent-anything/model-interaction/input";
import type {ContextUseScope} from "@agent-anything/context/selection";

/** Quantities for one complete recipient-owned input, not a common request body. */
export interface ContextRecipientInputCapacity {
  readonly inputId:string;
  readonly measurements:readonly InputMeasurementEvidence[];
  readonly limits:readonly InputCapacityLimit[];
  readonly assessment:InputCapacityAssessment;
}

export function validateContextRecipientInputCapacity(value:ContextRecipientInputCapacity,scope:ContextUseScope):void {
  const original=value.assessment;
  if(!value.inputId||original.encodedInputId!==value.inputId||original.targetRevision!==scope.target)
    throw new TypeError("context_recipient_capacity_scope_invalid");
  const confirmed=assessInputCapacity({encodedInputId:value.inputId,targetRevision:scope.target,purpose:scope.purpose,
    evidence:value.measurements,limits:value.limits,reservations:original.reservations,policy:original.policy,refusals:original.refusals});
  if(modelInputValueDigest(confirmed)!==modelInputValueDigest(original))throw new TypeError("context_recipient_capacity_changed");
}
