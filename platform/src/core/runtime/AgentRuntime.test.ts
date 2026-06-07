import { describe, expect, it } from "vitest";
import type { Evidence } from "../../evidence/index.js";
import { EvidenceBuilder } from "../../evidence/index.js";
import type { Report } from "../../report/index.js";
import { ReportGenerator } from "../../report/index.js";
import { InMemoryStorage, type StoragePort } from "../../storage/index.js";
import { InMemoryContextManager } from "../context/index.js";
import type { PlanStep, PlannerInput } from "../planner/index.js";
import {
  ToolRegistry,
  type ToolCall,
  type ToolDefinition,
  type ToolResult,
} from "../../tools/index.js";
import type { AgentTask } from "../task/index.js";
import { AgentRuntime } from "./AgentRuntime.js";
import { AgentLoop } from "./AgentLoop.js";
import { createDefaultRuntime } from "./createDefaultRuntime.js";
import { ToolExecutionBoundary } from "./ToolExecutionBoundary.js";
import type { RuntimeOptions } from "./RuntimeOptions.js";

describe("AgentRuntime", () => {
  it("runs a minimal task successfully", async () => {
    const registry = new ToolRegistry();
    registry.register(createFakeTool("net.lookupDns"));
    const runtime = createRuntime({
      toolRegistry: registry,
      toolCalls: [createToolCall("net.lookupDns")],
    });

    const result = await runtime.run(createTask());

    expect(result.status).toBe("succeeded");
    expect(result.reportRef).toBe("artifact_report_report_task_001");
    expect(result.evidenceRefs).toEqual(["evidence_tool_call_001"]);
    expect(result.artifactRefs).toEqual([
      "artifact_evidence_evidence_tool_call_001",
      "artifact_report_report_task_001",
    ]);
    expect(result.errors).toEqual([]);
  });

  it("uses createDefaultRuntime with tool calls from task input", async () => {
    const registry = new ToolRegistry();
    registry.register(createFakeTool("net.lookupDns"));
    const runtime = createDefaultRuntime({
      toolRegistry: registry,
      permissionMode: "allowAll",
      storage: new InMemoryStorage(),
    });

    const result = await runtime.run(
      createTask({
        toolCalls: [createToolCall("net.lookupDns")],
      }),
    );

    expect(result.status).toBe("succeeded");
  });

  it("asks permission before a risky tool is executed", async () => {
    let executionCount = 0;
    const registry = new ToolRegistry();
    registry.register(
      createFakeTool("shell.runCommand", {
        risk: "risky",
        onExecute: () => {
          executionCount += 1;
        },
      }),
    );
    const runtime = createRuntime({
      toolRegistry: registry,
      toolCalls: [createToolCall("shell.runCommand", { risk: "risky" })],
      options: {
        ...createOptions(),
        permissionMode: "denyAll",
      },
    });

    const result = await runtime.run(createTask());

    expect(result.status).toBe("failed");
    expect(result.errors[0]).toMatchObject({
      code: "permission_denied",
      metadata: {
        toolCallId: "tool_call_001",
        toolName: "shell.runCommand",
      },
    });
    expect(executionCount).toBe(0);
  });

  it("returns structured failure when a tool fails", async () => {
    const registry = new ToolRegistry();
    registry.register(
      createFakeTool("net.lookupDns", {
        result: {
          ...createToolResult("net.lookupDns"),
          status: "failed",
          output: null,
          error: {
            code: "dns_failed",
            message: "DNS lookup failed.",
          },
        },
      }),
    );
    const runtime = createRuntime({
      toolRegistry: registry,
      toolCalls: [createToolCall("net.lookupDns")],
    });

    const result = await runtime.run(createTask());

    expect(result).toMatchObject({
      status: "failed",
      reportRef: null,
      errors: [
        {
          code: "tool_execution_failed",
          message: "DNS lookup failed.",
        },
      ],
    });
  });

  it("returns structured failure when evidence creation fails", async () => {
    const registry = new ToolRegistry();
    registry.register(createFakeTool("net.lookupDns"));
    const runtime = createRuntime({
      toolRegistry: registry,
      toolCalls: [createToolCall("net.lookupDns")],
      evidenceBuilder: {
        buildFromToolResult() {
          throw new Error("Evidence builder failed.");
        },
      } as EvidenceBuilder,
    });

    const result = await runtime.run(createTask());

    expect(result).toMatchObject({
      status: "failed",
      errors: [
        {
          code: "evidence_creation_failed",
          message: "Evidence builder failed.",
        },
      ],
    });
  });

  it("returns structured failure when report generation fails", async () => {
    const registry = new ToolRegistry();
    registry.register(createFakeTool("net.lookupDns"));
    const runtime = createRuntime({
      toolRegistry: registry,
      toolCalls: [createToolCall("net.lookupDns")],
      reportGenerator: {
        generate() {
          throw new Error("Report generator failed.");
        },
      } as ReportGenerator,
    });

    const result = await runtime.run(createTask());

    expect(result).toMatchObject({
      status: "failed",
      evidenceRefs: ["evidence_tool_call_001"],
      errors: [
        {
          code: "report_generation_failed",
          message: "Report generator failed.",
        },
      ],
    });
  });

  it("returns structured failure when storage fails", async () => {
    const registry = new ToolRegistry();
    registry.register(createFakeTool("net.lookupDns"));
    const runtime = createRuntime({
      toolRegistry: registry,
      toolCalls: [createToolCall("net.lookupDns")],
      storage: {
        async storeEvidence() {
          throw new Error("Storage failed.");
        },
        async storeReport() {
          throw new Error("Storage failed.");
        },
      },
    });

    const result = await runtime.run(createTask());

    expect(result).toMatchObject({
      status: "failed",
      evidenceRefs: ["evidence_tool_call_001"],
      artifactRefs: [],
      errors: [
        {
          code: "storage_failed",
          message: "Storage failed.",
        },
      ],
    });
  });

  it("stops when max tool calls is exceeded", async () => {
    const registry = new ToolRegistry();
    registry.register(createFakeTool("net.lookupDns"));
    const runtime = createRuntime({
      toolRegistry: registry,
      toolCalls: [
        createToolCall("net.lookupDns", { id: "tool_call_001" }),
        createToolCall("net.lookupDns", { id: "tool_call_002" }),
      ],
      options: {
        ...createOptions(),
        limits: {
          ...createOptions().limits,
          maxToolCalls: 1,
        },
      },
    });

    const result = await runtime.run(createTask());

    expect(result).toMatchObject({
      status: "failed",
      errors: [
        {
          code: "runtime_limit_exceeded",
          metadata: {
            maxToolCalls: 1,
            actualToolCalls: 2,
          },
        },
      ],
    });
  });

  it("uses AgentLoop when one is provided", async () => {
    const registry = new ToolRegistry();
    registry.register(createFakeTool("net.lookupDns"));
    const storage = new InMemoryStorage();
    const runtime = createRuntime({
      toolRegistry: registry,
      toolCalls: [],
      storage,
      agentLoop: createLoop(registry, (input) => {
        return input.context.observations.length === 0
          ? createCallToolPlanStep(createToolCall("net.lookupDns"))
          : createFinalPlanStep({
            conclusion: "Loop completed.",
          });
      }),
    });

    const result = await runtime.run(createTask());

    expect(result.status).toBe("succeeded");
    expect(result.evidenceRefs).toEqual(["evidence_tool_call_001"]);
    expect(result.reportRef).toBe("artifact_report_report_task_001");
    expect(storage.getArtifact("artifact_evidence_evidence_tool_call_001")).toMatchObject({
      kind: "evidence",
    });
  });

  it("preserves deterministic Phase1 path when no AgentLoop is provided", async () => {
    const registry = new ToolRegistry();
    registry.register(createFakeTool("net.lookupDns"));
    const runtime = createRuntime({
      toolRegistry: registry,
      toolCalls: [createToolCall("net.lookupDns")],
    });

    const result = await runtime.run(createTask());

    expect(result.status).toBe("succeeded");
    expect(result.evidenceRefs).toEqual(["evidence_tool_call_001"]);
  });

  it("converts failed AgentLoopResult into failed RuntimeResult", async () => {
    const registry = new ToolRegistry();
    registry.register(createFakeTool("net.lookupDns"));
    const runtime = createRuntime({
      toolRegistry: registry,
      toolCalls: [],
      agentLoop: createLoop(registry, () => {
        throw new Error("Planner failed.");
      }),
    });

    const result = await runtime.run(createTask());

    expect(result).toMatchObject({
      status: "failed",
      reportRef: null,
      errors: [
        {
          code: "planner_failed",
          message: "Planner failed.",
        },
      ],
    });
  });
});

function createRuntime(input: {
  toolRegistry: ToolRegistry;
  toolCalls: ToolCall[];
  options?: RuntimeOptions;
  evidenceBuilder?: EvidenceBuilder;
  reportGenerator?: ReportGenerator;
  storage?: StoragePort;
  agentLoop?: AgentLoop;
}): AgentRuntime {
  return new AgentRuntime(
    {
      toolRegistry: input.toolRegistry,
      evidenceBuilder: input.evidenceBuilder ?? new EvidenceBuilder(),
      reportGenerator: input.reportGenerator ?? new ReportGenerator(),
      storage: input.storage ?? new InMemoryStorage(),
      planToolCalls: () => input.toolCalls,
      agentLoop: input.agentLoop,
    },
    input.options ?? createOptions(),
  );
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
    metadata: {
      source: "test",
    },
  };
}

function createLoop(
  toolRegistry: ToolRegistry,
  plan: (input: PlannerInput) => PlanStep,
): AgentLoop {
  return new AgentLoop({
    planner: {
      async plan(input) {
        return plan(input);
      },
    },
    contextManager: new InMemoryContextManager(),
    toolExecutionBoundary: new ToolExecutionBoundary({
      toolRegistry,
      evidenceBuilder: new EvidenceBuilder(),
    }),
  });
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

function createFinalPlanStep(finalOutput: unknown): PlanStep {
  return {
    id: "plan_step_final",
    kind: "final",
    finalOutput,
    reason: "Enough evidence collected.",
    metadata: {},
  };
}

function createTask(input: unknown = {}): AgentTask {
  return {
    id: "task_001",
    kind: "net-doctor.diagnose",
    input,
    createdAt: "2026-06-04T00:00:00.000Z",
    metadata: {
      source: "test",
    },
  };
}

function createToolCall(
  toolName: string,
  options: Partial<ToolCall> = {},
): ToolCall {
  return {
    id: "tool_call_001",
    toolName,
    input: {
      hostname: "example.com",
    },
    risk: "safe",
    metadata: {
      taskId: "task_001",
    },
    ...options,
  };
}

function createFakeTool(
  name: string,
  options: {
    risk?: "safe" | "risky";
    result?: ToolResult;
    onExecute?: () => void;
  } = {},
): ToolDefinition {
  return {
    name,
    risk: options.risk ?? "safe",
    async execute(call) {
      options.onExecute?.();
      return options.result ?? createToolResult(call.toolName, call.id);
    },
  };
}

function createToolResult(
  toolName: string,
  toolCallId = "tool_call_001",
): ToolResult {
  return {
    toolCallId,
    toolName,
    status: "succeeded",
    output: {
      records: ["93.184.216.34"],
    },
    error: null,
    startedAt: "2026-06-04T00:00:00.000Z",
    finishedAt: "2026-06-04T00:00:01.000Z",
    metadata: {
      adapter: "fake",
    },
  };
}
