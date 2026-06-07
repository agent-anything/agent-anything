import type { AgentTask } from "../task/index.js";
import type { Evidence, EvidenceBuilderPort } from "../../evidence/index.js";
import type { ReportGenerator } from "../../report/index.js";
import type { StoragePort } from "../../storage/index.js";
import type { ToolCall, ToolRegistry } from "../../tools/index.js";
import type { Metadata } from "../../shared/types.js";
import type { RuntimeError } from "./RuntimeError.js";
import type { RuntimeOptions } from "./RuntimeOptions.js";
import type { RuntimeResult } from "./RuntimeResult.js";
import { ToolExecutionBoundary } from "./ToolExecutionBoundary.js";

export type PlanToolCalls = (
  task: AgentTask,
) => ToolCall[] | Promise<ToolCall[]>;

export interface AgentRuntimeDependencies {
  toolRegistry: ToolRegistry;
  evidenceBuilder: EvidenceBuilderPort;
  reportGenerator: ReportGenerator;
  storage: StoragePort;
  planToolCalls: PlanToolCalls;
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
