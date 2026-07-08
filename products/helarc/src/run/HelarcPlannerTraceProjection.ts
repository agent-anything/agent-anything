import type {
  Planner,
  PlannerInput,
  PlanStep,
  RuntimeEvent,
} from "@agent-anything/agent-core";
import type { Metadata } from "@agent-anything/shared";

export class HelarcTracingPlanner implements Planner {
  constructor(
    private readonly inner: Planner,
    private readonly traceByPlanStepId: Map<string, Metadata>,
  ) {}

  async plan(input: PlannerInput): Promise<PlanStep> {
    const step = await this.inner.plan(input);
    this.traceByPlanStepId.set(step.id, selectPlannerTraceMetadata(step.metadata));
    return step;
  }
}

export function enrichRuntimeEventWithPlannerTrace(
  event: RuntimeEvent,
  traceByPlanStepId: Map<string, Metadata>,
): RuntimeEvent {
  if (event.name !== "plan.created" || !isRecord(event.payload)) {
    return event;
  }

  const planStepId = readTraceString(event.payload.planStepId);
  if (!planStepId) {
    return event;
  }

  const trace = traceByPlanStepId.get(planStepId);
  if (!trace) {
    return event;
  }

  return {
    ...event,
    payload: {
      ...event.payload,
      ...trace,
    },
  };
}

function selectPlannerTraceMetadata(source: Metadata): Metadata {
  const metadata: Metadata = {};

  copyString(metadata, source, "source");
  copyString(metadata, source, "plannerAction");
  copyString(metadata, source, "promptArchitectureVersion");
  copyString(metadata, source, "actionContractVersion");
  copyString(metadata, source, "toolCatalogVersion");
  copyStringArray(metadata, source, "exposedToolNames");
  copyString(metadata, source, "requestedToolName");
  copyString(metadata, source, "patchOperation");
  copyString(metadata, source, "patchPath");

  return metadata;
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

function readTraceStringArray(value: unknown): string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value
    : [];
}

function isRecord(value: unknown): value is Metadata {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
