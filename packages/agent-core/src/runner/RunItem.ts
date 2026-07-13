import type { ISODateTimeString, Metadata } from "@agent-anything/shared";
import type { ControllerModelItem } from "../controller/index.js";
import type { PlanProjection } from "../plan/index.js";
import type { Action } from "./Action.js";
import type { Observation } from "./Observation.js";
import type { RunCancellationSummary } from "./RunCancellation.js";
import type { RunBlockedCode, RunFailureCode } from "./RunResult.js";
import type { RuntimeError } from "./RuntimeError.js";

export interface RunItemBase {
  readonly id: string;
  readonly runId: string;
  readonly sequence: number;
  readonly createdAt: ISODateTimeString;
  readonly metadata: Metadata;
}

export interface ModelOutputRunItem extends RunItemBase {
  readonly kind: "model_output";
  readonly modelItem: ControllerModelItem;
}

export interface ActionRunItem extends RunItemBase {
  readonly kind: "action";
  readonly action: Action;
}

export interface ObservationRunItem extends RunItemBase {
  readonly kind: "observation";
  readonly observation: Observation;
}

export interface PlanCreatedRunItem extends RunItemBase {
  readonly kind: "plan_created";
  readonly plan: PlanProjection;
  readonly explanation: string | null;
}

export interface PlanUpdatedRunItem extends RunItemBase {
  readonly kind: "plan_updated";
  readonly previousVersion: number;
  readonly plan: PlanProjection;
  readonly transition: "updated" | "reactivated";
  readonly explanation: string | null;
}

export interface PlanCompletedRunItem extends RunItemBase {
  readonly kind: "plan_completed";
  readonly plan: PlanProjection;
}

export interface PlanAbandonedRunItem extends RunItemBase {
  readonly kind: "plan_abandoned";
  readonly plan: PlanProjection;
  readonly terminalStatus: "succeeded" | "blocked" | "failed" | "cancelled";
  readonly reasonCode: string | null;
}

export interface FinalOutputRunItem<TOutput = unknown> extends RunItemBase {
  readonly kind: "final_output";
  readonly output: TOutput;
}

export interface StopRunItem extends RunItemBase {
  readonly kind: "stop";
  readonly reason: string;
}

export interface RunCancellationRequestedRunItem extends RunItemBase {
  readonly kind: "run_cancellation_requested";
  readonly request: RunCancellationSummary;
}

export interface RunBlockedRunItem extends RunItemBase {
  readonly kind: "run_blocked";
  readonly code: RunBlockedCode;
}

export interface RunFailedRunItem extends RunItemBase {
  readonly kind: "run_failed";
  readonly code: RunFailureCode;
  readonly errors: readonly [RuntimeError, ...RuntimeError[]];
}

export interface RunCancelledRunItem extends RunItemBase {
  readonly kind: "run_cancelled";
  readonly cancellation: RunCancellationSummary;
  readonly completedAt: ISODateTimeString;
}

export type RunItem<TOutput = unknown> =
  | ModelOutputRunItem
  | ActionRunItem
  | ObservationRunItem
  | PlanCreatedRunItem
  | PlanUpdatedRunItem
  | PlanCompletedRunItem
  | PlanAbandonedRunItem
  | FinalOutputRunItem<TOutput>
  | StopRunItem
  | RunCancellationRequestedRunItem
  | RunBlockedRunItem
  | RunFailedRunItem
  | RunCancelledRunItem;
