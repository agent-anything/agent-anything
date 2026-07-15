import type { ISODateTimeString, Metadata } from "@agent-anything/shared";
import type { RuntimeEvent } from "../events/index.js";
import type {
  BlockedRunResult,
  CancelledRunResult,
  FailedRunResult,
  SucceededRunResult,
} from "../runner/index.js";
import type { HostSessionId, HostSessionState } from "./HostSession.js";
import { projectRuntimeEventForHost } from "./HostRuntimeProjection.js";

export type HostEventName =
  | "host.session.created"
  | "host.session.started"
  | "host.session.state_changed"
  | "host.runtime.event"
  | "host.output.produced"
  | "host.session.completed"
  | "host.session.blocked"
  | "host.session.failed"
  | "host.session.cancelled";

export interface HostEventBase<TName extends HostEventName, TPayload = Metadata> {
  readonly id: string;
  readonly name: TName;
  readonly sessionId: HostSessionId;
  readonly taskId?: string;
  readonly sequence: number;
  readonly timestamp: ISODateTimeString;
  readonly payload: TPayload;
  readonly metadata: Metadata;
}

export type HostSessionCreatedEvent = HostEventBase<
  "host.session.created",
  { readonly state: HostSessionState }
>;

export type HostSessionStartedEvent = HostEventBase<
  "host.session.started",
  { readonly state: HostSessionState }
>;

export type HostSessionStateChangedEvent<TOutput = unknown> = HostEventBase<
  "host.session.state_changed",
  { readonly state: HostSessionState<TOutput> }
>;

export type HostRuntimeEvent = HostEventBase<
  "host.runtime.event",
  { readonly runtimeEvent: RuntimeEvent }
>;

export type HostOutputProducedEvent<TOutput = unknown> = HostEventBase<
  "host.output.produced",
  { readonly runResult: SucceededRunResult<TOutput> }
>;

export type HostSessionCompletedEvent<TOutput = unknown> = HostEventBase<
  "host.session.completed",
  { readonly runResult: SucceededRunResult<TOutput> }
>;

export type HostSessionBlockedEvent<TOutput = unknown> = HostEventBase<
  "host.session.blocked",
  { readonly runResult: BlockedRunResult<TOutput> }
>;

export type HostSessionFailedEvent<TOutput = unknown> = HostEventBase<
  "host.session.failed",
  { readonly runResult: FailedRunResult<TOutput> }
>;

export type HostSessionCancelledEvent<TOutput = unknown> = HostEventBase<
  "host.session.cancelled",
  { readonly runResult: CancelledRunResult<TOutput> }
>;

export type HostEvent<TOutput = unknown> =
  | HostSessionCreatedEvent
  | HostSessionStartedEvent
  | HostSessionStateChangedEvent<TOutput>
  | HostRuntimeEvent
  | HostOutputProducedEvent<TOutput>
  | HostSessionCompletedEvent<TOutput>
  | HostSessionBlockedEvent<TOutput>
  | HostSessionFailedEvent<TOutput>
  | HostSessionCancelledEvent<TOutput>;

export type HostEventSink<TOutput = unknown> = (
  event: HostEvent<TOutput>,
) => void | Promise<void>;

export interface CreateHostEventInput<TName extends HostEventName, TPayload = Metadata> {
  readonly name: TName;
  readonly sessionId: HostSessionId;
  readonly payload: TPayload;
  readonly taskId?: string;
  readonly sequence?: number;
  readonly timestamp?: ISODateTimeString;
  readonly id?: string;
  readonly metadata?: Metadata;
}

export function createHostEvent<TName extends HostEventName, TPayload = Metadata>(
  input: CreateHostEventInput<TName, TPayload>,
): HostEventBase<TName, TPayload> {
  const sequence = input.sequence ?? 0;

  return Object.freeze({
    id: input.id ?? `host_event_${sequence}`,
    name: input.name,
    sessionId: input.sessionId,
    ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
    sequence,
    timestamp: input.timestamp ?? new Date().toISOString(),
    payload: input.payload,
    metadata: Object.freeze({ ...(input.metadata ?? {}) }),
  });
}

export interface MapRuntimeEventToHostEventInput {
  readonly sessionId: HostSessionId;
  readonly runtimeEvent: RuntimeEvent;
  readonly sequence?: number;
  readonly metadata?: Metadata;
}

export function mapRuntimeEventToHostEvent(
  input: MapRuntimeEventToHostEventInput,
): HostRuntimeEvent {
  const runtimeEvent = projectRuntimeEventForHost(input.runtimeEvent);
  return createHostEvent({
    id: `host_${runtimeEvent.id}`,
    name: "host.runtime.event",
    sessionId: input.sessionId,
    taskId: runtimeEvent.taskId,
    sequence: input.sequence ?? runtimeEvent.sequence,
    timestamp: runtimeEvent.timestamp,
    payload: Object.freeze({
      runtimeEvent,
    }),
    metadata: input.metadata ?? {},
  });
}
