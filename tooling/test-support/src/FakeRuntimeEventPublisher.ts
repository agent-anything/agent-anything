import type {
  RuntimeEvent,
  RuntimeEventPublisher,
  RuntimeEventSubscriber,
} from "@agent-anything/observability/events";

export class FakeRuntimeEventPublisher implements RuntimeEventPublisher {
  private readonly recordedEvents: RuntimeEvent[] = [];
  private readonly subscribers = new Set<RuntimeEventSubscriber>();

  publish(event: RuntimeEvent): void {
    this.recordedEvents.push(event);
    for (const subscriber of this.subscribers) {
      subscriber(event);
    }
  }

  subscribe(subscriber: RuntimeEventSubscriber): () => void {
    this.subscribers.add(subscriber);
    return () => {
      this.subscribers.delete(subscriber);
    };
  }

  events(): readonly RuntimeEvent[] {
    return Object.freeze([...this.recordedEvents]);
  }

  names(): readonly RuntimeEvent["name"][] {
    return Object.freeze(this.recordedEvents.map((event) => event.name));
  }

  clear(): void {
    this.recordedEvents.length = 0;
  }
}
