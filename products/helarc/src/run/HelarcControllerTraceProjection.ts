import type {
  Controller,
  ControllerCallContext,
  ControllerDecision,
  ControllerInput,
  RuntimeEvent,
} from "@agent-anything/agent-core";
import type { Metadata } from "@agent-anything/shared";

export class HelarcTracingController<TOutput = unknown> implements Controller<TOutput> {
  constructor(
    private readonly inner: Controller<TOutput>,
    private readonly traceByIteration: Map<number, Metadata>,
  ) {}

  async next(
    input: ControllerInput<TOutput>,
    context: ControllerCallContext,
  ): Promise<ControllerDecision<TOutput>> {
    const decision = await this.inner.next(input, context);
    const metadata = decision.modelItems[0]?.metadata ?? {};
    this.traceByIteration.set(input.iteration, selectControllerTraceMetadata(metadata));
    return decision;
  }
}

export function enrichRuntimeEventWithControllerTrace(
  event: RuntimeEvent,
  traceByIteration: ReadonlyMap<number, Metadata>,
): RuntimeEvent {
  if (event.name !== "controller.finished" || !isRecord(event.payload)) {
    return event;
  }

  const iteration = readTraceNumber(event.payload.iteration);
  const trace = iteration === null ? undefined : traceByIteration.get(iteration);
  if (!trace) {
    return event;
  }

  return {
    ...event,
    payload: { ...event.payload, ...trace },
  };
}

function selectControllerTraceMetadata(source: Metadata): Metadata {
  const metadata: Metadata = {};

  copyString(metadata, source, "source");
  copyString(metadata, source, "controllerAction");
  copyString(metadata, source, "promptArchitectureVersion");
  copyString(metadata, source, "actionContractVersion");
  copyString(metadata, source, "toolCatalogVersion");
  copyStringArray(metadata, source, "exposedToolNames");
  copyString(metadata, source, "requestedToolName");
  copyString(metadata, source, "patchOperation");
  copyString(metadata, source, "patchPath");

  return Object.freeze(metadata);
}

function copyString(target: Metadata, source: Metadata, key: string): void {
  const value = readTraceString(source[key]);
  if (value) {
    target[key] = value;
  }
}

function copyStringArray(target: Metadata, source: Metadata, key: string): void {
  const value = readTraceStringArray(source[key]);
  if (value.length > 0) {
    target[key] = value;
  }
}

function readTraceString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readTraceNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : null;
}

function readTraceStringArray(value: unknown): string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? [...value]
    : [];
}

function isRecord(value: unknown): value is Metadata {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
