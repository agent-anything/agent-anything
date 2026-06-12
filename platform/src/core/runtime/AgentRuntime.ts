import type { AgentTask } from "../task/index.js";
import type { Evidence, EvidenceBuilderPort } from "../../evidence/index.js";
import type { StoragePort } from "../../storage/index.js";
import type { ToolCall, ToolRegistry } from "../../tools/index.js";
import type { Metadata } from "../../shared/types.js";
import type { PermissionService } from "../../permission/index.js";
import type { PolicyPort } from "../../governance/index.js";
import type { RuntimeError } from "./RuntimeError.js";
import type { RuntimeOptions } from "./RuntimeOptions.js";
import type { RuntimeOutputSpec, RuntimeResult } from "./RuntimeResult.js";
import type { AgentLoop } from "./AgentLoop.js";
import { ToolExecutionBoundary } from "./ToolExecutionBoundary.js";

export type PlanToolCalls = (
  task: AgentTask,
) => ToolCall[] | Promise<ToolCall[]>;

export interface AgentRuntimeDependencies {
  toolRegistry: ToolRegistry;
  evidenceBuilder: EvidenceBuilderPort;
  storage: StoragePort;
  planToolCalls: PlanToolCalls;
  agentLoop?: AgentLoop;
  policyPort?: PolicyPort;
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
        policyPort: dependencies.policyPort,
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
        outputSpec: resolveOutputSpec(options),
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
        code: "runtime_invalid_options",
        message: "Failed to create deterministic tool call plan.",
      })], {
        metadata: runtimeMetadata,
        outputSpec: resolveOutputSpec(options),
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
        outputSpec: resolveOutputSpec(options),
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
          outputSpec: resolveOutputSpec(options),
          startedAt,
        });
      }

      const execution = await this.toolExecutionBoundary.execute({
        task,
        toolCall,
        options,
      });

      if (execution.status === "failed") {
        return createRuntimeResult(task, "failed", execution.errors, {
          metadata: runtimeMetadata,
          outputSpec: resolveOutputSpec(options),
          startedAt,
        });
      }

      if (execution.status === "blocked") {
        return createRuntimeResult(task, "blocked", execution.errors, {
          metadata: runtimeMetadata,
          outputSpec: resolveOutputSpec(options),
          startedAt,
        });
      }

      evidence.push(...execution.evidence);
    }

    return this.completeRuntimeWithEvidence(task, evidence, {
      metadata: runtimeMetadata,
      startedAt,
      artifactRefs,
      output: null,
      outputSpec: resolveOutputSpec(options),
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

    if (loopResult.status === "stopped") {
      return createFailedRuntimeResult(task, [
        {
          code: "runtime_agent_loop_stopped",
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
        outputSpec: resolveOutputSpec(options),
        startedAt: runtime.startedAt,
      });
    }

    if (loopResult.status === "blocked") {
      return createRuntimeResult(task, "blocked", loopResult.errors, {
        evidenceRefs: loopResult.evidence.map((item) => item.id),
        metadata: {
          ...runtime.metadata,
          ...loopResult.metadata,
        },
        outputSpec: resolveOutputSpec(options),
        startedAt: runtime.startedAt,
      });
    }

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
      output: loopResult.finalOutput,
      outputSpec: resolveOutputSpec(options),
    });
  }

  private async completeRuntimeWithEvidence(
    task: AgentTask,
    evidence: Evidence[],
    runtime: {
      metadata: Metadata;
      startedAt: number;
      artifactRefs: string[];
      output: unknown;
      outputSpec: RuntimeOutputSpec;
    },
  ): Promise<RuntimeResult> {
    const artifactRefs = [...runtime.artifactRefs];
    try {
      for (const item of evidence) {
        const artifact = await this.dependencies.storage.storeEvidence(item);
        artifactRefs.push(artifact.id);
      }

      return {
        taskId: task.id,
        status: "succeeded",
        output: runtime.output,
        outputSpec: runtime.outputSpec,
        evidenceRefs: evidence.map((item) => item.id),
        artifactRefs,
        errors: [],
        metadata: createRuntimeMetadata(runtime.metadata, runtime.startedAt),
      };
    } catch (error) {
      return createFailedRuntimeResult(task, [toRuntimeError(error, {
        code: "storage_write_failed",
        message: "Failed to store runtime artifacts.",
      })], {
        evidenceRefs: evidence.map((item) => item.id),
        artifactRefs,
        metadata: runtime.metadata,
        outputSpec: runtime.outputSpec,
        startedAt: runtime.startedAt,
      });
    }
  }
}

function validateRuntimeOptions(options: RuntimeOptions): RuntimeError | null {
  if (options.limits.maxToolCalls < 0) {
    return {
      code: "runtime_invalid_options",
      message: "maxToolCalls must be greater than or equal to 0.",
      metadata: {
        maxToolCalls: options.limits.maxToolCalls,
      },
    };
  }

  if (options.limits.maxDurationMs < 0) {
    return {
      code: "runtime_invalid_options",
      message: "maxDurationMs must be greater than or equal to 0.",
      metadata: {
        maxDurationMs: options.limits.maxDurationMs,
      },
    };
  }

  if (options.limits.maxConsecutiveFailures < 0) {
    return {
      code: "runtime_invalid_options",
      message: "maxConsecutiveFailures must be greater than or equal to 0.",
      metadata: {
        maxConsecutiveFailures: options.limits.maxConsecutiveFailures,
      },
    };
  }

  if (options.limits.maxIterations < 0) {
    return {
      code: "runtime_invalid_options",
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
    outputSpec?: RuntimeOutputSpec;
    startedAt: number;
  },
): RuntimeResult {
  return createRuntimeResult(task, "failed", errors, options);
}

function createRuntimeResult(
  task: AgentTask,
  status: "failed" | "blocked",
  errors: RuntimeError[],
  options: {
    evidenceRefs?: string[];
    artifactRefs?: string[];
    metadata: Metadata;
    outputSpec?: RuntimeOutputSpec;
    startedAt: number;
  },
): RuntimeResult {
  return {
    taskId: task.id,
    status,
    output: null,
    outputSpec: options.outputSpec ?? resolveOutputSpec(),
    evidenceRefs: options.evidenceRefs ?? [],
    artifactRefs: options.artifactRefs ?? [],
    errors,
    metadata: createRuntimeMetadata(options.metadata, options.startedAt),
  };
}

function resolveOutputSpec(options?: RuntimeOptions): RuntimeOutputSpec {
  return options?.outputSpec ?? {
    format: "json",
    metadata: {},
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
