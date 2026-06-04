import { describe, expect, it } from "vitest";
import type { Evidence } from "../../evidence";
import { EvidenceBuilder } from "../../evidence";
import type { Report } from "../../report";
import { ReportGenerator } from "../../report";
import { InMemoryStorage, type StoragePort } from "../../storage";
import {
  ToolRegistry,
  type ToolCall,
  type ToolDefinition,
  type ToolResult,
} from "../../tools";
import type { AgentTask } from "../task";
import { AgentRuntime } from "./AgentRuntime";
import { createDefaultRuntime } from "./createDefaultRuntime";
import type { RuntimeOptions } from "./RuntimeOptions";

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
});

function createRuntime(input: {
  toolRegistry: ToolRegistry;
  toolCalls: ToolCall[];
  options?: RuntimeOptions;
  evidenceBuilder?: EvidenceBuilder;
  reportGenerator?: ReportGenerator;
  storage?: StoragePort;
}): AgentRuntime {
  return new AgentRuntime(
    {
      toolRegistry: input.toolRegistry,
      evidenceBuilder: input.evidenceBuilder ?? new EvidenceBuilder(),
      reportGenerator: input.reportGenerator ?? new ReportGenerator(),
      storage: input.storage ?? new InMemoryStorage(),
      planToolCalls: () => input.toolCalls,
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
    },
    permissionMode: "allowAll",
    metadata: {
      source: "test",
    },
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
