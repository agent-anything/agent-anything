import type { Metadata } from "@agent-anything/foundation";
import type { RuntimeEvent } from "@agent-anything/observability/events";
import { createControllerTurnTraceOperationId } from "@agent-anything/observability/tracing";
import type {
  Controller,
  ControllerCallContext,
  ControllerDecision,
  ControllerInput,
} from "@agent-anything/runtime/controller";

export interface HelarcControllerTraceProjection {
  readonly runId: string;
  readonly operationId: string;
  readonly iteration: number;
  readonly source: string | null;
  readonly controllerAction: string | null;
  readonly promptArchitectureVersion: string | null;
  readonly actionContractVersion: string | null;
  readonly toolCatalogVersion: string | null;
  readonly exposedToolNames: readonly string[];
  readonly requestedToolName: string | null;
  readonly patchOperation: string | null;
  readonly patchPath: string | null;
}

export class HelarcTracingController<TOutput = unknown> implements Controller<TOutput> {
  constructor(
    private readonly inner: Controller<TOutput>,
    private readonly traceByOperationId: Map<
      string,
      HelarcControllerTraceProjection
    >,
  ) {}

  async next(
    input: ControllerInput<TOutput>,
    context: ControllerCallContext,
  ): Promise<ControllerDecision<TOutput>> {
    const decision = await this.inner.next(input, context);
    const metadata = decision.modelItems[0]?.metadata ?? {};
    const operationId = createControllerTurnTraceOperationId(input.iteration);
    this.traceByOperationId.set(
      operationId,
      createHelarcControllerTraceProjection(
        input.runId,
        operationId,
        input.iteration,
        metadata,
      ),
    );
    return decision;
  }
}

export function projectHelarcControllerTraceForEvent(
  event: RuntimeEvent,
  traceByOperationId: ReadonlyMap<string, HelarcControllerTraceProjection>,
): HelarcControllerTraceProjection | null {
  if (event.name !== "controller.finished") {
    return null;
  }
  const operationId = createControllerTurnTraceOperationId(
    event.payload.iteration,
  );
  const trace = traceByOperationId.get(operationId) ?? null;
  return trace?.runId === event.runId && trace.operationId === operationId
    ? trace
    : null;
}

function createHelarcControllerTraceProjection(
  runId: string,
  operationId: string,
  iteration: number,
  source: Metadata,
): HelarcControllerTraceProjection {
  return Object.freeze({
    runId,
    operationId,
    iteration,
    source: readTraceString(source.source),
    controllerAction: readTraceString(source.controllerAction),
    promptArchitectureVersion: readTraceString(source.promptArchitectureVersion),
    actionContractVersion: readTraceString(source.actionContractVersion),
    toolCatalogVersion: readTraceString(source.toolCatalogVersion),
    exposedToolNames: Object.freeze(readTraceStringArray(source.exposedToolNames)),
    requestedToolName: readTraceString(source.requestedToolName),
    patchOperation: readTraceString(source.patchOperation),
    patchPath: readTraceString(source.patchPath),
  });
}

function readTraceString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readTraceStringArray(value: unknown): string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? [...value]
    : [];
}
