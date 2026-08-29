
import type { RuntimeEvent } from "@agent-anything/observability/events";
import { createControllerTurnTraceOperationId } from "@agent-anything/observability/tracing";
import type { Controller, ControllerCallContext, ControllerDecision, ControllerInput } from "@agent-anything/agent-runtime/controller";

export interface HelarcControllerTraceProjection {
  readonly runId: string;
  readonly operationId: string;
  readonly iteration: number;
  readonly source: string | null;
  readonly controllerProtocol: string | null;
  readonly promptArchitectureVersion: string | null;
  readonly toolExposureVersion: string | null;
  readonly toolSelectionRevision: string | null;
  readonly toolExposureContentRevision: string | null;
  readonly toolExposureBasisRevision: string | null;
  readonly toolExposureProofId: string | null;
  readonly modelCallableCatalogRevision: string | null;
  readonly modelCallableDefinitionsDigest: string | null;
  readonly toolGuidanceId: string | null;
  readonly toolGuidanceContentDigest: string | null;
  readonly controllerControlGuidanceRevision: string | null;
  readonly modelUseDispositionStatus: string | null;
  readonly modelQualificationPolicy: string | null;
  readonly modelQualificationScopes: readonly string[];
  readonly modelQualificationReasons: readonly string[];
  readonly modelTurnId: string | null;
  readonly modelFinishKind: string | null;
  readonly modelResponseId: string | null;
  readonly exposedToolCount: number | null;
  readonly omittedToolCount: number | null;
  readonly toolExposureOmissionReasons: readonly string[];
  readonly instructionBindingId: string | null;
  readonly instructionBindingRevision: string | null;
  readonly instructionBindingEffectiveFromRunRevision: number | null;
  readonly instructionBindingSupersedesId: string | null;
  readonly instructionBindingSupersedesRevision: string | null;
  readonly agentId: string | null;
  readonly agentRevision: string | null;
  readonly agentInstructionsId: string | null;
  readonly agentInstructionsRevision: string | null;
  readonly agentInstructionReleaseId: string | null;
  readonly agentInstructionReleaseRevision: string | null;
  readonly agentInstructionResolverRevision: string | null;
  readonly agentInstructionContentDigest: string | null;
  readonly agentInstructionBlockCount: number | null;
  readonly agentInstructionProviderId: string | null;
  readonly agentInstructionModelId: string | null;
}

export class HelarcTracingController<TOutput = unknown> implements Controller<TOutput> {
  constructor(
    private readonly inner: Controller<TOutput>,
    private readonly traceByOperationId: Map<
      string,
      HelarcControllerTraceProjection
    >,
  ) {}

  get resourceMetering(): Controller<TOutput>["resourceMetering"] {
    return this.inner.resourceMetering;
  }

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
  source: Readonly<Record<string, unknown>>,
): HelarcControllerTraceProjection {
  return Object.freeze({
    runId,
    operationId,
    iteration,
    source: readTraceString(source.source),
    controllerProtocol: readTraceString(source.controllerProtocol),
    promptArchitectureVersion: readTraceString(source.promptArchitectureVersion),
    toolExposureVersion: readTraceString(source.toolExposureVersion),
    toolSelectionRevision: readTraceString(source.toolSelectionRevision),
    toolExposureContentRevision: readTraceString(source.toolExposureContentRevision),
    toolExposureBasisRevision: readTraceString(source.toolExposureBasisRevision),
    toolExposureProofId: readTraceString(source.toolExposureProofId),
    modelCallableCatalogRevision: readTraceString(source.modelCallableCatalogRevision),
    modelCallableDefinitionsDigest: readTraceString(source.modelCallableDefinitionsDigest),
    toolGuidanceId: readTraceString(source.toolGuidanceId),
    toolGuidanceContentDigest: readTraceString(source.toolGuidanceContentDigest),
    controllerControlGuidanceRevision: readTraceString(
      source.controllerControlGuidanceRevision,
    ),
    modelUseDispositionStatus: readTraceString(source.modelUseDispositionStatus),
    modelQualificationPolicy: readTraceString(source.modelQualificationPolicy),
    modelQualificationScopes: Object.freeze(
      readTraceStringArray(source.modelQualificationScopes),
    ),
    modelQualificationReasons: Object.freeze(
      readTraceStringArray(source.modelQualificationReasons),
    ),
    modelTurnId: readTraceString(source.modelTurnId),
    modelFinishKind: readTraceString(source.modelFinishKind),
    modelResponseId: readTraceString(source.modelResponseId),
    exposedToolCount: readTraceNonNegativeInteger(source.exposedToolCount),
    omittedToolCount: readTraceNonNegativeInteger(source.omittedToolCount),
    toolExposureOmissionReasons: Object.freeze(
      readTraceStringArray(source.toolExposureOmissionReasons),
    ),
    instructionBindingId: readTraceString(source.instructionBindingId),
    instructionBindingRevision: readTraceString(source.instructionBindingRevision),
    instructionBindingEffectiveFromRunRevision: readTraceNonNegativeInteger(
      source.instructionBindingEffectiveFromRunRevision,
    ),
    instructionBindingSupersedesId: readTraceString(source.instructionBindingSupersedesId),
    instructionBindingSupersedesRevision: readTraceString(
      source.instructionBindingSupersedesRevision,
    ),
    agentId: readTraceString(source.agentId),
    agentRevision: readTraceString(source.agentRevision),
    agentInstructionsId: readTraceString(source.agentInstructionsId),
    agentInstructionsRevision: readTraceString(source.agentInstructionsRevision),
    agentInstructionReleaseId: readTraceString(source.agentInstructionReleaseId),
    agentInstructionReleaseRevision: readTraceString(source.agentInstructionReleaseRevision),
    agentInstructionResolverRevision: readTraceString(source.agentInstructionResolverRevision),
    agentInstructionContentDigest: readTraceString(source.agentInstructionContentDigest),
    agentInstructionBlockCount: readTraceNonNegativeInteger(source.agentInstructionBlockCount),
    agentInstructionProviderId: readTraceString(source.agentInstructionProviderId),
    agentInstructionModelId: readTraceString(source.agentInstructionModelId),
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

function readTraceNonNegativeInteger(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) >= 0
    ? value as number
    : null;
}
