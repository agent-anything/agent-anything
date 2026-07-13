import type { ISODateTimeString, Metadata } from "@agent-anything/shared";
import type { ToolResult } from "@agent-anything/tools";
import type { PlanUpdateObservation } from "../plan/index.js";
import type { RuntimeError } from "./RuntimeError.js";

export interface ObservationBase {
  readonly id: string;
  readonly runId: string;
  readonly actionId: string;
  readonly createdAt: ISODateTimeString;
  readonly metadata: Metadata;
}

export interface PlanUpdateResultObservation extends ObservationBase {
  readonly kind: "plan_update";
  readonly result: PlanUpdateObservation;
}

export interface ToolResultObservation<TOutput = unknown> extends ObservationBase {
  readonly kind: "tool_result";
  readonly result: ToolResult<TOutput>;
}

export type ActionDeniedOwner = "policy" | "permission" | "tool";

export interface ActionDeniedObservation extends ObservationBase {
  readonly kind: "action_denied";
  readonly owner: ActionDeniedOwner;
  readonly code: string;
  readonly message: string;
}

export interface ActionFailureObservation extends ObservationBase {
  readonly kind: "action_failure";
  readonly error: RuntimeError;
}

export type ActionRejectedCode =
  | "action_invalid"
  | "action_unsupported"
  | "tool_not_found";

export interface ActionRejectedObservation extends ObservationBase {
  readonly kind: "action_rejected";
  readonly code: ActionRejectedCode;
  readonly message: string;
}

export type Observation<TToolOutput = unknown> =
  | PlanUpdateResultObservation
  | ToolResultObservation<TToolOutput>
  | ActionDeniedObservation
  | ActionFailureObservation
  | ActionRejectedObservation;
