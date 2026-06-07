import { describe, expect, it } from "vitest";
import { InMemoryContextManager } from "../context/index.js";
import { RuntimeEventEmitter, RuntimeEventRecorder } from "../events/index.js";
import type { PlanStep, Planner, PlannerInput } from "../planner/index.js";
import type { AgentTask } from "../task/index.js";
import { EvidenceBuilder } from "../../evidence/index.js";
import {
  ToolRegistry,
  type ToolCall,
  type ToolDefinition,
  type ToolResult,
} from "../../tools/index.js";
import { AgentLoop } from "./AgentLoop.js";
import { ToolExecutionBoundary } from "./ToolExecutionBoundary.js";
import type { RuntimeOptions } from "./RuntimeOptions.js";

describe("AgentLoop", () => {
  it("returns final output without executing tools", async () => {
    const { loop, recorder } = createLoop({
      planner: createPlanner(() => createFinalPlanStep()),
    });

    const result = await loop.run({
      task: createTask(),
      options: createOptions(),
    });

    expect(result.status).toBe("completed");
    expect(result.finalOutput).toEqual({ conclusion: "Done" });
    expect(result.evidence).toEqual([]);
    expect(result.observations).toEqual([]);
    expect(result.errors).toEqual([]);
    expect(recorder.names()).toEqual([
      "loop.iteration.started",
      "planner.started",
      "planner.finished",
      "plan.created",
      "loop.iteration.finished",
    ]);
  });

  it("runs one tool call and exposes observation to the next planner call", async () => {
    const plannerObservationCounts: number[] = [];
    const contextManager = new InMemoryContextManager();
    const { loop } = createLoop({
      contextManager,
      planner: createPlanner((input) => {
        plannerObservationCounts.push(input.context.observations.length);

        return input.context.observations.length === 0
          ? createCallToolPlanStep(createToolCall())
          : createFinalPlanStep({
            observed: input.context.observations[0]?.summary,
          });
      }),
    });

    const result = await loop.run({
      task: createTask(),
      options: createOptions(),
    });
    const snapshot = await contextManager.getSnapshot("task_001");

    expect(result.status).toBe("completed");
    expect(result.evidence.map((item) => item.id)).toEqual([
      "evidence_tool_call_001",
    ]);
    expect(result.observations.map((item) => item.id)).toEqual([
      "observation_tool_call_001",
    ]);
    expect(result.finalOutput).toEqual({
      observed: "Evidence from net.lookupDns.",
    });
    expect(plannerObservationCounts).toEqual([0, 1]);
    expect(snapshot.evidenceRefs).toEqual(["evidence_tool_call_001"]);
  });

  it("stops when max iterations is exceeded", async () => {
    const { loop } = createLoop({
      planner: createPlanner(() => createCallToolPlanStep(createToolCall())),
    });

    const result = await loop.run({
      task: createTask(),
      options: {
        ...createOptions(),
        limits: {
          ...createOptions().limits,
          maxIterations: 1,
        },
      },
    });

    expect(result).toMatchObject({
      status: "failed",
      errors: [
        {
          code: "runtime_limit_exceeded",
        },
      ],
      iterations: 1,
    });
  });

  it("maps planner failure to structured runtime error", async () => {
    const { loop } = createLoop({
      planner: createPlanner(() => {
        throw new Error("Planner exploded.");
      }),
    });

    const result = await loop.run({
      task: createTask(),
      options: createOptions(),
    });

    expect(result).toMatchObject({
      status: "failed",
      errors: [
        {
          code: "planner_failed",
          message: "Planner exploded.",
        },
      ],
    });
  });
});

function createLoop(input: {
  planner: Planner;
  contextManager?: InMemoryContextManager;
}): {
  loop: AgentLoop;
  recorder: RuntimeEventRecorder;
} {
  const registry = new ToolRegistry();
  registry.register(createFakeTool());
  const eventEmitter = new RuntimeEventEmitter();
  const recorder = new RuntimeEventRecorder();
  recorder.attachTo(eventEmitter);

  return {
    loop: new AgentLoop({
      planner: input.planner,
      contextManager: input.contextManager ?? new InMemoryContextManager(),
      toolExecutionBoundary: new ToolExecutionBoundary({
        toolRegistry: registry,
        evidenceBuilder: new EvidenceBuilder(),
      }),
      eventEmitter,
    }),
    recorder,
  };
}

function createPlanner(plan: (input: PlannerInput) => PlanStep): Planner {
  return {
    async plan(input) {
      return plan(input);
    },
  };
}

function createTask(): AgentTask {
  return {
    id: "task_001",
    kind: "net-doctor.diagnose",
    input: {},
    createdAt: "2026-06-07T00:00:00.000Z",
    metadata: {},
  };
}

function createOptions(): RuntimeOptions {
  return {
    limits: {
      maxToolCalls: 5,
      maxDurationMs: 30000,
      maxConsecutiveFailures: 1,
      maxIterations: 5,
    },
    permissionMode: "allowAll",
    metadata: {},
  };
}

function createCallToolPlanStep(toolCall: ToolCall): PlanStep {
  return {
    id: `plan_step_${toolCall.id}`,
    kind: "callTool",
    toolCall,
    reason: "Need diagnostic evidence.",
    metadata: {},
  };
}

function createFinalPlanStep(finalOutput: unknown = { conclusion: "Done" }): PlanStep {
  return {
    id: "plan_step_final",
    kind: "final",
    finalOutput,
    reason: "Enough evidence collected.",
    metadata: {},
  };
}

function createToolCall(): ToolCall {
  return {
    id: "tool_call_001",
    toolName: "net.lookupDns",
    input: {},
    risk: "safe",
    metadata: {},
  };
}

function createFakeTool(): ToolDefinition {
  return {
    name: "net.lookupDns",
    risk: "safe",
    async execute(call) {
      return createToolResult(call);
    },
  };
}

function createToolResult(call: ToolCall): ToolResult {
  return {
    toolCallId: call.id,
    toolName: call.toolName,
    status: "succeeded",
    output: {
      records: ["93.184.216.34"],
    },
    error: null,
    startedAt: "2026-06-07T00:00:00.000Z",
    finishedAt: "2026-06-07T00:00:01.000Z",
    metadata: {},
  };
}
