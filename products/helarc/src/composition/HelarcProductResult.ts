import type {
  AgentTask,
  RunResult,
  RunResultStatus,
  RuntimeEvent,
} from "@agent-anything/agent-core";
import type { SandboxEnforcement } from "@agent-anything/action-execution";
import { projectRuntimeEventForHost } from "@agent-anything/host";
import { CODE_AGENT_RUN_COMMAND_ACTION } from "@agent-anything/code-agent";
import type { ISODateTimeString, Metadata } from "@agent-anything/shared";
import type { HelarcAgentOutput } from "../controller/index.js";
import type { HelarcPatchOutcome } from "../patch/HelarcPatchActionController.js";

export type HelarcProductStatus =
  | "completed"
  | "rejected"
  | "failed"
  | "blocked"
  | "cancelled";

export type HelarcPatchStatus = "proposed" | "applied" | "rejected" | "failed";

export interface HelarcActivityItem {
  readonly id: string;
  readonly sequence: number;
  readonly timestamp: ISODateTimeString;
  readonly kind: string;
  readonly title: string;
  readonly detail: string | null;
  readonly metadata: Metadata;
}

export interface HelarcProductOutput {
  readonly taskId: string;
  readonly workspaceId: string | null;
  readonly agentSummary: string | null;
  readonly runtimeStatus: RunResultStatus;
  readonly patchStatus: HelarcPatchStatus | null;
  readonly appliedPath: string | null;
  readonly enforcement: HelarcEnforcementSummary;
  readonly safeErrors: readonly { readonly code: string; readonly message: string }[];
}

export interface HelarcEnforcementSummary {
  readonly selected: SandboxEnforcement;
  readonly status:
    | "not_exercised"
    | "unisolated"
    | "enforced"
    | "unavailable"
    | "denied"
    | "interrupted"
    | "failed";
  readonly code: string | null;
}

export interface HelarcProductResult {
  readonly status: HelarcProductStatus;
  readonly output: HelarcProductOutput;
}

export function projectHelarcProductResult(
  task: AgentTask,
  runResult: RunResult<HelarcAgentOutput>,
  patchOutcome: HelarcPatchOutcome | null,
  selectedEnforcement: SandboxEnforcement,
): HelarcProductResult {
  const agentOutput = runResult.status === "succeeded" ? runResult.finalOutput : null;
  const safeErrors = collectSafeRunErrors(runResult);
  for (const error of patchOutcome?.errors ?? []) {
    appendSafeError(safeErrors, error.code);
  }

  return Object.freeze({
    status: patchOutcome?.productStatus ?? mapRunStatus(runResult.status),
    output: Object.freeze({
      taskId: task.id,
      workspaceId:
        task.workspaceScope?.roots[task.workspaceScope.defaultRootName ?? ""]?.id ?? null,
      agentSummary: agentOutput?.summary ?? null,
      runtimeStatus: runResult.status,
      patchStatus: patchOutcome?.patchStatus ?? null,
      appliedPath: patchOutcome?.appliedPath ?? null,
      enforcement: Object.freeze(createEnforcementSummary(runResult, selectedEnforcement)),
      safeErrors: Object.freeze(safeErrors.map((error) => Object.freeze({ ...error }))),
    }),
  });
}

export function mapRuntimeEventToHelarcActivity(
  event: RuntimeEvent,
): HelarcActivityItem {
  const projectedEvent = projectRuntimeEventForHost(event);
  const payload = isRecord(projectedEvent.payload) ? projectedEvent.payload : {};
  return Object.freeze({
    id: projectedEvent.id,
    sequence: projectedEvent.sequence,
    timestamp: projectedEvent.timestamp,
    kind: projectedEvent.name,
    title: titleForEvent(projectedEvent.name, payload),
    detail: detailForEvent(projectedEvent.name, payload),
    metadata: Object.freeze({ ...payload }),
  });
}

function createEnforcementSummary(
  runResult: RunResult<HelarcAgentOutput>,
  selected: SandboxEnforcement,
): HelarcEnforcementSummary {
  const item = [...runResult.items].reverse().find(
    (candidate) => candidate.kind === "sandbox_attempt_resolved",
  );
  if (item?.kind !== "sandbox_attempt_resolved") {
    return { selected, status: "not_exercised", code: null };
  }
  const resolution = item.resolution;
  const status: HelarcEnforcementSummary["status"] = resolution.outcome === "executed"
    ? resolution.enforcement === "disabled" ? "unisolated" : "enforced"
    : resolution.outcome === "sandbox_unavailable"
      ? "unavailable"
      : resolution.outcome === "sandbox_denied"
        ? "denied"
        : resolution.outcome;
  return {
    selected,
    status,
    code: status === "unisolated" || status === "enforced" ? null : resolution.code,
  };
}

function collectSafeRunErrors(
  runResult: RunResult<HelarcAgentOutput>,
): Array<{ code: string; message: string }> {
  const errors: Array<{ code: string; message: string }> = [];
  for (const error of runResult.errors) {
    appendSafeError(errors, error.code);
  }
  for (const item of runResult.items) {
    if (item.kind !== "observation") continue;
    const observation = item.observation;
    if (observation.kind === "action_denied" || observation.kind === "action_rejected") {
      appendSafeError(errors, observation.code);
    } else if (observation.kind === "action_failure") {
      appendSafeError(errors, observation.error.code);
    }
  }
  return errors;
}

function appendSafeError(
  errors: Array<{ code: string; message: string }>,
  code: string,
): void {
  if (!errors.some((error) => error.code === code)) {
    errors.push({ code, message: safeProductErrorMessage(code) });
  }
}

function safeProductErrorMessage(code: string): string {
  if (code.startsWith("model_") || code.startsWith("provider_")) {
    return "The model request could not be completed.";
  }
  if (code.startsWith("approval_") || code.startsWith("granted_permissions_")) {
    return "Approval could not be completed.";
  }
  if (code.startsWith("session_authority_") || code.startsWith("policy_amendment_")) {
    return "Permission state could not be updated.";
  }
  if (code.startsWith("patch_") || code.startsWith("action_") || code.startsWith("filesystem_")) {
    return "The proposed file change could not be applied.";
  }
  if (code.startsWith("sandbox_") || code.startsWith("tool_")) {
    return "The requested action could not be completed.";
  }
  if (code.startsWith("storage_") || code.startsWith("audit_") || code.includes("telemetry")) {
    return "Run finalization could not be completed.";
  }
  return "The run could not be completed.";
}

function mapRunStatus(status: RunResultStatus): HelarcProductStatus {
  return status === "succeeded" ? "completed" : status;
}

function titleForEvent(name: string, payload: Metadata): string {
  switch (name) {
    case "run.started": return "Run started";
    case "run.completed": return "Run completed";
    case "run.blocked": return "Run blocked";
    case "run.failed": return "Run failed";
    case "run.cancelled": return "Run cancelled";
    case "controller.started":
      return `Controller iteration ${payload.iteration ?? ""} started`.trim();
    case "controller.finished": return `Controller ${payload.status ?? "finished"}`;
    case "run.item.appended": return `Run item appended: ${payload.itemKind ?? "unknown"}`;
    case "approval.requested": return `Approval requested: ${payload.category ?? "action"}`;
    case "approval.resolved":
      return `Approval ${payload.decisionKind ?? payload.resolutionKind ?? "resolved"}`;
    case "tool.started": return `Tool started: ${payload.toolName ?? "unknown"}`;
    case "tool.finished":
      return `Tool ${payload.status ?? "finished"}: ${payload.toolName ?? "unknown"}`;
    case "action.prepared": return "Action prepared";
    case "action.assessed": return `Action ${payload.status ?? "assessed"}`;
    case "action.invalidated": return "Action invalidated";
    case "sandbox.attempt.started":
      return payload.enforcement === "disabled"
        ? "Unisolated execution started"
        : `${payload.enforcement ?? "Sandbox"} enforcement started`;
    case "sandbox.attempt.resolved":
      return payload.enforcement === "disabled" && payload.outcome === "executed"
        ? "Unisolated execution completed"
        : `${payload.enforcement ?? "Sandbox"} enforcement ${payload.outcome ?? "resolved"}`;
    case "sandbox.escalation.proposed": return "Sandbox escalation proposed";
    case "retry.attempt.started":
      return `Retry attempt ${payload.attemptNumber ?? ""} started`.trim();
    case "retry.attempt.finished":
      return `Retry attempt ${payload.attemptNumber ?? ""} ${payload.outcome ?? "finished"}`.trim();
    case "retry.scheduled": return `Retry ${payload.nextAttemptNumber ?? ""} scheduled`.trim();
    case "retry.exhausted": return "Retry exhausted";
    case "retry.cancelled": return "Retry cancelled";
    case "retry.fallback.selected": return "Retry fallback selected";
    default: return name;
  }
}

function detailForEvent(name: string, payload: Metadata): string | null {
  if (
    (name === "tool.started" || name === "tool.finished")
    && payload.toolName === CODE_AGENT_RUN_COMMAND_ACTION
    && typeof payload.command === "string"
  ) {
    return payload.command;
  }
  if (name === "tool.started" || name === "tool.finished") {
    return typeof payload.actionId === "string" ? payload.actionId : null;
  }
  if (name.startsWith("action.") || name.startsWith("sandbox.")) {
    return typeof payload.actionId === "string"
      ? payload.actionId
      : typeof payload.attemptId === "string" ? payload.attemptId : null;
  }
  if (name === "controller.finished") {
    return typeof payload.controllerAction === "string" ? payload.controllerAction : null;
  }
  if (name === "approval.requested" || name === "approval.resolved") {
    return typeof payload.requestId === "string" ? payload.requestId : null;
  }
  if (name.startsWith("retry.")) {
    return typeof payload.operationId === "string" ? payload.operationId : null;
  }
  return null;
}

function isRecord(value: unknown): value is Metadata {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
