import { EvidenceBuilder, type EvidenceBuilderPort } from "@agent-anything/evidence";
import type { AuditPort } from "@agent-anything/observability/audit";
import type { IdentityProvider } from "@agent-anything/governance/identity";
import type { PermissionMode, PermissionService } from "@agent-anything/permission";
import type { PolicyPort } from "@agent-anything/governance";
import type { Metadata } from "@agent-anything/shared";
import type { StoragePort } from "@agent-anything/storage";
import type { TelemetryPort } from "@agent-anything/observability/telemetry";
import type { ToolCall, ToolRegistry } from "@agent-anything/tools";
import type { WorkspaceResolver } from "@agent-anything/governance/workspace";
import type { AgentTask } from "../task/index.js";
import { AgentRuntime, type PlanToolCalls } from "./AgentRuntime.js";
import type { RuntimeLimits } from "./RuntimeLimits.js";
import type { ExecutionAccess } from "./RuntimeAccessProfile.js";
import type { ToolExecutionContextResolver } from "./ToolExecutionContextResolver.js";

export const defaultRuntimeLimits: RuntimeLimits = {
  maxToolCalls: 5,
  maxDurationMs: 30000,
  maxConsecutiveFailures: 1,
  maxIterations: 5,
};

export interface CreateDefaultRuntimeInput {
  toolRegistry: ToolRegistry;
  permissionMode: PermissionMode;
  executionAccess?: ExecutionAccess;
  storage: StoragePort;
  evidenceBuilder?: EvidenceBuilderPort;
  limits?: Partial<RuntimeLimits>;
  metadata?: Metadata;
  planToolCalls?: PlanToolCalls;
  policyPort?: PolicyPort;
  permissionService?: PermissionService;
  auditPort?: AuditPort;
  auditMode?: "optional" | "required";
  telemetryPort?: TelemetryPort;
  telemetryMode?: "optional" | "required";
  workspaceResolver?: WorkspaceResolver;
  identityProvider?: IdentityProvider;
  toolExecutionContextResolver?: ToolExecutionContextResolver;
}

export function createDefaultRuntime(
  input: CreateDefaultRuntimeInput,
): AgentRuntime {
  return new AgentRuntime(
    {
      toolRegistry: input.toolRegistry,
      evidenceBuilder: input.evidenceBuilder ?? new EvidenceBuilder(),
      storage: input.storage,
      planToolCalls: input.planToolCalls ?? readToolCallsFromTaskInput,
      policyPort: input.policyPort,
      permissionService: input.permissionService,
      auditPort: input.auditPort,
      telemetryPort: input.telemetryPort,
      workspaceResolver: input.workspaceResolver,
      identityProvider: input.identityProvider,
      toolExecutionContextResolver: input.toolExecutionContextResolver,
    },
    {
      limits: {
        ...defaultRuntimeLimits,
        ...input.limits,
      },
      permissionMode: input.permissionMode,
      executionAccess: input.executionAccess ?? readExecutionAccess(input.metadata),
      auditMode: input.auditMode ?? "optional",
      telemetryMode: input.telemetryMode ?? "optional",
      metadata: input.metadata ?? {},
    },
  );
}

function readToolCallsFromTaskInput(task: AgentTask): ToolCall[] {
  if (!isRecord(task.input)) {
    return [];
  }

  const toolCalls = task.input.toolCalls;

  if (!Array.isArray(toolCalls)) {
    return [];
  }

  return toolCalls.filter(isToolCall);
}

function isToolCall(value: unknown): value is ToolCall {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.id === "string" &&
    typeof value.toolName === "string" &&
    (value.risk === "safe" || value.risk === "risky") &&
    "input" in value &&
    isRecord(value.metadata)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
function readExecutionAccess(
  metadata: Metadata | undefined,
): ExecutionAccess {
  const value = metadata?.executionAccess;
  return value === "workspace" || value === "full"
    ? value
    : "restricted";
}
