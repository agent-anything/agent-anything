import type { AgentTask } from "../task/index.js";
import { createAuditRecord, type AuditPort } from "@agent-anything/observability/audit";
import type { Evidence, EvidenceBuilderPort } from "@agent-anything/evidence";
import type { IdentityProvider, IdentityRef } from "@agent-anything/governance/identity";
import type { StoragePort } from "@agent-anything/storage";
import { createTelemetryRecord, type TelemetryPort } from "@agent-anything/observability/telemetry";
import type { ToolCall, ToolRegistry } from "@agent-anything/tools";
import type { Metadata } from "@agent-anything/shared";
import type { PermissionService } from "@agent-anything/permission";
import type { PolicyPort } from "@agent-anything/governance";
import type { WorkspaceContext, WorkspaceResolver } from "@agent-anything/governance/workspace";
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
  auditPort?: AuditPort;
  telemetryPort?: TelemetryPort;
  workspaceResolver?: WorkspaceResolver;
  identityProvider?: IdentityProvider;
  toolExecutionBoundary?: ToolExecutionBoundary;
}

interface RuntimeContext {
  workspace?: WorkspaceContext;
  identity?: IdentityRef;
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
        auditPort: dependencies.auditPort,
        telemetryPort: dependencies.telemetryPort,
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
      const result = createFailedRuntimeResult(task, [invalidOptionsError], {
        metadata: runtimeMetadata,
        outputSpec: resolveOutputSpec(options),
        startedAt,
      });
      return this.finalizeRuntimeResult(task, result, options, {}, startedAt);
    }

    const contextResult = await this.resolveRuntimeContext(task, options, startedAt);
    if ("result" in contextResult) {
      return this.finalizeRuntimeResult(task, contextResult.result, options, {}, startedAt);
    }

    const context = contextResult.context;
    const taskStartedError = await this.recordTaskAudit(task, {
      eventName: "task.started",
      action: "runtime.start",
      outcome: "succeeded",
      payload: {
        taskKind: task.kind,
      },
    }, options, context);
    if (taskStartedError) {
      return createFailedRuntimeResult(task, [taskStartedError], {
        metadata: runtimeMetadata,
        outputSpec: resolveOutputSpec(options),
        startedAt,
      });
    }

    if (this.dependencies.agentLoop) {
      return this.runAgentLoop(task, options, {
        metadata: runtimeMetadata,
        startedAt,
        context,
      });
    }

    let toolCalls: ToolCall[];
    try {
      toolCalls = await this.dependencies.planToolCalls(task);
    } catch (error) {
      const result = createFailedRuntimeResult(task, [toRuntimeError(error, {
        code: "runtime_invalid_options",
        message: "Failed to create deterministic tool call plan.",
      })], {
        metadata: runtimeMetadata,
        outputSpec: resolveOutputSpec(options),
        startedAt,
      });
      return this.finalizeRuntimeResult(task, result, options, context, startedAt);
    }

    if (toolCalls.length > options.limits.maxToolCalls) {
      const result = createFailedRuntimeResult(task, [
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
      return this.finalizeRuntimeResult(task, result, options, context, startedAt);
    }

    for (const toolCall of toolCalls) {
      if (Date.now() - startedAt > options.limits.maxDurationMs) {
        const result = createFailedRuntimeResult(task, [
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
        return this.finalizeRuntimeResult(task, result, options, context, startedAt);
      }

      const execution = await this.toolExecutionBoundary.execute({
        task,
        toolCall,
        options,
        workspace: context.workspace,
        identity: context.identity,
      });

      if (execution.status === "failed") {
        const result = createRuntimeResult(task, "failed", execution.errors, {
          metadata: runtimeMetadata,
          outputSpec: resolveOutputSpec(options),
          startedAt,
        });
        return this.finalizeRuntimeResult(task, result, options, context, startedAt);
      }

      if (execution.status === "blocked") {
        const result = createRuntimeResult(task, "blocked", execution.errors, {
          metadata: runtimeMetadata,
          outputSpec: resolveOutputSpec(options),
          startedAt,
        });
        return this.finalizeRuntimeResult(task, result, options, context, startedAt);
      }

      evidence.push(...execution.evidence);
    }

    return this.completeRuntimeWithEvidence(task, evidence, {
      metadata: runtimeMetadata,
      startedAt,
      artifactRefs,
      output: null,
      outputSpec: resolveOutputSpec(options),
      options,
      context,
    });
  }

  private async runAgentLoop(
    task: AgentTask,
    options: RuntimeOptions,
    runtime: {
      metadata: Metadata;
      startedAt: number;
      context: RuntimeContext;
    },
  ): Promise<RuntimeResult> {
    const loopResult = await this.dependencies.agentLoop!.run({
      task,
      options,
    });

    if (loopResult.status === "stopped") {
      const result = createFailedRuntimeResult(task, [
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
      return this.finalizeRuntimeResult(task, result, options, runtime.context, runtime.startedAt);
    }

    if (loopResult.status === "blocked") {
      const result = createRuntimeResult(task, "blocked", loopResult.errors, {
        evidenceRefs: loopResult.evidence.map((item) => item.id),
        metadata: {
          ...runtime.metadata,
          ...loopResult.metadata,
        },
        outputSpec: resolveOutputSpec(options),
        startedAt: runtime.startedAt,
      });
      return this.finalizeRuntimeResult(task, result, options, runtime.context, runtime.startedAt);
    }

    if (loopResult.status !== "completed") {
      const result = createFailedRuntimeResult(task, loopResult.errors.length > 0
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
      return this.finalizeRuntimeResult(task, result, options, runtime.context, runtime.startedAt);
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
      options,
      context: runtime.context,
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
      options: RuntimeOptions;
      context: RuntimeContext;
    },
  ): Promise<RuntimeResult> {
    const artifactRefs = [...runtime.artifactRefs];
    try {
      for (const item of evidence) {
        const artifact = await this.dependencies.storage.storeEvidence(item);
        artifactRefs.push(artifact.id);
      }

      const result: RuntimeResult = {
        taskId: task.id,
        status: "succeeded",
        output: runtime.output,
        outputSpec: runtime.outputSpec,
        evidenceRefs: evidence.map((item) => item.id),
        artifactRefs,
        errors: [],
        metadata: createRuntimeMetadata(runtime.metadata, runtime.startedAt),
      };
      return this.finalizeRuntimeResult(task, result, runtime.options, runtime.context, runtime.startedAt);
    } catch (error) {
      const result = createFailedRuntimeResult(task, [toRuntimeError(error, {
        code: "storage_write_failed",
        message: "Failed to store runtime artifacts.",
      })], {
        evidenceRefs: evidence.map((item) => item.id),
        artifactRefs,
        metadata: runtime.metadata,
        outputSpec: runtime.outputSpec,
        startedAt: runtime.startedAt,
      });
      return this.finalizeRuntimeResult(task, result, runtime.options, runtime.context, runtime.startedAt);
    }
  }

  private async resolveRuntimeContext(
    task: AgentTask,
    options: RuntimeOptions,
    startedAt: number,
  ): Promise<{ context: RuntimeContext } | { result: RuntimeResult }> {
    const context: RuntimeContext = {};

    if (this.dependencies.workspaceResolver) {
      try {
        context.workspace = await this.dependencies.workspaceResolver.resolve({
          taskId: task.id,
          cwd: typeof options.metadata.cwd === "string" ? options.metadata.cwd : null,
          metadata: options.metadata,
        });
      } catch (error) {
        return {
          result: createFailedRuntimeResult(task, [toRuntimeError(error, {
            code: "runtime_workspace_resolution_failed",
            message: "Workspace resolution failed.",
          })], {
            metadata: options.metadata,
            outputSpec: resolveOutputSpec(options),
            startedAt,
          }),
        };
      }
    }

    if (this.dependencies.identityProvider) {
      try {
        context.identity = await this.dependencies.identityProvider.resolve({
          taskId: task.id,
          metadata: options.metadata,
        });
      } catch (error) {
        return {
          result: createFailedRuntimeResult(task, [toRuntimeError(error, {
            code: "runtime_identity_resolution_failed",
            message: "Identity resolution failed.",
          })], {
            metadata: options.metadata,
            outputSpec: resolveOutputSpec(options),
            startedAt,
          }),
        };
      }
    }

    return { context };
  }

  private async finalizeRuntimeResult(
    task: AgentTask,
    result: RuntimeResult,
    options: RuntimeOptions,
    context: RuntimeContext,
    startedAt: number,
  ): Promise<RuntimeResult> {
    const auditError = await this.recordTaskAudit(task, {
      eventName: result.status === "succeeded" ? "task.completed" : "task.failed",
      action: result.status === "succeeded" ? "runtime.complete" : "runtime.fail",
      outcome: result.status,
      payload: {
        status: result.status,
        outputPresent: result.output !== null,
        evidenceCount: result.evidenceRefs.length,
        artifactCount: result.artifactRefs.length,
        errorCodes: result.errors.map((error) => error.code),
        durationMs: Date.now() - startedAt,
      },
    }, options, context);
    if (auditError) {
      return createFailedRuntimeResult(task, [auditError], {
        evidenceRefs: result.evidenceRefs,
        artifactRefs: result.artifactRefs,
        metadata: options.metadata,
        outputSpec: resolveOutputSpec(options),
        startedAt,
      });
    }

    const telemetryError = await this.recordTaskTelemetry(task, result, options, startedAt);
    if (telemetryError) {
      return createFailedRuntimeResult(task, [telemetryError], {
        evidenceRefs: result.evidenceRefs,
        artifactRefs: result.artifactRefs,
        metadata: options.metadata,
        outputSpec: resolveOutputSpec(options),
        startedAt,
      });
    }

    return result;
  }

  private async recordTaskAudit(
    task: AgentTask,
    event: {
      eventName: string;
      action: string;
      outcome: "succeeded" | "failed" | "blocked" | "cancelled";
      payload: Metadata;
    },
    options: RuntimeOptions,
    context: RuntimeContext,
  ): Promise<RuntimeError | null> {
    if (!this.dependencies.auditPort) {
      return null;
    }

    try {
      await this.dependencies.auditPort.record(createAuditRecord({
        id: `audit_${event.eventName.replace(".", "_")}_${task.id}`,
        taskId: task.id,
        eventName: event.eventName,
        timestamp: new Date().toISOString(),
        actorRef: context.identity?.id ?? null,
        workspaceId: context.workspace?.id ?? null,
        subject: {
          kind: context.identity?.kind ?? "agent",
          id: context.identity?.id ?? "agent",
          metadata: context.identity?.metadata ?? {},
        },
        action: event.action,
        target: {
          kind: "task",
          id: task.id,
          metadata: {
            taskKind: task.kind,
          },
        },
        outcome: event.outcome,
        payload: event.payload,
        metadata: {
          source: "agent-runtime",
        },
      }));
      return null;
    } catch (error) {
      if ((options.auditMode ?? "optional") !== "required") {
        return null;
      }

      return toRuntimeError(error, {
        code: "audit_required_failed",
        message: "Required audit recording failed.",
      });
    }
  }

  private async recordTaskTelemetry(
    task: AgentTask,
    result: RuntimeResult,
    options: RuntimeOptions,
    startedAt: number,
  ): Promise<RuntimeError | null> {
    if (!this.dependencies.telemetryPort) {
      return null;
    }

    try {
      await this.dependencies.telemetryPort.record(createTelemetryRecord({
        id: `telemetry_runtime_task_completed_${task.id}`,
        taskId: task.id,
        eventName: "runtime.task.completed",
        timestamp: new Date().toISOString(),
        durationMs: Date.now() - startedAt,
        counters: {
          evidenceCount: result.evidenceRefs.length,
          artifactCount: result.artifactRefs.length,
          errorCount: result.errors.length,
        },
        dimensions: {
          status: result.status,
          code: result.errors[0]?.code ?? null,
          permissionMode: options.permissionMode,
          executionAccess: typeof options.metadata.executionAccess === "string"
            ? options.metadata.executionAccess
            : null,
        },
      }));
      return null;
    } catch (error) {
      if ((options.telemetryMode ?? "optional") !== "required") {
        return null;
      }

      return toRuntimeError(error, {
        code: "runtime_telemetry_required_failed",
        message: "Required telemetry recording failed.",
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
