import type { RuntimeEvent, RuntimeEventName } from "@agent-anything/agent-core";
import { projectRuntimeEventForHost } from "@agent-anything/agent-core/host";
import type { Metadata } from "@agent-anything/shared";
import type {
  HelarcRunEventKind,
  HelarcRunEventSeverity,
  HelarcRunEventViewModel,
} from "./HelarcRun.js";
import type { HelarcActivityItem } from "../composition/HelarcProductResult.js";

export function mapRuntimeEventToHelarcRunEvent(
  event: RuntimeEvent,
): HelarcRunEventViewModel {
  const projectedEvent = projectRuntimeEventForHost(event);
  const payload = isRecord(projectedEvent.payload) ? projectedEvent.payload : {};

  return {
    id: projectedEvent.id,
    sequence: projectedEvent.sequence,
    timestamp: projectedEvent.timestamp,
    kind: kindForEvent(projectedEvent.name, payload),
    title: titleForEvent(projectedEvent.name, payload),
    detail: detailForEvent(projectedEvent.name, payload),
    severity: severityForEvent(projectedEvent.name, payload),
    metadata: metadataForEvent(projectedEvent, payload),
  };
}

export function mapHelarcActivityToRunEvent(
  activity: HelarcActivityItem,
): HelarcRunEventViewModel {
  const name = activity.kind as RuntimeEventName;
  return {
    id: activity.id,
    sequence: activity.sequence,
    timestamp: activity.timestamp,
    kind: kindForEvent(name, activity.metadata),
    title: activity.title,
    detail: activity.detail,
    severity: severityForEvent(name, activity.metadata),
    metadata: { ...activity.metadata },
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
    case "approval.requested":
      return "approval.requested";
    case "approval.resolved":
      return "approval.resolved";
    case "tool.started":
      return "tool.started";
    case "tool.finished":
      return "tool.completed";
    case "action.prepared":
      return "action.prepared";
    case "action.assessed":
      return "action.assessed";
    case "action.invalidated":
      return "action.invalidated";
    case "sandbox.attempt.started":
      return "sandbox.started";
    case "sandbox.attempt.resolved":
      return "sandbox.resolved";
    case "sandbox.escalation.proposed":
      return "sandbox.escalation";
    case "retry.attempt.started":
    case "retry.attempt.finished":
    case "retry.scheduled":
    case "retry.fallback.selected":
    case "retry.exhausted":
    case "retry.cancelled":
      return "retry.progress";
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
    case "approval.requested":
      return `Approval requested: ${readString(payload, "category") ?? "action"}`;
    case "approval.resolved":
      return `Approval ${readString(payload, "decisionKind") ?? readString(payload, "resolutionKind") ?? "resolved"}`;
    case "tool.started":
      return `Tool started: ${readString(payload, "toolName") ?? "unknown"}`;
    case "tool.finished":
      return `Tool ${readString(payload, "status") ?? "finished"}: ${readString(payload, "toolName") ?? "unknown"}`;
    case "action.prepared":
      return "Action prepared";
    case "action.assessed":
      return `Action ${readString(payload, "status") ?? "assessed"}`;
    case "action.invalidated":
      return "Action invalidated";
    case "sandbox.attempt.started":
      return readString(payload, "enforcement") === "disabled"
        ? "Unisolated execution started"
        : `${readString(payload, "enforcement") ?? "Sandbox"} enforcement started`;
    case "sandbox.attempt.resolved": {
      const enforcement = readString(payload, "enforcement");
      const outcome = readString(payload, "outcome") ?? "resolved";
      return enforcement === "disabled" && outcome === "executed"
        ? "Unisolated execution completed"
        : `${enforcement ?? "Sandbox"} enforcement ${outcome}`;
    }
    case "sandbox.escalation.proposed":
      return "Sandbox escalation proposed";
    case "retry.attempt.started":
      return `Retry attempt ${readNumber(payload, "attemptNumber") ?? ""} started`.trim();
    case "retry.attempt.finished":
      return `Retry attempt ${readNumber(payload, "attemptNumber") ?? ""} ${readString(payload, "outcome") ?? "finished"}`.trim();
    case "retry.scheduled":
      return `Retry ${readNumber(payload, "nextAttemptNumber") ?? ""} scheduled`.trim();
    case "retry.exhausted":
      return "Retry exhausted";
    case "retry.cancelled":
      return "Retry cancelled";
    case "retry.fallback.selected":
      return "Retry fallback selected";
    default:
      return name;
  }
}

function detailForEvent(name: RuntimeEventName, payload: Metadata): string | null {
  if (name === "tool.started" || name === "tool.finished") {
    return readString(payload, "actionId");
  }

  if (name.startsWith("action.") || name.startsWith("sandbox.")) {
    return readString(payload, "actionId") ?? readString(payload, "attemptId");
  }

  if (name === "controller.finished") {
    return detailForControllerFinished(payload);
  }

  if (name === "approval.requested" || name === "approval.resolved") {
    return readString(payload, "requestId");
  }

  if (name === "run.item.appended") {
    return readString(payload, "itemId");
  }

  if (name.startsWith("retry.")) {
    return readString(payload, "operationId");
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
    || name === "action.invalidated"
    || name === "sandbox.attempt.resolved" && [
      "sandbox_denied",
      "sandbox_unavailable",
      "failed",
    ].includes(readString(payload, "outcome") ?? "")
    || name === "approval.resolved" && readString(payload, "code") !== null
  ) {
    return "error";
  }

  if (
    name === "run.cancelled" ||
    name === "retry.exhausted" ||
    name === "retry.cancelled" ||
    status === "stopped" ||
    decision === "review"
    || name === "sandbox.attempt.started" && readString(payload, "enforcement") === "disabled"
  ) {
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
  copyNumber(metadata, payload, "pendingVersion");
  copyString(metadata, payload, "category");
  copyString(metadata, payload, "reviewer");
  copyString(metadata, payload, "reviewOperationId");
  copyString(metadata, payload, "resolutionKind");
  copyString(metadata, payload, "applicationKind");
  copyStringArray(metadata, payload, "authorityRecordIds");
  copyString(metadata, payload, "observationId");
  copyStringArray(metadata, payload, "evidenceRefs");
  copyString(metadata, payload, "evidenceId");
  copyNumber(metadata, payload, "durationMs");
  copyNumber(metadata, payload, "evidenceCount");
  copyNumber(metadata, payload, "artifactCount");
  copyStringArray(metadata, payload, "errorCodes");
  copyString(metadata, payload, "type");
  copyString(metadata, payload, "operationId");
  copyString(metadata, payload, "owner");
  copyString(metadata, payload, "occurredAt");
  copyString(metadata, payload, "attemptId");
  copyString(metadata, payload, "budgetId");
  copyNumber(metadata, payload, "attemptNumber");
  copyNumber(metadata, payload, "budgetAttemptNumber");
  copyNumber(metadata, payload, "maxBudgetAttempts");
  copyString(metadata, payload, "outcome");
  copyString(metadata, payload, "failureCategory");
  copyString(metadata, payload, "failureCode");
  copyString(metadata, payload, "next");
  copyNumber(metadata, payload, "retryNumber");
  copyNumber(metadata, payload, "nextAttemptNumber");
  copyNumber(metadata, payload, "delayMs");
  copyString(metadata, payload, "delaySource");
  copyString(metadata, payload, "nextAttemptAt");
  copyString(metadata, payload, "reason");
  copyNumber(metadata, payload, "totalAttempts");
  copyNumber(metadata, payload, "totalRetryDelayMs");
  copyString(metadata, payload, "lastFailureCategory");
  copyString(metadata, payload, "lastFailureCode");
  copyString(metadata, payload, "phase");
  copyString(metadata, payload, "enforcement");
  copyString(metadata, payload, "effectState");
  copyNumber(metadata, payload, "ordinal");
  copyNumber(metadata, payload, "effectCount");
  copyNumber(metadata, payload, "targetAssertionCount");
  copyAttribution(metadata, payload);

  return metadata;
}

function copyAttribution(target: Metadata, source: Metadata): void {
  if (!isRecord(source.attribution)) {
    return;
  }
  const attribution: Metadata = {};
  copyString(attribution, source.attribution, "requestId");
  copyString(attribution, source.attribution, "runId");
  copyString(attribution, source.attribution, "operation");
  copyString(attribution, source.attribution, "observedAt");
  if (Object.keys(attribution).length === 4) {
    target.attribution = Object.freeze(attribution);
  }
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
