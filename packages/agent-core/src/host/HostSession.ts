import type { PermissionRequest } from "@agent-anything/permission";
import type { ISODateTimeString, Metadata } from "@agent-anything/shared";
import type { Agent } from "../agent/index.js";
import type {
  BlockedRunResult,
  CancelledRunResult,
  FailedRunResult,
  RunCancellationRequest,
  RunConfig,
  RunInput,
  RunResult,
  SucceededRunResult,
} from "../runner/index.js";

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
  readonly sessionId: HostSessionId;
  readonly status: HostSessionStatus;
  readonly timestamp: ISODateTimeString;
  readonly metadata: Metadata;
}

export interface HostSessionCreated extends HostSessionStateBase {
  readonly status: "created";
}

export interface HostSessionRunning extends HostSessionStateBase {
  readonly status: "running";
  readonly taskId: string;
  readonly runId: string;
}

export interface HostSessionWaitingForPermission extends HostSessionStateBase {
  readonly status: "waiting_for_permission";
  readonly taskId: string;
  readonly runId: string;
  readonly permissionRequest: PermissionRequest;
}

export interface HostSessionCancelling extends HostSessionStateBase {
  readonly status: "cancelling";
  readonly taskId: string;
  readonly runId: string;
  readonly cancellationRequest: RunCancellationRequest;
}

export interface HostSessionCompleted<TOutput = unknown> extends HostSessionStateBase {
  readonly status: "completed";
  readonly taskId: string;
  readonly runId: string;
  readonly runResult: SucceededRunResult<TOutput>;
}

export interface HostSessionBlocked<TOutput = unknown> extends HostSessionStateBase {
  readonly status: "blocked";
  readonly taskId: string;
  readonly runId: string;
  readonly runResult: BlockedRunResult<TOutput>;
}

export interface HostSessionFailed<TOutput = unknown> extends HostSessionStateBase {
  readonly status: "failed";
  readonly taskId: string;
  readonly runId: string;
  readonly runResult: FailedRunResult<TOutput>;
  readonly errors: FailedRunResult<TOutput>["errors"];
}

export interface HostSessionCancelled<TOutput = unknown> extends HostSessionStateBase {
  readonly status: "cancelled";
  readonly taskId: string;
  readonly runId: string;
  readonly runResult: CancelledRunResult<TOutput>;
}

export type HostSessionState<TOutput = unknown> =
  | HostSessionCreated
  | HostSessionRunning
  | HostSessionWaitingForPermission
  | HostSessionCancelling
  | HostSessionCompleted<TOutput>
  | HostSessionBlocked<TOutput>
  | HostSessionFailed<TOutput>
  | HostSessionCancelled<TOutput>;

export interface HostSession<TOutput = unknown> {
  readonly id: HostSessionId;
  readonly state: HostSessionState<TOutput>;
  readonly metadata: Metadata;
}

export interface HostRunInput<TOutput = unknown> {
  readonly sessionId: HostSessionId;
  readonly agent: Agent<TOutput>;
  readonly runInput: RunInput;
  readonly runConfig: RunConfig;
  readonly metadata: Metadata;
}

export type HostTerminalSessionState<TOutput = unknown> =
  | HostSessionCompleted<TOutput>
  | HostSessionBlocked<TOutput>
  | HostSessionFailed<TOutput>
  | HostSessionCancelled<TOutput>;

export interface HostRunResult<TOutput = unknown> {
  readonly sessionId: HostSessionId;
  readonly taskId: string;
  readonly runId: string;
  readonly state: HostTerminalSessionState<TOutput>;
  readonly runResult: RunResult<TOutput>;
  readonly metadata: Metadata;
}
