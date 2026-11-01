export type ActivityDispatchWaitCode =
  | "activity_dependency_waiting"
  | "activity_slot_waiting"
  | "activity_schedule_turn_waiting"
  | "activity_schedule_not_ready"
  | "activity_authorization_restricted";

/** Known waiting conditions, not permission to retry or ignore errors from other operations. */
export function isActivityDispatchWaitCode(code:unknown):code is ActivityDispatchWaitCode {
  return code==="activity_dependency_waiting"||code==="activity_slot_waiting"||code==="activity_schedule_turn_waiting"||
    code==="activity_schedule_not_ready"||code==="activity_authorization_restricted";
}
