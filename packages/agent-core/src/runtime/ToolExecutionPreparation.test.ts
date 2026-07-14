import { describe, expect, it } from "vitest";
import { EvidenceBuilder } from "@agent-anything/evidence";
import type { PolicyCheckInput, WorkspaceContext } from "@agent-anything/governance";
import type { PermissionRequest } from "@agent-anything/permission";
import {
  ToolRegistry,
  type ToolCall,
  type ToolDefinition,
  type ToolResult,
} from "@agent-anything/tools";
import type { AgentTask } from "../task/index.js";
import {
  ToolExecutionBoundary,
  type ExecuteToolInput,
  type ToolExecutionConfig,
} from "./ToolExecutionBoundary.js";

describe("ToolExecutionBoundary preparation", () => {
  it("rejects risk downgrade before governance or execution", async () => {
    let executed = false;
    const registry = new ToolRegistry();
    registry.register(createTool(() => {
      executed = true;
    }));
    const boundary = new ToolExecutionBoundary({
      toolRegistry: registry,
      evidenceBuilder: new EvidenceBuilder(),
    });

    const outcome = await boundary.execute(createExecuteInput({
      risk: "safe",
    }));

    expect(outcome).toMatchObject({
      status: "failed",
      errors: [{
        code: "tool_risk_mismatch",
        metadata: {
          callRisk: "safe",
          definitionRisk: "risky",
        },
      }],
    });
    expect(executed).toBe(false);
  });

  it("resolves workspace and metadata before policy and permission", async () => {
    let policyInput: PolicyCheckInput | undefined;
    let permissionInput: PermissionRequest | undefined;
    const selectedWorkspace = createWorkspace("workspace-selected");
    const registry = new ToolRegistry();
    registry.register(createTool());

    const boundary = new ToolExecutionBoundary({
      toolRegistry: registry,
      evidenceBuilder: new EvidenceBuilder(),
      toolExecutionContextResolver: {
        resolve() {
          return {
            workspace: selectedWorkspace,
            permissionReason: "Run governed command.",
            metadata: {
              command: "example",
              cwd: "src",
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
      permissionService: {
        async request(input) {
          permissionInput = input;
          return {
            requestId: input.id,
            status: "granted",
            reason: "Approved.",
            decidedAt: "2026-06-20T00:00:00.000Z",
          };
        },
      },
    });

    const outcome = await boundary.execute(createExecuteInput());

    expect(outcome.status).toBe("succeeded");
    expect(policyInput).toMatchObject({
      workspace: { id: "workspace-selected" },
      target: {
        metadata: {
          command: "example",
          cwd: "src",
        },
      },
    });
    expect(permissionInput).toMatchObject({
      reason: "Run governed command.",
      metadata: {
        workspaceId: "workspace-selected",
        command: "example",
        cwd: "src",
      },
    });
  });
});

function createTool(onExecute?: () => void): ToolDefinition {
  return {
    name: "shell.run",
    risk: "risky",
    async execute(call) {
      onExecute?.();
      return createToolResult(call);
    },
  };
}

function createExecuteInput(
  toolCallOverrides: Partial<ToolCall> = {},
): ExecuteToolInput {
  return {
    task: createTask(),
    toolCall: {
      id: "tool-call-1",
      toolName: "shell.run",
      input: {},
      risk: "risky",
      metadata: {},
      ...toolCallOverrides,
    },
    config: createConfig(),
    workspace: createWorkspace("workspace-default"),
    invocation: {
      interruption: {
        signal: new AbortController().signal,
        interruption: null,
      },
      processTermination: {
        gracePeriodMs: 50,
        forceKillTimeoutMs: 250,
      },
    },
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

function createConfig(): ToolExecutionConfig {
  return {
    permissionMode: "trusted",
    audit: "optional",
    telemetry: "optional",
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
