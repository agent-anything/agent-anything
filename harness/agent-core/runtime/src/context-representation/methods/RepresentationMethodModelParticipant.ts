import type {ModelPurposeEvidence} from "@agent-anything/model-interaction/protocol";
import type {ActivityPathState,ActivityStageState} from "../../activity/ActivityHandoff.js";
import type {RepresentationMethodRequest,MethodJob} from "./RepresentationMethod.js";
import type {MethodEvidence} from "./RepresentationMethodInput.js";

export interface RepresentationMethodModelInput {
  readonly request:RepresentationMethodRequest;
  readonly job:MethodJob;
  readonly evidence:readonly MethodEvidence[];
}
export type RepresentationMethodModelResult=
  | {readonly kind:"input_unavailable";readonly inputDigest:string;readonly code:string;readonly details:unknown}
  | {readonly kind:"contract_result";readonly value:unknown;readonly evidence:ModelPurposeEvidence}
  | {readonly kind:"unavailable";readonly code:string;readonly details:unknown;readonly evidence:ModelPurposeEvidence};

/** One professional job's native input/execution, never professional scheduling or adoption. */
export interface RepresentationMethodModelParticipant {
  execute(input:RepresentationMethodModelInput,path:ActivityPathState,stage:ActivityStageState,signal:AbortSignal):Promise<RepresentationMethodModelResult>;
  /** Inspect/resume the original activity only; null never authorizes re-execution. */
  reconcile(input:RepresentationMethodModelInput,path:ActivityPathState,stage:ActivityStageState,signal:AbortSignal):Promise<RepresentationMethodModelResult|null>;
  /** Retain original interruption/follow-up ownership; not a model result or remote-stop claim. */
  interrupt(input:RepresentationMethodModelInput,path:ActivityPathState,stage:ActivityStageState,signal:AbortSignal):Promise<unknown>;
}
