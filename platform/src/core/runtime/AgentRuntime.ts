import type { AgentTask } from "../task/index.js";
import type { Evidence, EvidenceBuilder } from "../../evidence/index.js";
import {
  createPermissionRequest,
  resolvePermissionDecision,
} from "../../permission/index.js";
import type { ReportGenerator } from "../../report/index.js";
import type { StoragePort } from "../../storage/index.js";
import type { ToolCall, ToolRegistry, ToolResult } from "../../tools/index.js";
import type { Metadata } from "../../shared/types.js";
import type { RuntimeError, RuntimeErrorCode } from "./RuntimeError.js";
import type { RuntimeOptions } from "./RuntimeOptions.js";
import type { RuntimeResult } from "./RuntimeResult.js";

export type PlanToolCalls = (
  task: AgentTask,
) => ToolCall[] | Promise<ToolCall[]>;

export interface AgentRuntimeDependencies {
  toolRegistry: ToolRegistry;
  evidenceBuilder: EvidenceBuilder;
  reportGenerator: ReportGenerator;
  storage: StoragePort;
  planToolCalls: PlanToolCalls;
}

export class AgentRuntime {
  constructor(
    private readonly dependencies: AgentRuntimeDependencies,
    private readonly defaultOptions: RuntimeOptions,
  ) {}

  async run(
    task: AgentTask,
    options: RuntimeOptions = this.defaultOptions,
  ): Promise<RuntimeResult> {
    const startedAt = Date.now();
    const runtimeMetadata = options.metadata;
    const evidence: Evidence[] = [];
    const artifactRefs: string[] = [];

    const invalidOptionsError = validateRuntimeOptions(options);
    if (invalidOptionsError) {
      return createFailedRuntimeResult(task, [invalidOptionsError], {
        metadata: runtimeMetadata,
        startedAt,
      });
    }

    let toolCalls: ToolCall[];
    try {
      toolCalls = await this.dependencies.planToolCalls(task);
    } catch (error) {
      return createFailedRuntimeResult(task, [toRuntimeError(error, {
        code: "invalid_runtime_options",
        message: "Failed to create deterministic tool call plan.",
      })], {
        metadata: runtimeMetadata,
        startedAt,
      });
    }

    if (toolCalls.length > options.limits.maxToolCalls) {
      return createFailedRuntimeResult(task, [
        {
          code: "runtime_limit_exceeded",
          message: `Tool call count ${toolCalls.length} exceeds maxToolCalls ${options.limits.maxToolCalls}.`,
          metadata: {
            maxToolCalls: options.limits.maxToolCalls,
            actualToolCalls: toolCalls.length,
          },
        },
      ], {
        metadata: runtimeMetadata,
        startedAt,
      });
    }

    for (const toolCall of toolCalls) {
      if (Date.now() - startedAt > options.limits.maxDurationMs) {
        return createFailedRuntimeResult(task, [
          {
            code: "runtime_limit_exceeded",
            message: `Runtime exceeded maxDurationMs ${options.limits.maxDurationMs}.`,
            metadata: {
              maxDurationMs: options.limits.maxDurationMs,
            },
          },
        ], {
          metadata: runtimeMetadata,
          startedAt,
        });
      }

      if (toolCall.risk === "risky") {
        const permissionRequest = createPermissionRequest({
          id: `permission_request_${toolCall.id}`,
          taskId: task.id,
          toolCall,
          reason: `Tool ${toolCall.toolName} is marked as risky.`,
          metadata: {
            source: "agent-runtime",
          },
        });
        const decision = resolvePermissionDecision({
          permissionMode: options.permissionMode,
          request: permissionRequest,
        });

        if (decision.status === "denied") {
          return createFailedRuntimeResult(task, [
            {
              code: "permission_denied",
              message: decision.reason,
              metadata: {
                requestId: decision.requestId,
                toolCallId: toolCall.id,
                toolName: toolCall.toolName,
              },
            },
          ], {
            metadata: runtimeMetadata,
            startedAt,
          });
        }
      }

      const toolResult = await this.dependencies.toolRegistry.execute(toolCall);
      if (toolResult.status === "failed") {
        return createFailedRuntimeResult(task, [toToolRuntimeError(toolResult)], {
          metadata: runtimeMetadata,
          startedAt,
        });
      }

      try {
        evidence.push(
          ...this.dependencies.evidenceBuilder.buildFromToolResult({
            toolResult,
          }),
        );
      } catch (error) {
        return createFailedRuntimeResult(task, [toRuntimeError(error, {
          code: "evidence_creation_failed",
          message: "Failed to build evidence from tool result.",
        })], {
          metadata: runtimeMetadata,
          startedAt,
        });
      }
    }

    let report;
    try {
      report = this.dependencies.reportGenerator.generate({
        task,
        evidence,
      });
    } catch (error) {
      return createFailedRuntimeResult(task, [toRuntimeError(error, {
        code: "report_generation_failed",
        message: "Failed to generate report.",
      })], {
        evidenceRefs: evidence.map((item) => item.id),
        metadata: runtimeMetadata,
        startedAt,
      });
    }

    try {
      for (const item of evidence) {
        const artifact = await this.dependencies.storage.storeEvidence(item);
        artifactRefs.push(artifact.id);
      }

      const reportArtifact = await this.dependencies.storage.storeReport(report);
      artifactRefs.push(reportArtifact.id);

      return {
        taskId: task.id,
        status: "succeeded",
        reportRef: reportArtifact.id,
        evidenceRefs: evidence.map((item) => item.id),
        artifactRefs,
        errors: [],
        metadata: createRuntimeMetadata(runtimeMetadata, startedAt),
      };
    } catch (error) {
      return createFailedRuntimeResult(task, [toRuntimeError(error, {
        code: "storage_failed",
        message: "Failed to store runtime artifacts.",
      })], {
        evidenceRefs: evidence.map((item) => item.id),
        artifactRefs,
        metadata: runtimeMetadata,
        startedAt,
      });
    }
  }
}

function validateRuntimeOptions(options: RuntimeOptions): RuntimeError | null {
  if (options.limits.maxToolCalls < 0) {
    return {
      code: "invalid_runtime_options",
      message: "maxToolCalls must be greater than or equal to 0.",
      metadata: {
        maxToolCalls: options.limits.maxToolCalls,
      },
    };
  }

  if (options.limits.maxDurationMs < 0) {
    return {
      code: "invalid_runtime_options",
      message: "maxDurationMs must be greater than or equal to 0.",
      metadata: {
        maxDurationMs: options.limits.maxDurationMs,
      },
    };
  }

  if (options.limits.maxConsecutiveFailures < 0) {
    return {
      code: "invalid_runtime_options",
      message: "maxConsecutiveFailures must be greater than or equal to 0.",
      metadata: {
        maxConsecutiveFailures: options.limits.maxConsecutiveFailures,
      },
    };
  }

  return null;
}

function toToolRuntimeError(toolResult: ToolResult): RuntimeError {
  const code =
    toolResult.error?.code === "tool_not_found"
      ? "tool_not_found"
      : "tool_execution_failed";

  return {
    code,
    message: toolResult.error?.message ?? "Tool execution failed.",
    metadata: {
      toolCallId: toolResult.toolCallId,
      toolName: toolResult.toolName,
      ...toolResult.error?.metadata,
    },
  };
}

function toRuntimeError(
  error: unknown,
  fallback: Pick<RuntimeError, "code" | "message">,
): RuntimeError {
  return {
    code: fallback.code,
    message: error instanceof Error ? error.message : fallback.message,
    metadata: {},
  };
}

function createFailedRuntimeResult(
  task: AgentTask,
  errors: RuntimeError[],
  options: {
    evidenceRefs?: string[];
    artifactRefs?: string[];
    metadata: Metadata;
    startedAt: number;
  },
): RuntimeResult {
  return {
    taskId: task.id,
    status: "failed",
    reportRef: null,
    evidenceRefs: options.evidenceRefs ?? [],
    artifactRefs: options.artifactRefs ?? [],
    errors,
    metadata: createRuntimeMetadata(options.metadata, options.startedAt),
  };
}

function createRuntimeMetadata(
  metadata: Metadata,
  startedAt: number,
): Metadata {
  return {
    ...metadata,
    durationMs: Date.now() - startedAt,
  };
}
