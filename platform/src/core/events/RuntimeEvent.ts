import type { ISODateTimeString, Metadata } from "@agent-anything/shared";

export type RuntimeEventName =
  | "task.started"
  | "task.completed"
  | "task.failed"
  | "loop.iteration.started"
  | "loop.iteration.finished"
  | "planner.started"
  | "planner.finished"
  | "plan.created"
  | "permission.requested"
  | "permission.resolved"
  | "tool.started"
  | "tool.finished"
  | "observation.created"
  | "context.updated"
  | "evidence.created";

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
