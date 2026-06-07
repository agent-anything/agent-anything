import type { RuntimeEvent } from "./RuntimeEvent.js";
import { RuntimeEventEmitter } from "./RuntimeEventEmitter.js";

export class RuntimeEventRecorder {
  private readonly recordedEvents: RuntimeEvent[] = [];

  record(event: RuntimeEvent): void {
    this.recordedEvents.push(event);
  }

  attachTo(emitter: RuntimeEventEmitter): () => void {
    return emitter.subscribe((event) => {
      this.record(event);
    });
  }

  events(): RuntimeEvent[] {
    return this.recordedEvents.map((event) => ({
      ...event,
      payload: clonePayload(event.payload),
    }));
  }

  names(): string[] {
    return this.recordedEvents.map((event) => event.name);
  }

  clear(): void {
    this.recordedEvents.length = 0;
  }
}

function clonePayload<TPayload>(payload: TPayload): TPayload {
  if (typeof structuredClone === "function") {
    return structuredClone(payload);
  }

  return JSON.parse(JSON.stringify(payload)) as TPayload;
}
