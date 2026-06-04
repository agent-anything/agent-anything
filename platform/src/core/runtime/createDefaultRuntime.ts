import { EvidenceBuilder } from "../../evidence";
import type { PermissionMode } from "../../permission";
import { ReportGenerator } from "../../report";
import type { Metadata } from "../../shared/types";
import type { StoragePort } from "../../storage";
import type { ToolCall, ToolRegistry } from "../../tools";
import type { AgentTask } from "../task";
import { AgentRuntime, type PlanToolCalls } from "./AgentRuntime";
import type { RuntimeLimits } from "./RuntimeLimits";

export const defaultRuntimeLimits: RuntimeLimits = {
  maxToolCalls: 5,
  maxDurationMs: 30000,
  maxConsecutiveFailures: 1,
};

export interface CreateDefaultRuntimeInput {
  toolRegistry: ToolRegistry;
  permissionMode: PermissionMode;
  storage: StoragePort;
  limits?: Partial<RuntimeLimits>;
  metadata?: Metadata;
  planToolCalls?: PlanToolCalls;
}

export function createDefaultRuntime(
  input: CreateDefaultRuntimeInput,
): AgentRuntime {
  return new AgentRuntime(
    {
      toolRegistry: input.toolRegistry,
      evidenceBuilder: new EvidenceBuilder(),
      reportGenerator: new ReportGenerator(),
      storage: input.storage,
      planToolCalls: input.planToolCalls ?? readToolCallsFromTaskInput,
    },
    {
      limits: {
        ...defaultRuntimeLimits,
        ...input.limits,
      },
      permissionMode: input.permissionMode,
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
