import {
  AgentLoop,
  AgentRuntime,
  InMemoryContextManager,
  ReportTemplateRegistry,
  ReportTemplateRenderer,
  ToolExecutionBoundary,
  ToolRegistry,
  defaultRuntimeLimits,
  type AgentTask,
  type Metadata,
  type PermissionMode,
  type PermissionService,
  type Provider,
  type Report,
  type ReportGeneratorPort,
  type RuntimeEventEmitter,
  type RuntimeLimits,
  type StoragePort,
} from "@agent-anything/platform";
import { NetDoctorEvidenceBuilder } from "../../evidence/index.js";
import { netDoctorSummaryTemplate } from "../../report/templates/index.js";
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
  reportTemplateId?: string;
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
      reportGenerator: createNetDoctorTemplateReportGenerator({
        templateId: input.reportTemplateId ?? netDoctorSummaryTemplate.id,
      }),
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

function createNetDoctorTemplateReportGenerator(input: {
  templateId: string;
}): ReportGeneratorPort {
  const registry = new ReportTemplateRegistry();
  registry.register(netDoctorSummaryTemplate);
  const renderer = new ReportTemplateRenderer({ registry });

  return {
    async generate(generateInput): Promise<Report> {
      const result = await renderer.render({
        templateId: input.templateId,
        task: generateInput.task,
        evidence: generateInput.evidence,
        reportId: generateInput.id ?? `report_${generateInput.task.id}`,
        createdAt: generateInput.createdAt ?? new Date().toISOString(),
        finalOutput: generateInput.finalOutput,
        metadata: generateInput.metadata ?? {},
      });

      if (result.status === "failed") {
        throw new Error(result.error.message);
      }

      return result.report;
    },
  };
}

function readPhase1ToolCalls(_task: AgentTask): [] {
  return [];
}
