import { describe, expect, it } from "vitest";
import type { Evidence } from "../../evidence/index.js";
import { EvidenceBuilder } from "../../evidence/index.js";
import type { AuditPort } from "../../audit/index.js";
import type { IdentityProvider } from "../../identity/index.js";
import type { PolicyPort } from "../../governance/index.js";
import type { PermissionService } from "../../permission/index.js";
import { InMemoryStorage, type StoragePort } from "../../storage/index.js";
import type { TelemetryPort } from "../../telemetry/index.js";
import {
  FakeAuditPort,
  FakeIdentityProvider,
  FakePermissionService,
  FakePolicyPort,
  FakeTelemetryPort,
  FakeWorkspaceResolver,
} from "../../testing/index.js";
import type { WorkspaceResolver } from "../../workspace/index.js";
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
    expect(result.output).toBeNull();
    expect(result.outputSpec).toEqual({
      format: "json",
      metadata: {},
    });
    expect(result.evidenceRefs).toEqual(["evidence_tool_call_001"]);
    expect(result.artifactRefs).toEqual([
      "artifact_evidence_evidence_tool_call_001",
    ]);
    expect(result.errors).toEqual([]);
  });

  it("uses createDefaultRuntime with tool calls from task input", async () => {
    const registry = new ToolRegistry();
    registry.register(createFakeTool("net.lookupDns"));
    const runtime = createDefaultRuntime({
      toolRegistry: registry,
      permissionMode: "trusted",
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
        permissionMode: "deny",
      },
    });

    const result = await runtime.run(createTask());

    expect(result.status).toBe("blocked");
    expect(result.errors[0]).toMatchObject({
      code: "permission_mode_denied",
      metadata: {
        toolCallId: "tool_call_001",
        toolName: "shell.runCommand",
      },
    });
    expect(executionCount).toBe(0);
  });

  it("maps policy denial to blocked RuntimeResult", async () => {
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
      policyPort: new FakePolicyPort((input) => ({
        checkId: input.id,
        status: "denied",
        code: "policy_denied",
        reason: "Policy blocked shell execution.",
        decidedAt: "2026-06-12T00:00:00.000Z",
      })),
      permissionService: new FakePermissionService(),
    });

    const result = await runtime.run(createTask());

    expect(result).toMatchObject({
      status: "blocked",
      output: null,
      errors: [
        {
          code: "policy_denied",
          message: "Policy blocked shell execution.",
        },
      ],
    });
    expect(executionCount).toBe(0);
  });

  it("maps policy review to blocked RuntimeResult", async () => {
    const registry = new ToolRegistry();
    registry.register(createFakeTool("shell.runCommand", { risk: "risky" }));
    const runtime = createRuntime({
      toolRegistry: registry,
      toolCalls: [createToolCall("shell.runCommand", { risk: "risky" })],
      policyPort: new FakePolicyPort((input) => ({
        checkId: input.id,
        status: "requires_review",
        decidedAt: "2026-06-12T00:00:00.000Z",
      })),
    });

    const result = await runtime.run(createTask());

    expect(result).toMatchObject({
      status: "blocked",
      errors: [
        {
          code: "policy_review_required",
        },
      ],
    });
  });

  it("maps policy failure to failed RuntimeResult", async () => {
    const registry = new ToolRegistry();
    registry.register(createFakeTool("shell.runCommand", { risk: "risky" }));
    const runtime = createRuntime({
      toolRegistry: registry,
      toolCalls: [createToolCall("shell.runCommand", { risk: "risky" })],
      policyPort: new FakePolicyPort(() => {
        throw new Error("Policy backend failed.");
      }),
    });

    const result = await runtime.run(createTask());

    expect(result).toMatchObject({
      status: "failed",
      errors: [
        {
          code: "policy_check_failed",
          message: "Policy backend failed.",
        },
      ],
    });
  });

  it("maps ask mode without host permission service to blocked RuntimeResult", async () => {
    const registry = new ToolRegistry();
    registry.register(createFakeTool("shell.runCommand", { risk: "risky" }));
    const runtime = createRuntime({
      toolRegistry: registry,
      toolCalls: [createToolCall("shell.runCommand", { risk: "risky" })],
      options: {
        ...createOptions(),
        permissionMode: "ask",
      },
    });

    const result = await runtime.run(createTask());

    expect(result).toMatchObject({
      status: "blocked",
      errors: [
        {
          code: "permission_unavailable",
        },
      ],
    });
  });

  it("maps permission service denial to blocked RuntimeResult", async () => {
    const registry = new ToolRegistry();
    registry.register(createFakeTool("shell.runCommand", { risk: "risky" }));
    const runtime = createRuntime({
      toolRegistry: registry,
      toolCalls: [createToolCall("shell.runCommand", { risk: "risky" })],
      permissionService: new FakePermissionService((request) => ({
        requestId: request.id,
        status: "denied",
        code: "permission_denied",
        reason: "Denied by host permission service.",
        decidedAt: "2026-06-12T00:00:00.000Z",
      })),
    });

    const result = await runtime.run(createTask());

    expect(result).toMatchObject({
      status: "blocked",
      errors: [
        {
          code: "permission_denied",
          message: "Denied by host permission service.",
        },
      ],
    });
  });

  it("maps permission service failure to failed RuntimeResult", async () => {
    const registry = new ToolRegistry();
    registry.register(createFakeTool("shell.runCommand", { risk: "risky" }));
    const runtime = createRuntime({
      toolRegistry: registry,
      toolCalls: [createToolCall("shell.runCommand", { risk: "risky" })],
      permissionService: new FakePermissionService(() => {
        throw new Error("Permission service failed.");
      }),
    });

    const result = await runtime.run(createTask());

    expect(result).toMatchObject({
      status: "failed",
      errors: [
        {
          code: "permission_check_failed",
          message: "Permission service failed.",
        },
      ],
    });
  });

  it("records optional audit and telemetry events during runtime execution", async () => {
    const registry = new ToolRegistry();
    registry.register(createFakeTool("shell.runCommand", { risk: "risky" }));
    const auditPort = new FakeAuditPort();
    const telemetryPort = new FakeTelemetryPort();
    const runtime = createRuntime({
      toolRegistry: registry,
      toolCalls: [createToolCall("shell.runCommand", { risk: "risky" })],
      auditPort,
      telemetryPort,
    });

    const result = await runtime.run(createTask());

    expect(result.status).toBe("succeeded");
    expect(auditPort.records.map((record) => record.eventName)).toEqual([
      "task.started",
      "policy.checked",
      "permission.resolved",
      "task.completed",
    ]);
    expect(telemetryPort.records.map((record) => record.eventName)).toEqual([
      "runtime.policy.checked",
      "runtime.permission.resolved",
      "runtime.task.completed",
    ]);
  });

  it("does not fail runtime when optional audit or telemetry recording fails", async () => {
    const registry = new ToolRegistry();
    registry.register(createFakeTool("net.lookupDns"));
    const runtime = createRuntime({
      toolRegistry: registry,
      toolCalls: [createToolCall("net.lookupDns")],
      auditPort: new FakeAuditPort(() => {
        throw new Error("Audit failed.");
      }),
      telemetryPort: new FakeTelemetryPort(() => {
        throw new Error("Telemetry failed.");
      }),
    });

    const result = await runtime.run(createTask());

    expect(result.status).toBe("succeeded");
  });

  it("fails runtime when required audit recording fails", async () => {
    const registry = new ToolRegistry();
    registry.register(createFakeTool("net.lookupDns"));
    const runtime = createRuntime({
      toolRegistry: registry,
      toolCalls: [createToolCall("net.lookupDns")],
      auditPort: new FakeAuditPort(() => {
        throw new Error("Audit failed.");
      }),
      options: {
        ...createOptions(),
        auditMode: "required",
      },
    });

    const result = await runtime.run(createTask());

    expect(result).toMatchObject({
      status: "failed",
      errors: [
        {
          code: "audit_required_failed",
          message: "Audit failed.",
        },
      ],
    });
  });

  it("fails runtime when required telemetry recording fails", async () => {
    const registry = new ToolRegistry();
    registry.register(createFakeTool("net.lookupDns"));
    const runtime = createRuntime({
      toolRegistry: registry,
      toolCalls: [createToolCall("net.lookupDns")],
      telemetryPort: new FakeTelemetryPort(() => {
        throw new Error("Telemetry failed.");
      }),
      options: {
        ...createOptions(),
        telemetryMode: "required",
      },
    });

    const result = await runtime.run(createTask());

    expect(result).toMatchObject({
      status: "failed",
      errors: [
        {
          code: "runtime_telemetry_required_failed",
          message: "Telemetry failed.",
        },
      ],
    });
  });

  it("passes workspace and identity context into policy checks", async () => {
    const registry = new ToolRegistry();
    registry.register(createFakeTool("shell.runCommand", { risk: "risky" }));
    const policyPort = new FakePolicyPort();
    const workspaceResolver = new FakeWorkspaceResolver({
      id: "workspace_001",
      name: "Workspace 001",
      rootRef: "D:/projects/example",
      policyRefs: ["policy_workspace"],
      metadata: {
        trustLevel: "restricted",
      },
    });
    const identityProvider = new FakeIdentityProvider({
      id: "user_001",
      kind: "user",
      displayName: "Test User",
      metadata: {
        role: "tester",
      },
    });
    const runtime = createRuntime({
      toolRegistry: registry,
      toolCalls: [createToolCall("shell.runCommand", { risk: "risky" })],
      policyPort,
      workspaceResolver,
      identityProvider,
    });

    const result = await runtime.run(createTask());

    expect(result.status).toBe("succeeded");
    expect(policyPort.checks[0]).toMatchObject({
      subject: {
        kind: "user",
        id: "user_001",
        displayName: "Test User",
      },
      workspace: {
        id: "workspace_001",
        trustLevel: "restricted",
      },
    });
  });

  it("maps workspace resolver failure to runtime failure", async () => {
    const registry = new ToolRegistry();
    registry.register(createFakeTool("net.lookupDns"));
    const runtime = createRuntime({
      toolRegistry: registry,
      toolCalls: [createToolCall("net.lookupDns")],
      workspaceResolver: new FakeWorkspaceResolver(() => {
        throw new Error("Workspace unavailable.");
      }),
    });

    const result = await runtime.run(createTask());

    expect(result).toMatchObject({
      status: "failed",
      errors: [
        {
          code: "runtime_workspace_resolution_failed",
          message: "Workspace unavailable.",
        },
      ],
    });
  });

  it("maps identity provider failure to runtime failure", async () => {
    const registry = new ToolRegistry();
    registry.register(createFakeTool("net.lookupDns"));
    const runtime = createRuntime({
      toolRegistry: registry,
      toolCalls: [createToolCall("net.lookupDns")],
      identityProvider: new FakeIdentityProvider(() => {
        throw new Error("Identity unavailable.");
      }),
    });

    const result = await runtime.run(createTask());

    expect(result).toMatchObject({
      status: "failed",
      errors: [
        {
          code: "runtime_identity_resolution_failed",
          message: "Identity unavailable.",
        },
      ],
    });
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
      output: null,
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
          code: "runtime_evidence_creation_failed",
          message: "Evidence builder failed.",
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
      },
    });

    const result = await runtime.run(createTask());

    expect(result).toMatchObject({
      status: "failed",
      evidenceRefs: ["evidence_tool_call_001"],
      artifactRefs: [],
      errors: [
        {
          code: "storage_write_failed",
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
    expect(result.output).toEqual({
      conclusion: "Loop completed.",
    });
    expect(result.evidenceRefs).toEqual(["evidence_tool_call_001"]);
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
      output: null,
      errors: [
        {
          code: "provider_planner_failed",
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
  storage?: StoragePort;
  agentLoop?: AgentLoop;
  policyPort?: PolicyPort;
  permissionService?: PermissionService;
  auditPort?: AuditPort;
  telemetryPort?: TelemetryPort;
  workspaceResolver?: WorkspaceResolver;
  identityProvider?: IdentityProvider;
}): AgentRuntime {
  return new AgentRuntime(
    {
      toolRegistry: input.toolRegistry,
      evidenceBuilder: input.evidenceBuilder ?? new EvidenceBuilder(),
      storage: input.storage ?? new InMemoryStorage(),
      planToolCalls: () => input.toolCalls,
      agentLoop: input.agentLoop,
      policyPort: input.policyPort,
      permissionService: input.permissionService,
      auditPort: input.auditPort,
      telemetryPort: input.telemetryPort,
      workspaceResolver: input.workspaceResolver,
      identityProvider: input.identityProvider,
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
    permissionMode: "trusted",
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
