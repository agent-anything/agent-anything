import { EvidenceBuilder, type EvidenceBuilderPort } from "../../evidence/index.js";
import type { PermissionMode } from "../../permission/index.js";
import { ReportGenerator } from "../../report/index.js";
import type { Metadata } from "../../shared/types.js";
import type { StoragePort } from "../../storage/index.js";
import type { ToolCall, ToolRegistry } from "../../tools/index.js";
import type { AgentTask } from "../task/index.js";
import { AgentRuntime, type PlanToolCalls } from "./AgentRuntime.js";
import type { RuntimeLimits } from "./RuntimeLimits.js";

export const defaultRuntimeLimits: RuntimeLimits = {
  maxToolCalls: 5,
  maxDurationMs: 30000,
  maxConsecutiveFailures: 1,
};

export interface CreateDefaultRuntimeInput {
  toolRegistry: ToolRegistry;
  permissionMode: PermissionMode;
  storage: StoragePort;
  evidenceBuilder?: EvidenceBuilderPort;
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
      evidenceBuilder: input.evidenceBuilder ?? new EvidenceBuilder(),
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
