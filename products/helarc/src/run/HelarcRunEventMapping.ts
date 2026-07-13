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
    case "run.started":
      return "run.started";
    case "run.completed":
      return "run.completed";
    case "run.blocked":
    case "run.failed":
      return "run.failed";
    case "run.cancelled":
      return "run.cancelled";
    case "controller.started":
      return "planning.started";
    case "controller.finished":
      return "provider.output";
    case "run.item.appended":
      return "runtime.output";
    case "permission.requested":
      return "permission.requested";
    case "permission.resolved":
      return "permission.resolved";
    case "tool.started":
      return "tool.started";
    case "tool.finished":
      return "tool.completed";
    default:
      return "runtime.output";
  }
}

function titleForEvent(name: RuntimeEventName, payload: Metadata): string {
  switch (name) {
    case "run.started":
      return "Run started";
    case "run.completed":
      return "Run completed";
    case "run.blocked":
      return "Run blocked";
    case "run.failed":
      return "Run failed";
    case "run.cancelled":
      return "Run cancelled";
    case "controller.started":
      return `Controller iteration ${readNumber(payload, "iteration") ?? ""} started`.trim();
    case "controller.finished":
      return `Controller ${readString(payload, "status") ?? "finished"}`;
    case "run.item.appended":
      return `Run item appended: ${readString(payload, "itemKind") ?? "unknown"}`;
    case "permission.requested":
      return `Permission requested: ${readString(payload, "toolName") ?? "tool"}`;
    case "permission.resolved":
      return `Permission ${readString(payload, "decision") ?? "resolved"}`;
    case "tool.started":
      return `Tool started: ${readString(payload, "toolName") ?? "unknown"}`;
    case "tool.finished":
      return `Tool ${readString(payload, "status") ?? "finished"}: ${readString(payload, "toolName") ?? "unknown"}`;
    default:
      return name;
  }
}

function detailForEvent(name: RuntimeEventName, payload: Metadata): string | null {
  if (name === "tool.started" || name === "tool.finished") {
    return readString(payload, "actionId");
  }

  if (name === "controller.finished") {
    return detailForControllerFinished(payload);
  }

  if (name === "permission.requested" || name === "permission.resolved") {
    return readString(payload, "requestId") ?? readString(payload, "permissionRequestId");
  }

  if (name === "run.item.appended") {
    return readString(payload, "itemId");
  }

  return null;
}

function detailForControllerFinished(payload: Metadata): string | null {
  const code = readString(payload, "code");
  if (code) {
    return code;
  }

  const controllerAction = readString(payload, "controllerAction");
  if (controllerAction === "call_tool") {
    return readString(payload, "requestedToolName");
  }

  if (controllerAction === "propose") {
    const operation = readString(payload, "patchOperation");
    const path = readString(payload, "patchPath");
    if (operation && path) {
      return `${operation} ${path}`;
    }
  }

  return controllerAction;
}

function severityForEvent(
  name: RuntimeEventName,
  payload: Metadata,
): HelarcRunEventSeverity {
  const status = readString(payload, "status");
  const decision = readString(payload, "decision");

  if (
    name === "run.failed" ||
    name === "run.blocked" ||
    status === "failed" ||
    status === "blocked" ||
    decision === "denied"
  ) {
    return "error";
  }

  if (name === "run.cancelled" || status === "stopped" || decision === "review") {
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
  copyString(metadata, payload, "runId");
  copyString(metadata, payload, "status");
  copyString(metadata, payload, "code");
  copyString(metadata, payload, "decisionKind");
  copyString(metadata, payload, "itemId");
  copyString(metadata, payload, "itemKind");
  copyNumber(metadata, payload, "itemSequence");
  copyString(metadata, payload, "controllerAction");
  copyString(metadata, payload, "promptArchitectureVersion");
  copyString(metadata, payload, "actionContractVersion");
  copyString(metadata, payload, "toolCatalogVersion");
  copyStringArray(metadata, payload, "exposedToolNames");
  copyString(metadata, payload, "requestedToolName");
  copyString(metadata, payload, "patchOperation");
  copyString(metadata, payload, "patchPath");
  copyString(metadata, payload, "actionId");
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
