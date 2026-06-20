import { describe, expect, it } from "vitest";
import { EvidenceBuilder } from "@agent-anything/evidence";
import type { PolicyCheckInput, WorkspaceContext } from "@agent-anything/governance";
import { InMemoryStorage } from "@agent-anything/storage";
import {
  ToolRegistry,
  type ToolCall,
  type ToolDefinition,
  type ToolResult,
} from "@agent-anything/tools";
import type { AgentTask } from "../task/index.js";
import { createDefaultRuntime } from "./createDefaultRuntime.js";

describe("AgentRuntime execution context", () => {
  it("passes the configured resolver into its default boundary", async () => {
    let policyInput: PolicyCheckInput | undefined;
    const registry = new ToolRegistry();
    registry.register(createTool());
    const selectedWorkspace = createWorkspace("workspace-selected");
    const runtime = createDefaultRuntime({
      toolRegistry: registry,
      permissionMode: "trusted",
      executionAccess: "workspace",
      storage: new InMemoryStorage(),
      evidenceBuilder: new EvidenceBuilder(),
      planToolCalls: () => [createToolCall()],
      toolExecutionContextResolver: {
        resolve() {
          return {
            workspace: selectedWorkspace,
            metadata: {
              rootName: "selected",
            },
          };
        },
      },
      policyPort: {
        async evaluate(input) {
          policyInput = input;
          return {
            checkId: input.id,
            status: "allowed",
            decidedAt: "2026-06-20T00:00:00.000Z",
          };
        },
      },
    });

    const result = await runtime.run(createTask());

    expect(result.status).toBe("succeeded");
    expect(policyInput).toMatchObject({
      workspace: {
        id: "workspace-selected",
      },
      target: {
        metadata: {
          rootName: "selected",
        },
      },
    });
  });
});

function createTool(): ToolDefinition {
  return {
    name: "shell.run",
    risk: "risky",
    async execute(call) {
      return createToolResult(call);
    },
  };
}

function createToolCall(): ToolCall {
  return {
    id: "tool-call-1",
    toolName: "shell.run",
    input: {},
    risk: "risky",
    metadata: {},
  };
}

function createToolResult(call: ToolCall): ToolResult {
  const now = "2026-06-20T00:00:00.000Z";
  return {
    toolCallId: call.id,
    toolName: call.toolName,
    status: "succeeded",
    output: { ok: true },
    error: null,
    startedAt: now,
    finishedAt: now,
    metadata: {},
  };
}

function createTask(): AgentTask {
  return {
    id: "task-1",
    kind: "code.change",
    input: {},
    createdAt: "2026-06-20T00:00:00.000Z",
    metadata: {},
  };
}

function createWorkspace(id: string): WorkspaceContext {
  return {
    id,
    name: id,
    rootRef: null,
    trustState: "trusted",
    source: "test",
    policyRefs: [],
    metadata: {},
  };
}
