import type {ModelCallableRequest,ModelCallRef} from "@agent-anything/model-interaction";
import type {ModelPurposeEvidence,NativeModelSourceRef,ModelInteractionScope,ProtocolRevisionRef,ModelInteractionProtocolRef} from "@agent-anything/model-interaction/protocol";
import type {NativeSchemaSpec} from "@agent-anything/provider-integrations/native";
import type {PlanLimits} from "@agent-anything/agent-runtime/plan";
import type {HelarcModelCallableBinding} from "../HelarcModelCallableContracts.js";

export interface HelarcNativeTaskBinding {
  readonly scope:ModelInteractionScope;
  readonly protocol:ModelInteractionProtocolRef;
  readonly adapter:ProtocolRevisionRef;
  readonly interpreter:ProtocolRevisionRef;
  readonly acceptance:ProtocolRevisionRef;
  readonly requestId:string;
  readonly controllerRequestId:string;
  readonly operationId:string;
  readonly record:ProtocolRevisionRef;
  readonly catalog:readonly {readonly definition:import("@agent-anything/model-interaction").ModelCallableDefinition;readonly binding:HelarcModelCallableBinding}[];
  readonly schemaMode:NativeSchemaSpec["mode"];
  readonly catalogRevision:string;
  readonly hasPlan:boolean;
  readonly planLimits:PlanLimits;
}
export interface HelarcNativeTaskText {readonly source:NativeModelSourceRef;readonly text:string}
export interface HelarcCommittedTaskReply {
  readonly scope:ModelInteractionScope;
  readonly acceptance:ProtocolRevisionRef;
  readonly responseRecord:ProtocolRevisionRef;
  readonly text:readonly HelarcNativeTaskText[];
}
export interface HelarcNativeTaskProposal {
  readonly evidence:ModelPurposeEvidence;
  readonly kind:"advance"|"propose_completion"|"continue_with_feedback";
  readonly text:readonly HelarcNativeTaskText[];
  readonly refusals:readonly HelarcNativeTaskText[];
  readonly calls:readonly {readonly call:ModelCallableRequest;readonly binding:HelarcModelCallableBinding}[];
  readonly rejections:readonly {readonly call:ModelCallRef;readonly nativeCallId:string|null;readonly name:string;readonly code:string;readonly message:string}[];
  readonly ending:null|{readonly call:ModelCallRef|null;readonly disposition:string;readonly response:string;readonly sources:readonly NativeModelSourceRef[];
    readonly text?:readonly HelarcNativeTaskText[];
    readonly plan:unknown;readonly materialRefs:unknown};
  readonly feedback:null|{readonly code:string;readonly message:string};
}

