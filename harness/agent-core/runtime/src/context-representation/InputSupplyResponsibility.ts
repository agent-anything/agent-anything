import {modelInputValueDigest} from "@agent-anything/model-interaction/input";
import type {ActivityFactSource,ActivityPathIntent,ActivitySchedulingIntent, SharedAcceptancePart} from "../activity/index.js";

/** Original need/source binding, not authority to control its dependencies. */
export interface InputSupplyBinding {
  readonly needId:string;
  readonly runId:string;
  readonly owner:string;
  readonly consumerPathId:string;
  readonly source:{readonly stageId:string;readonly requestDigest:string};
  readonly configuration:{readonly id:string;readonly revision:string};
}
export interface InputSupplyResponsibility {
  readonly id:string;
  readonly role:"source_publication"|"input_preparation"|"method_production"|"method_reception";
  readonly relation:"dependency"|"owned";
  readonly target:{readonly pathId:string;readonly owner:string;readonly intentDigest:string;readonly workId:string|null};
}
export interface InputSupplyRegistration {
  readonly binding:InputSupplyBinding;
  readonly expectedRevision:number;
  readonly expectedConsumerControlRevision:number;
  readonly responsibilities:readonly InputSupplyResponsibility[];
  readonly scheduling?:ActivitySchedulingIntent|null;
}
export interface InputSupplyHead {
  readonly binding:InputSupplyBinding;
  readonly revision:number;
  readonly acceptanceId:string;
  readonly scheduling:ActivitySchedulingIntent|null;
}
export interface AcceptedInputSupplyResponsibility extends InputSupplyResponsibility {
  readonly needId:string;
  readonly acceptanceId:string;
}
export type InputSupplyResponsibilityQuery =
  | {readonly kind:"exit";readonly needId:string}
  | {readonly kind:"exit_pending";readonly needId:string;readonly revision:number;readonly limit:number}
  | {readonly kind:"head";readonly needId:string}
  | {readonly kind:"page";readonly needId:string;readonly revision:number;readonly afterId:string|null;readonly limit:number}
  | {readonly kind:"users";readonly target:InputSupplyResponsibility["target"];readonly frontier:number|null;readonly afterSequence:number;readonly limit:number}
  | {readonly kind:"work_users";readonly workId:string;readonly frontier:number|null;readonly afterSequence:number;readonly limit:number};
export type InputSupplyResponsibilityPage =
  | {readonly kind:"changed";readonly revision:number|null}
  | {readonly kind:"page";readonly head:InputSupplyHead;readonly entries:readonly AcceptedInputSupplyResponsibility[];readonly next:string|null;readonly complete:boolean};
/** References to registered uses only; absence is not proof that an arbitrary producer is unused. */
export interface InputSupplyUsersPage {
  readonly kind:"users";
  readonly frontier:number;
  readonly entries:readonly {readonly binding:InputSupplyBinding;readonly responsibility:AcceptedInputSupplyResponsibility}[];
  readonly next:number|null;
  readonly complete:boolean;
}
export type InputSupplyExitBasis=
  | {readonly kind:"returned";readonly stageId:string;readonly requestDigest:string}
  | {readonly kind:"cancelled";readonly controlRevision:number};
export interface InputSupplyExit {
  readonly origin:Omit<InputSupplyBinding,"configuration">;
  readonly subscriptionId:string;
  readonly membershipRevision:number;
  readonly scheduling:ActivitySchedulingIntent|null;
  readonly basis:InputSupplyExitBasis;
  readonly revision:number;
  readonly status:"closing"|"closed";
  readonly acceptanceId:string;
}
export interface InputSupplyExitDisposition {
  readonly responsibilityId:string;
  readonly kind:"dependency_withdrawn"|"owned_settled"|"reception_transferred";
}
export type InputSupplyExitProposal=
  | {readonly kind:"begin";readonly origin:InputSupplyExit["origin"];readonly subscriptionId:string;
      readonly expectedMembershipRevision:number;readonly expectedConsumerControlRevision:number;readonly basis:InputSupplyExitBasis}
  | {readonly kind:"dispose";readonly needId:string;readonly expectedRevision:number;readonly dispositions:readonly InputSupplyExitDisposition[]}
  | {readonly kind:"complete";readonly needId:string;readonly expectedRevision:number};
export type InputSupplyExitPending=
  | {readonly kind:"changed";readonly revision:number|null}
  | {readonly kind:"exit_pending";readonly exit:InputSupplyExit;readonly entries:readonly AcceptedInputSupplyResponsibility[];readonly more:boolean;
      readonly uncoveredPathId:string|null};
export type InputSupplyResponsibilityValue=InputSupplyHead|InputSupplyResponsibilityPage|InputSupplyUsersPage|InputSupplyExit|InputSupplyExitPending|null;
export interface InputSupplyResponsibilityStore {
  query(query:InputSupplyResponsibilityQuery):Promise<InputSupplyResponsibilityValue>;
}

export function inputSupplyResponsibility(role:InputSupplyResponsibility["role"],intent:ActivityPathIntent):InputSupplyResponsibility {
  return {id:modelInputValueDigest({role,pathId:intent.id}),role,
    relation:role==="source_publication"||role==="method_production"?"dependency":"owned",
    target:{pathId:intent.id,owner:intent.owner,intentDigest:modelInputValueDigest(intent),workId:intent.scheduledWorkId??null}};
}
export function inputSupplyRegistration(proposal:InputSupplyRegistration):SharedAcceptancePart {
  return {owner:"context_input_supply",kind:"register",proposal};
}
export function inputSupplyExit(proposal:InputSupplyExitProposal):SharedAcceptancePart {
  return {owner:"context_input_supply",kind:"exit",proposal};
}
export function inputSupplyFactSource(binding:Pick<InputSupplyBinding,"needId"|"runId"|"owner">):ActivityFactSource {
  return {id:`input-supply:${binding.needId}`,runId:binding.runId,owner:binding.owner};
}
