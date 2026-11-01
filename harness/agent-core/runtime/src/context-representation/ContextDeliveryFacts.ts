import type {MaterialRecipient} from "@agent-anything/context/custody";
import {modelInputValueDigest} from "@agent-anything/model-interaction/input";
import {activityToken,type ActivityFactSource,type ActivityPublishedFact,type ActivityReconsiderationState,type ActivityStageState} from "../activity/index.js";

export type ContextDeliveryTransition="published"|"selected"|"accepted"|"selection_released"|"disposed";
export interface ContextDeliveryFactPublisher {
  register(recipient:MaterialRecipient):void;
  publish(recipient:MaterialRecipient,deliveryId:string,transition:ContextDeliveryTransition,basis:string):void;
}
export interface ContextDeliveryLifecycleReader {
  readFact(id:string):ActivityPublishedFact|null;
  subscription(id:string):ActivityReconsiderationState|null;
  stage(id:string):ActivityStageState|null;
}

/** The original information identity stays independent of its receiving purpose. */
export function recipientContextDeliveryId(originalId:string,recipient:MaterialRecipient):string {
  [originalId,recipient.runId,recipient.recipient,recipient.purpose].forEach(activityToken);
  return `${originalId}:recipient:${modelInputValueDigest([recipient.runId,recipient.recipient,recipient.purpose])}`;
}

/** Recipient-scoped delivery facts are not observations of a producer's private activity. */
export function contextDeliveryFactSource(recipient:MaterialRecipient):ActivityFactSource {
  [recipient.runId,recipient.recipient,recipient.purpose].forEach(activityToken);
  return {id:`context-delivery-source:${modelInputValueDigest([recipient.runId,recipient.recipient,recipient.purpose])}`,
    runId:recipient.runId,owner:"context_delivery"};
}

export function contextDeliveryFact(recipient:MaterialRecipient,deliveryId:string,
  transition:ContextDeliveryTransition,basis:string):ActivityPublishedFact {
  [deliveryId,basis].forEach(activityToken);
  const source=contextDeliveryFactSource(recipient),revision=modelInputValueDigest({transition,basis});
  return {id:`${source.id}:${deliveryId}:${revision}`,sourceId:source.id,
    ref:{owner:source.owner,kind:transition,id:deliveryId,revision}};
}
