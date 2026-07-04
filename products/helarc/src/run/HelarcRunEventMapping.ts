import type { RuntimeEvent, RuntimeEventName } from "@agent-anything/agent-core";
import type { Metadata } from "@agent-anything/shared";
import type {
  HelarcRunEventKind,
  HelarcRunEventSeverity,
  HelarcRunEventViewModel,
} from "./HelarcRun.js";

export function mapRuntimeEventToHelarcRunEvent(
  event: RuntimeEvent,
): HelarcRunEventViewModel {
  const payload = isRecord(event.payload) ? event.payload : {};

  return {
    id: event.id,
    sequence: event.sequence,
    timestamp: event.timestamp,
    kind: kindForEvent(event.name, payload),
    title: titleForEvent(event.name, payload),
    detail: detailForEvent(event.name, payload),
    severity: severityForEvent(event.name, payload),
    metadata: metadataForEvent(event, payload),
  };
}

function kindForEvent(
  name: RuntimeEventName,
  payload: Metadata,
): HelarcRunEventKind {
  switch (name) {
    case "task.started":
      return "run.started";
    case "task.completed":
      return "run.completed";
    case "task.failed":
      return "run.failed";
    case "planner.started":
    case "loop.iteration.started":
      return "planning.started";
    case "planner.finished":
      return "provider.output";
    case "plan.created":
      return payload.planStepKind === "callTool" ? "tool.proposed" : "runtime.output";
    case "permission.requested":
      return "permission.requested";
    case "permission.resolved":
      return "permission.resolved";
    case "tool.started":
      return "tool.started";
    case "tool.finished":
      return "tool.completed";
    case "loop.iteration.finished":
    case "observation.created":
    case "context.updated":
    case "evidence.created":
      return "runtime.output";
  }
}

function titleForEvent(name: RuntimeEventName, payload: Metadata): string {
  switch (name) {
    case "task.started":
      return "Run started";
    case "task.completed":
      return "Run completed";
    case "task.failed":
      return "Run failed";
    case "loop.iteration.started":
      return `Iteration ${readNumber(payload, "iteration") ?? ""} started`.trim();
    case "loop.iteration.finished":
      return `Iteration ${readString(payload, "status") ?? "finished"}`;
    case "planner.started":
      return "Planning started";
    case "planner.finished":
      return `Planning ${readString(payload, "status") ?? "finished"}`;
    case "plan.created":
      return titleForPlanCreated(payload);
    case "permission.requested":
      return `Permission requested: ${readString(payload, "toolName") ?? "tool"}`;
    case "permission.resolved":
      return `Permission ${readString(payload, "decision") ?? "resolved"}`;
    case "tool.started":
      return `Tool started: ${readString(payload, "toolName") ?? "unknown"}`;
    case "tool.finished":
      return `Tool ${readString(payload, "status") ?? "finished"}: ${readString(payload, "toolName") ?? "unknown"}`;
    case "observation.created":
      return "Observation created";
    case "context.updated":
      return "Context updated";
    case "evidence.created":
      return "Evidence created";
  }
}

function titleForPlanCreated(payload: Metadata): string {
  const kind = readString(payload, "planStepKind");
  if (kind === "callTool") {
    return "Tool call proposed";
  }

  if (kind === "final") {
    return "Final output proposed";
  }

  if (kind === "stop") {
    return "Stop proposed";
  }

  return "Plan created";
}

function detailForEvent(name: RuntimeEventName, payload: Metadata): string | null {
  if (name === "tool.started" || name === "tool.finished") {
    return readString(payload, "toolCallId");
  }

  if (name === "plan.created") {
    return readString(payload, "planStepId");
  }

  if (name === "permission.requested" || name === "permission.resolved") {
    return readString(payload, "requestId") ?? readString(payload, "permissionRequestId");
  }

  if (name === "planner.finished" || name === "task.failed") {
    return readString(payload, "errorCode");
  }

  if (name === "observation.created" || name === "context.updated") {
    return readString(payload, "observationId");
  }

  if (name === "evidence.created") {
    return readString(payload, "evidenceId");
  }

  return null;
}

function severityForEvent(
  name: RuntimeEventName,
  payload: Metadata,
): HelarcRunEventSeverity {
  const status = readString(payload, "status");
  const decision = readString(payload, "decision");

  if (
    name === "task.failed" ||
    status === "failed" ||
    status === "blocked" ||
    decision === "denied"
  ) {
    return "error";
  }

  if (status === "stopped" || decision === "review") {
    return "warning";
  }

  return "info";
}

function metadataForEvent(event: RuntimeEvent, payload: Metadata): Metadata {
  const metadata: Metadata = {
    runtimeEventName: event.name,
    taskId: event.taskId,
  };

  copyNumber(metadata, payload, "iteration");
  copyString(metadata, payload, "status");
  copyString(metadata, payload, "errorCode");
  copyString(metadata, payload, "planStepId");
  copyString(metadata, payload, "planStepKind");
  copyString(metadata, payload, "toolCallId");
  copyString(metadata, payload, "toolName");
  copyString(metadata, payload, "toolResultStatus");
  copyString(metadata, payload, "requestId");
  copyString(metadata, payload, "permissionRequestId");
  copyString(metadata, payload, "decision");
  copyString(metadata, payload, "riskLevel");
  copyString(metadata, payload, "observationId");
  copyStringArray(metadata, payload, "evidenceRefs");
  copyString(metadata, payload, "evidenceId");
  copyNumber(metadata, payload, "durationMs");
  copyNumber(metadata, payload, "evidenceCount");
  copyNumber(metadata, payload, "artifactCount");
  copyStringArray(metadata, payload, "errorCodes");

  return metadata;
}

function copyString(target: Metadata, source: Metadata, key: string): void {
  const value = readString(source, key);
  if (value !== null) {
    target[key] = value;
  }
}

function copyNumber(target: Metadata, source: Metadata, key: string): void {
  const value = readNumber(source, key);
  if (value !== null) {
    target[key] = value;
  }
}

function copyStringArray(target: Metadata, source: Metadata, key: string): void {
  const value = readStringArray(source, key);
  if (value !== null) {
    target[key] = value;
  }
}

function readString(source: Metadata, key: string): string | null {
  const value = source[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readNumber(source: Metadata, key: string): number | null {
  const value = source[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readStringArray(source: Metadata, key: string): string[] | null {
  const value = source[key];
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    return null;
  }

  return [...value];
}

function isRecord(value: unknown): value is Metadata {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
