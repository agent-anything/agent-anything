import type { ISODateTimeString } from "@agent-anything/foundation";
import type {
  RuntimeEventName,
  RuntimeEventPayloadMap,
} from "./RuntimeEventPayload.js";

export const RUNTIME_EVENT_SCHEMA_VERSION = 1 as const;

export interface RuntimeEventEnvelope<TName extends RuntimeEventName> {
  readonly schemaVersion: typeof RUNTIME_EVENT_SCHEMA_VERSION;
  readonly id: string;
  readonly runId: string;
  readonly taskId: string;
  readonly sequence: number;
  readonly name: TName;
  readonly occurredAt: ISODateTimeString;
  readonly payload: RuntimeEventPayloadMap[TName];
}

export type RuntimeEvent<
  TName extends RuntimeEventName = RuntimeEventName,
> = {
  readonly [K in TName]: RuntimeEventEnvelope<K>;
}[TName];

export interface RuntimeEventPublisher {
  publish(event: RuntimeEvent): void;
}

export type RuntimeEventSubscriber = (event: RuntimeEvent) => void;
