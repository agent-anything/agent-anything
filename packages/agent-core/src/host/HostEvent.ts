import type { RuntimeEvent } from "../events/index.js";
import type { RuntimeResult } from "../runtime/index.js";
import type { ISODateTimeString, Metadata } from "@agent-anything/shared";
import type { PermissionDecision, PermissionRequest } from "@agent-anything/permission";
import type {
  HostCancellation,
  HostSessionId,
  HostSessionState,
} from "./HostSession.js";

export type HostEventName =
  | "host.session.created"
  | "host.session.started"
  | "host.session.state_changed"
  | "host.runtime.event"
  | "host.permission.requested"
  | "host.permission.resolved"
  | "host.output.produced"
  | "host.session.completed"
  | "host.session.blocked"
  | "host.session.failed"
  | "host.session.cancelled";

export interface HostEventBase<TName extends HostEventName, TPayload = Metadata> {
  id: string;
  name: TName;
  sessionId: HostSessionId;
  taskId?: string;
  sequence: number;
  timestamp: ISODateTimeString;
  payload: TPayload;
  metadata: Metadata;
}

export type HostSessionCreatedEvent = HostEventBase<
  "host.session.created",
  { state: HostSessionState }
>;

export type HostSessionStartedEvent = HostEventBase<
  "host.session.started",
  { state: HostSessionState }
>;

export type HostSessionStateChangedEvent = HostEventBase<
  "host.session.state_changed",
  { state: HostSessionState }
>;

export type HostRuntimeEvent = HostEventBase<
  "host.runtime.event",
  { runtimeEvent: RuntimeEvent }
>;

export type HostPermissionRequestedEvent = HostEventBase<
  "host.permission.requested",
  { permissionRequest: PermissionRequest }
>;

export type HostPermissionResolvedEvent = HostEventBase<
  "host.permission.resolved",
  {
    permissionRequest: PermissionRequest;
    permissionDecision: PermissionDecision;
  }
>;

export type HostOutputProducedEvent<TOutput = unknown> = HostEventBase<
  "host.output.produced",
  { runtimeResult: RuntimeResult<TOutput> }
>;

export type HostSessionCompletedEvent<TOutput = unknown> = HostEventBase<
  "host.session.completed",
  { runtimeResult: RuntimeResult<TOutput> }
>;

export type HostSessionBlockedEvent<TOutput = unknown> = HostEventBase<
  "host.session.blocked",
  { runtimeResult: RuntimeResult<TOutput> }
>;

export type HostSessionFailedEvent = HostEventBase<
  "host.session.failed",
  { errors: RuntimeResult["errors"] }
>;

export type HostSessionCancelledEvent = HostEventBase<
  "host.session.cancelled",
  {
    cancellation: HostCancellation;
    runtimeResult?: RuntimeResult;
  }
>;

export type HostEvent<TOutput = unknown> =
  | HostSessionCreatedEvent
  | HostSessionStartedEvent
  | HostSessionStateChangedEvent
  | HostRuntimeEvent
  | HostPermissionRequestedEvent
  | HostPermissionResolvedEvent
  | HostOutputProducedEvent<TOutput>
  | HostSessionCompletedEvent<TOutput>
  | HostSessionBlockedEvent<TOutput>
  | HostSessionFailedEvent
  | HostSessionCancelledEvent;

export type HostEventSink<TOutput = unknown> = (event: HostEvent<TOutput>) => void | Promise<void>;

export interface CreateHostEventInput<TName extends HostEventName, TPayload = Metadata> {
  name: TName;
  sessionId: HostSessionId;
  payload: TPayload;
  taskId?: string;
  sequence?: number;
  timestamp?: ISODateTimeString;
  id?: string;
  metadata?: Metadata;
}

export function createHostEvent<TName extends HostEventName, TPayload = Metadata>(
  input: CreateHostEventInput<TName, TPayload>,
): HostEventBase<TName, TPayload> {
  const sequence = input.sequence ?? 0;

  return {
    id: input.id ?? `host_event_${sequence}`,
    name: input.name,
    sessionId: input.sessionId,
    taskId: input.taskId,
    sequence,
    timestamp: input.timestamp ?? new Date().toISOString(),
    payload: input.payload,
    metadata: input.metadata ?? {},
  };
}

export interface MapRuntimeEventToHostEventInput {
  sessionId: HostSessionId;
  runtimeEvent: RuntimeEvent;
  sequence?: number;
  metadata?: Metadata;
}

export function mapRuntimeEventToHostEvent(
  input: MapRuntimeEventToHostEventInput,
): HostRuntimeEvent {
  return createHostEvent({
    id: `host_${input.runtimeEvent.id}`,
    name: "host.runtime.event",
    sessionId: input.sessionId,
    taskId: input.runtimeEvent.taskId,
    sequence: input.sequence ?? input.runtimeEvent.sequence,
    timestamp: input.runtimeEvent.timestamp,
    payload: {
      runtimeEvent: input.runtimeEvent,
    },
    metadata: input.metadata ?? {},
  });
}
