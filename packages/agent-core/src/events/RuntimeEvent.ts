import type { ISODateTimeString, Metadata } from "@agent-anything/shared";

export type RuntimeEventName =
  | "run.started"
  | "run.item.appended"
  | "run.completed"
  | "run.blocked"
  | "run.failed"
  | "run.cancelled"
  | "controller.started"
  | "controller.finished"
  | "task.started"
  | "task.completed"
  | "task.failed"
  | "loop.iteration.started"
  | "loop.iteration.finished"
  | "planner.started"
  | "planner.finished"
  | "plan.created"
  | "plan.updated"
  | "plan.completed"
  | "plan.abandoned"
  | "action.prepared"
  | "action.assessed"
  | "action.invalidated"
  | "approval.requested"
  | "approval.resolved"
  | "sandbox.attempt.started"
  | "sandbox.attempt.resolved"
  | "sandbox.escalation.proposed"
  | "tool.started"
  | "tool.finished"
  | "observation.created"
  | "context.updated"
  | "evidence.created"
  | "retry.attempt.started"
  | "retry.attempt.finished"
  | "retry.scheduled"
  | "retry.fallback.selected"
  | "retry.exhausted"
  | "retry.cancelled";

export interface RuntimeEvent<TPayload = Metadata> {
  id: string;
  name: RuntimeEventName;
  taskId: string;
  sequence: number;
  timestamp: ISODateTimeString;
  payload: TPayload;
}

export interface EmitRuntimeEventInput<TPayload = Metadata> {
  name: RuntimeEventName;
  taskId: string;
  payload?: TPayload;
  timestamp?: ISODateTimeString;
  id?: string;
}
