import { AgentLoop, AgentRuntime, InMemoryContextManager, ToolExecutionBoundary, defaultRuntimeLimits, type AgentTask, type RuntimeEventEmitter, type RuntimeLimits } from "@agent-anything/agent-core";
import { ToolRegistry } from "@agent-anything/tools";
import type { Metadata } from "@agent-anything/shared";
import type { PermissionMode, PermissionService } from "@agent-anything/permission";
import type { Provider } from "@agent-anything/providers";
import type { StoragePort } from "@agent-anything/storage";
import { NetDoctorEvidenceBuilder } from "../../evidence/index.js";
import { registerNetDoctorTools } from "../../tools/index.js";
import type { NetDoctorRuntimeConfig } from "../config/index.js";
import { createNetDoctorPlanner } from "../planner/index.js";

export interface CreateNetDoctorAgentRuntimeInput {
  provider: Provider;
  storage: StoragePort;
  config?: NetDoctorRuntimeConfig;
  permissionMode?: PermissionMode;
  permissionService?: PermissionService;
  limits?: Partial<RuntimeLimits>;
  metadata?: Metadata;
  eventEmitter?: RuntimeEventEmitter;
  toolRegistry?: ToolRegistry;
}

export function createNetDoctorAgentRuntime(
  input: CreateNetDoctorAgentRuntimeInput,
): AgentRuntime {
  const toolRegistry = input.toolRegistry ?? createDefaultToolRegistry();
  const evidenceBuilder = new NetDoctorEvidenceBuilder();
  const toolExecutionBoundary = new ToolExecutionBoundary({
    toolRegistry,
    evidenceBuilder,
    permissionService: input.permissionService,
  });
  const agentLoop = new AgentLoop({
    planner: createNetDoctorPlanner(input.provider),
    contextManager: new InMemoryContextManager(),
    toolExecutionBoundary,
    eventEmitter: input.eventEmitter,
  });

  return new AgentRuntime(
    {
      toolRegistry,
      evidenceBuilder,
      storage: input.storage,
      planToolCalls: readPhase1ToolCalls,
      permissionService: input.permissionService,
      toolExecutionBoundary,
      agentLoop,
    },
    {
      limits: {
        ...defaultRuntimeLimits,
        ...input.config?.limits,
        ...input.limits,
      },
      permissionMode: input.permissionMode ?? input.config?.permissionMode ?? "trusted",
      metadata: {
        product: "net-doctor",
        runtime: "phase2-agent",
        providerId: input.config?.providerId,
        model: input.config?.model,
        providerTimeoutMs: input.config?.providerTimeoutMs,
        ...input.config?.metadata,
        ...input.metadata,
      },
    },
  );
}

function createDefaultToolRegistry(): ToolRegistry {
  const toolRegistry = new ToolRegistry();
  registerNetDoctorTools(toolRegistry);
  return toolRegistry;
}

function readPhase1ToolCalls(_task: AgentTask): [] {
  return [];
}
