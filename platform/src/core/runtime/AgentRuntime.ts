import type { AgentTask } from "../task/index.js";
import type { Evidence, EvidenceBuilderPort } from "../../evidence/index.js";
import type { ReportGeneratorPort } from "../../report/index.js";
import type { StoragePort } from "../../storage/index.js";
import type { ToolCall, ToolRegistry } from "../../tools/index.js";
import type { Metadata } from "../../shared/types.js";
import type { PermissionService } from "../../permission/index.js";
import type { RuntimeError } from "./RuntimeError.js";
import type { RuntimeOptions } from "./RuntimeOptions.js";
import type { RuntimeResult } from "./RuntimeResult.js";
import type { AgentLoop } from "./AgentLoop.js";
import { ToolExecutionBoundary } from "./ToolExecutionBoundary.js";

export type PlanToolCalls = (
  task: AgentTask,
) => ToolCall[] | Promise<ToolCall[]>;

export interface AgentRuntimeDependencies {
  toolRegistry: ToolRegistry;
  evidenceBuilder: EvidenceBuilderPort;
  reportGenerator: ReportGeneratorPort;
  storage: StoragePort;
  planToolCalls: PlanToolCalls;
  agentLoop?: AgentLoop;
  permissionService?: PermissionService;
  toolExecutionBoundary?: ToolExecutionBoundary;
}

export class AgentRuntime {
  private readonly toolExecutionBoundary: ToolExecutionBoundary;

  constructor(
    private readonly dependencies: AgentRuntimeDependencies,
    private readonly defaultOptions: RuntimeOptions,
  ) {
    this.toolExecutionBoundary = dependencies.toolExecutionBoundary
      ?? new ToolExecutionBoundary({
        toolRegistry: dependencies.toolRegistry,
        evidenceBuilder: dependencies.evidenceBuilder,
        permissionService: dependencies.permissionService,
      });
  }

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

    if (this.dependencies.agentLoop) {
      return this.runAgentLoop(task, options, {
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

      const execution = await this.toolExecutionBoundary.execute({
        task,
        toolCall,
        options,
      });

      if (execution.status === "failed") {
        return createFailedRuntimeResult(task, execution.errors, {
          metadata: runtimeMetadata,
          startedAt,
        });
      }

      evidence.push(...execution.evidence);
    }

    return this.completeRuntimeWithEvidence(task, evidence, {
      metadata: runtimeMetadata,
      startedAt,
      artifactRefs,
      finalOutput: null,
    });
  }

  private async runAgentLoop(
    task: AgentTask,
    options: RuntimeOptions,
    runtime: {
      metadata: Metadata;
      startedAt: number;
    },
  ): Promise<RuntimeResult> {
    const loopResult = await this.dependencies.agentLoop!.run({
      task,
      options,
    });

    if (loopResult.status !== "completed") {
      return createFailedRuntimeResult(task, loopResult.errors.length > 0
        ? loopResult.errors
        : [
          {
            code: "runtime_limit_exceeded",
            message: loopResult.stopReason ?? "Agent loop stopped before completion.",
            metadata: {
              loopStatus: loopResult.status,
              stopReason: loopResult.stopReason,
            },
          },
        ], {
        evidenceRefs: loopResult.evidence.map((item) => item.id),
        metadata: {
          ...runtime.metadata,
          ...loopResult.metadata,
        },
        startedAt: runtime.startedAt,
      });
    }

    return this.completeRuntimeWithEvidence(task, loopResult.evidence, {
      metadata: {
        ...runtime.metadata,
        ...loopResult.metadata,
      },
      startedAt: runtime.startedAt,
      artifactRefs: [],
      finalOutput: loopResult.finalOutput,
    });
  }

  private async completeRuntimeWithEvidence(
    task: AgentTask,
    evidence: Evidence[],
    runtime: {
      metadata: Metadata;
      startedAt: number;
      artifactRefs: string[];
      finalOutput: unknown;
    },
  ): Promise<RuntimeResult> {
    const artifactRefs = [...runtime.artifactRefs];
    let report;
    try {
      report = await this.dependencies.reportGenerator.generate({
        task,
        evidence,
        finalOutput: runtime.finalOutput,
      });
    } catch (error) {
      return createFailedRuntimeResult(task, [toRuntimeError(error, {
        code: "report_generation_failed",
        message: "Failed to generate report.",
      })], {
        evidenceRefs: evidence.map((item) => item.id),
        artifactRefs,
        metadata: runtime.metadata,
        startedAt: runtime.startedAt,
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
        metadata: createRuntimeMetadata(runtime.metadata, runtime.startedAt),
      };
    } catch (error) {
      return createFailedRuntimeResult(task, [toRuntimeError(error, {
        code: "storage_failed",
        message: "Failed to store runtime artifacts.",
      })], {
        evidenceRefs: evidence.map((item) => item.id),
        artifactRefs,
        metadata: runtime.metadata,
        startedAt: runtime.startedAt,
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

  if (options.limits.maxIterations < 0) {
    return {
      code: "invalid_runtime_options",
      message: "maxIterations must be greater than or equal to 0.",
      metadata: {
        maxIterations: options.limits.maxIterations,
      },
    };
  }

  return null;
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
