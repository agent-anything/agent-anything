import type {
  EmitRuntimeEventInput,
  RuntimeEvent,
} from "./RuntimeEvent.js";

export type RuntimeEventSubscriber = (event: RuntimeEvent) => void;

export interface RuntimeEventPublisher {
  emit(input: EmitRuntimeEventInput): void;
}

export class RuntimeEventEmitter implements RuntimeEventPublisher {
  private readonly subscribers = new Set<RuntimeEventSubscriber>();
  private sequence = 0;

  subscribe(subscriber: RuntimeEventSubscriber): () => void {
    this.subscribers.add(subscriber);

    return () => {
      this.subscribers.delete(subscriber);
    };
  }

  emit(input: EmitRuntimeEventInput): RuntimeEvent {
    this.sequence += 1;

    const event: RuntimeEvent = {
      id: input.id ?? `runtime_event_${this.sequence}`,
      name: input.name,
      taskId: input.taskId,
      sequence: this.sequence,
      timestamp: input.timestamp ?? new Date().toISOString(),
      payload: input.payload ?? {},
    };

    for (const subscriber of this.subscribers) {
      subscriber(event);
    }

    return event;
  }
}
