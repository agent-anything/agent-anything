import type { IdentityRef, WorkspaceContext } from "@agent-anything/governance";
import type { PermissionRequest } from "@agent-anything/permission";
import type { ISODateTimeString, Metadata } from "@agent-anything/shared";
import type { AgentTask } from "../task/index.js";
import type { RuntimeError, RuntimeOptions, RuntimeResult } from "../runtime/index.js";

export type HostSessionId = string;

export type HostSessionStatus =
  | "created"
  | "running"
  | "waiting_for_permission"
  | "cancelling"
  | "completed"
  | "blocked"
  | "failed"
  | "cancelled";

export interface HostSessionStateBase {
  sessionId: HostSessionId;
  status: HostSessionStatus;
  timestamp: ISODateTimeString;
  metadata: Metadata;
}

export interface HostSessionCreated extends HostSessionStateBase {
  status: "created";
}

export interface HostSessionRunning extends HostSessionStateBase {
  status: "running";
  taskId: string;
}

export interface HostSessionWaitingForPermission extends HostSessionStateBase {
  status: "waiting_for_permission";
  taskId: string;
  permissionRequest: PermissionRequest;
}

export interface HostSessionCancelling extends HostSessionStateBase {
  status: "cancelling";
  taskId?: string;
  cancellation: HostCancellation;
}

export interface HostSessionCompleted<TOutput = unknown> extends HostSessionStateBase {
  status: "completed";
  taskId: string;
  runtimeResult: RuntimeResult<TOutput>;
}

export interface HostSessionBlocked<TOutput = unknown> extends HostSessionStateBase {
  status: "blocked";
  taskId: string;
  runtimeResult: RuntimeResult<TOutput>;
}

export interface HostSessionFailed extends HostSessionStateBase {
  status: "failed";
  taskId?: string;
  errors: RuntimeError[];
}

export interface HostSessionCancelled extends HostSessionStateBase {
  status: "cancelled";
  taskId?: string;
  cancellation: HostCancellation;
  runtimeResult?: RuntimeResult<unknown>;
}

export type HostSessionState<TOutput = unknown> =
  | HostSessionCreated
  | HostSessionRunning
  | HostSessionWaitingForPermission
  | HostSessionCancelling
  | HostSessionCompleted<TOutput>
  | HostSessionBlocked<TOutput>
  | HostSessionFailed
  | HostSessionCancelled;

export interface HostSession<TOutput = unknown> {
  id: HostSessionId;
  state: HostSessionState<TOutput>;
  metadata: Metadata;
}

export interface HostCancellation {
  requested: boolean;
  reason?: string;
  requestedAt?: ISODateTimeString;
  metadata: Metadata;
}

export interface HostRunInput<TTaskInput = unknown> {
  sessionId: HostSessionId;
  task: AgentTask<TTaskInput>;
  runtimeOptions: RuntimeOptions;
  workspace?: WorkspaceContext;
  identity?: IdentityRef;
  cancellation?: HostCancellation;
  metadata: Metadata;
}

export interface HostRunResult<TOutput = unknown> {
  sessionId: HostSessionId;
  taskId: string;
  state: HostSessionCompleted<TOutput> | HostSessionBlocked<TOutput> | HostSessionFailed | HostSessionCancelled;
  runtimeResult?: RuntimeResult<TOutput>;
  cancellation?: HostCancellation;
  metadata: Metadata;
}
