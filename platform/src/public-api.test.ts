import { describe, expect, it } from "vitest";
import {
  createDefaultRuntime,
  InMemoryStorage,
  ToolRegistry,
  type AgentTask,
  type ToolDefinition,
} from "./index.js";

describe("Phase1 public API", () => {
  it("runs the minimal Phase1 flow through public exports", async () => {
    const toolRegistry = new ToolRegistry();
    toolRegistry.register(createLookupDnsTool());

    const storage = new InMemoryStorage();
    const runtime = createDefaultRuntime({
      toolRegistry,
      permissionMode: "allowAll",
      storage,
    });

    const task: AgentTask = {
      id: "task_001",
      kind: "net-doctor.diagnose",
      input: {
        toolCalls: [
          {
            id: "tool_call_001",
            toolName: "net.lookupDns",
            input: {
              hostname: "example.com",
              recordType: "A",
            },
            risk: "safe",
            metadata: {
              taskId: "task_001",
            },
          },
        ],
      },
      createdAt: "2026-06-04T00:00:00.000Z",
      metadata: {
        source: "public-api-test",
      },
    };

    const result = await runtime.run(task);

    expect(result.status).toBe("succeeded");
    expect(result.reportRef).toBe("artifact_report_report_task_001");
    expect(result.evidenceRefs).toEqual(["evidence_tool_call_001"]);
    expect(result.errors).toEqual([]);
    expect(storage.getArtifact("artifact_report_report_task_001")).toMatchObject({
      kind: "report",
      ref: "memory://report/report_task_001",
    });
  });

  it("returns structured failure through public exports when permission denies a risky tool", async () => {
    const toolRegistry = new ToolRegistry();
    toolRegistry.register({
      ...createLookupDnsTool(),
      name: "shell.runCommand",
      risk: "risky",
    });

    const runtime = createDefaultRuntime({
      toolRegistry,
      permissionMode: "denyAll",
      storage: new InMemoryStorage(),
    });

    const result = await runtime.run({
      id: "task_001",
      kind: "net-doctor.diagnose",
      input: {
        toolCalls: [
          {
            id: "tool_call_001",
            toolName: "shell.runCommand",
            input: {
              command: "echo hello",
            },
            risk: "risky",
            metadata: {
              taskId: "task_001",
            },
          },
        ],
      },
      createdAt: "2026-06-04T00:00:00.000Z",
      metadata: {
        source: "public-api-test",
      },
    });

    expect(result).toMatchObject({
      status: "failed",
      reportRef: null,
      errors: [
        {
          code: "permission_denied",
          metadata: {
            toolCallId: "tool_call_001",
            toolName: "shell.runCommand",
          },
        },
      ],
    });
  });
});

function createLookupDnsTool(): ToolDefinition {
  return {
    name: "net.lookupDns",
    risk: "safe",
    async execute(call) {
      return {
        toolCallId: call.id,
        toolName: call.toolName,
        status: "succeeded",
        output: {
          hostname: "example.com",
          recordType: "A",
          records: ["93.184.216.34"],
        },
        error: null,
        startedAt: "2026-06-04T00:00:00.000Z",
        finishedAt: "2026-06-04T00:00:01.000Z",
        metadata: {
          adapter: "fake-dns",
        },
      };
    },
  };
}
