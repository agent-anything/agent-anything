import { EvidenceBuilder, type EvidenceBuilderPort } from "../../evidence/index.js";
import type { AuditPort } from "../../audit/index.js";
import type { IdentityProvider } from "../../identity/index.js";
import type { PermissionMode, PermissionService } from "../../permission/index.js";
import type { PolicyPort } from "../../governance/index.js";
import type { Metadata } from "../../shared/types.js";
import type { StoragePort } from "../../storage/index.js";
import type { TelemetryPort } from "../../telemetry/index.js";
import type { ToolCall, ToolRegistry } from "../../tools/index.js";
import type { WorkspaceResolver } from "../../workspace/index.js";
import type { AgentTask } from "../task/index.js";
import { AgentRuntime, type PlanToolCalls } from "./AgentRuntime.js";
import type { RuntimeLimits } from "./RuntimeLimits.js";

export const defaultRuntimeLimits: RuntimeLimits = {
  maxToolCalls: 5,
  maxDurationMs: 30000,
  maxConsecutiveFailures: 1,
  maxIterations: 5,
};

export interface CreateDefaultRuntimeInput {
  toolRegistry: ToolRegistry;
  permissionMode: PermissionMode;
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
    },
    {
      limits: {
        ...defaultRuntimeLimits,
        ...input.limits,
      },
      permissionMode: input.permissionMode,
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
