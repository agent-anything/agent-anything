import type { ContextManager, Observation } from "../context/index.js";
import type { Planner } from "../planner/index.js";
import type { AgentTask } from "../task/index.js";
import type { RuntimeEventEmitter } from "../events/index.js";
import type { Evidence } from "../../evidence/index.js";
import type { Metadata } from "../../shared/types.js";
import type { RuntimeError } from "./RuntimeError.js";
import type { RuntimeOptions } from "./RuntimeOptions.js";
import type { ToolExecutionBoundary } from "./ToolExecutionBoundary.js";

export type AgentLoopStatus = "completed" | "failed" | "blocked" | "stopped";

export interface AgentLoopDependencies {
  planner: Planner;
  contextManager: ContextManager;
  toolExecutionBoundary: ToolExecutionBoundary;
  eventEmitter?: RuntimeEventEmitter;
}

export interface RunAgentLoopInput {
  task: AgentTask;
  options: RuntimeOptions;
}

export interface AgentLoopResult {
  taskId: string;
  status: AgentLoopStatus;
  finalOutput: unknown | null;
  stopReason: string | null;
  evidence: Evidence[];
  observations: Observation[];
  errors: RuntimeError[];
  iterations: number;
  metadata: Metadata;
}

export class AgentLoop {
  constructor(
    private readonly dependencies: AgentLoopDependencies,
  ) {}

  async run(input: RunAgentLoopInput): Promise<AgentLoopResult> {
    const { task, options } = input;
    const evidence: Evidence[] = [];
    const observations: Observation[] = [];

    await this.dependencies.contextManager.createInitial(task);

    for (let iteration = 1; iteration <= options.limits.maxIterations; iteration += 1) {
      this.emit("loop.iteration.started", task.id, {
        iteration,
      });

      const context = await this.dependencies.contextManager.getSnapshot(task.id);
      this.emit("planner.started", task.id, {
        iteration,
      });

      let planStep;
      try {
        planStep = await this.dependencies.planner.plan({
          task,
          context,
          metadata: options.metadata,
        });
      } catch (error) {
        const runtimeError = toRuntimeError(error, {
          code: "provider_planner_failed",
          message: "Planner failed to create a plan step.",
        });
        this.emit("planner.finished", task.id, {
          iteration,
          status: "failed",
          errorCode: runtimeError.code,
        });

        return createLoopResult(task, {
          status: "failed",
          finalOutput: null,
          stopReason: null,
          evidence,
          observations,
          errors: [runtimeError],
          iterations: iteration,
          metadata: options.metadata,
        });
      }

      this.emit("planner.finished", task.id, {
        iteration,
        status: "succeeded",
      });
      this.emit("plan.created", task.id, {
        iteration,
        planStepId: planStep.id,
        planStepKind: planStep.kind,
      });

      if (planStep.kind === "final") {
        this.emit("loop.iteration.finished", task.id, {
          iteration,
          status: "completed",
        });

        return createLoopResult(task, {
          status: "completed",
          finalOutput: planStep.finalOutput,
          stopReason: null,
          evidence,
          observations,
          errors: [],
          iterations: iteration,
          metadata: {
            ...options.metadata,
            finalPlanStepId: planStep.id,
          },
        });
      }

      if (planStep.kind === "stop") {
        this.emit("loop.iteration.finished", task.id, {
          iteration,
          status: "stopped",
        });

        return createLoopResult(task, {
          status: "stopped",
          finalOutput: null,
          stopReason: planStep.stopReason,
          evidence,
          observations,
          errors: [],
          iterations: iteration,
          metadata: {
            ...options.metadata,
            stopPlanStepId: planStep.id,
          },
        });
      }

      this.emit("tool.started", task.id, {
        iteration,
        toolCallId: planStep.toolCall.id,
        toolName: planStep.toolCall.toolName,
      });
      const toolOutcome = await this.dependencies.toolExecutionBoundary.execute({
        task,
        toolCall: planStep.toolCall,
        options,
      });

      if (toolOutcome.status === "failed") {
        this.emit("tool.finished", task.id, {
          iteration,
          status: "failed",
          toolCallId: planStep.toolCall.id,
          toolName: planStep.toolCall.toolName,
        });
        this.emit("loop.iteration.finished", task.id, {
          iteration,
          status: "failed",
        });

        return createLoopResult(task, {
          status: "failed",
          finalOutput: null,
          stopReason: null,
          evidence,
          observations,
          errors: toolOutcome.errors,
          iterations: iteration,
          metadata: options.metadata,
        });
      }

      if (toolOutcome.status === "blocked") {
        this.emit("tool.finished", task.id, {
          iteration,
          status: "blocked",
          toolCallId: planStep.toolCall.id,
          toolName: planStep.toolCall.toolName,
        });
        this.emit("loop.iteration.finished", task.id, {
          iteration,
          status: "blocked",
        });

        return createLoopResult(task, {
          status: "blocked",
          finalOutput: null,
          stopReason: null,
          evidence,
          observations,
          errors: toolOutcome.errors,
          iterations: iteration,
          metadata: options.metadata,
        });
      }

      this.emit("tool.finished", task.id, {
        iteration,
        status: "succeeded",
        toolCallId: planStep.toolCall.id,
        toolName: planStep.toolCall.toolName,
        toolResultStatus: toolOutcome.toolResult.status,
      });

      evidence.push(...toolOutcome.evidence);

      if (toolOutcome.observation) {
        observations.push(toolOutcome.observation);
        this.emit("observation.created", task.id, {
          iteration,
          observationId: toolOutcome.observation.id,
          evidenceRefs: toolOutcome.observation.evidenceRefs,
        });

        try {
          await this.dependencies.contextManager.applyUpdate({
            taskId: task.id,
            observations: [toolOutcome.observation],
            evidenceRefs: toolOutcome.observation.evidenceRefs,
            metadata: {
              lastPlanStepId: planStep.id,
              lastToolCallId: planStep.toolCall.id,
            },
          });
        } catch (error) {
          const runtimeError = toRuntimeError(error, {
            code: "context_update_failed",
            message: "Context update failed.",
          });

          return createLoopResult(task, {
            status: "failed",
            finalOutput: null,
            stopReason: null,
            evidence,
            observations,
            errors: [runtimeError],
            iterations: iteration,
            metadata: options.metadata,
          });
        }

        this.emit("context.updated", task.id, {
          iteration,
          observationId: toolOutcome.observation.id,
          evidenceRefs: toolOutcome.observation.evidenceRefs,
        });
      }

      this.emit("loop.iteration.finished", task.id, {
        iteration,
        status: "continued",
      });
    }

    return createLoopResult(task, {
      status: "failed",
      finalOutput: null,
      stopReason: null,
      evidence,
      observations,
      errors: [
        {
          code: "runtime_limit_exceeded",
          message: `Agent loop exceeded maxIterations ${options.limits.maxIterations}.`,
          metadata: {
            maxIterations: options.limits.maxIterations,
          },
        },
      ],
      iterations: options.limits.maxIterations,
      metadata: options.metadata,
    });
  }

  private emit(name: Parameters<RuntimeEventEmitter["emit"]>[0]["name"], taskId: string, payload: Metadata): void {
    this.dependencies.eventEmitter?.emit({
      name,
      taskId,
      payload,
    });
  }
}

function createLoopResult(
  task: AgentTask,
  input: Omit<AgentLoopResult, "taskId">,
): AgentLoopResult {
  return {
    taskId: task.id,
    ...input,
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
