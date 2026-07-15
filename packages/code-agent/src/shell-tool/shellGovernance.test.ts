import { access, mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ToolExecutionBoundary,
  type ToolExecutionConfig,
} from "@agent-anything/agent-core";
import type { AgentTask, TaskWorkspaceScope } from "@agent-anything/agent-core";
import type {
  PolicyCheckInput,
  PolicyPort,
  WorkspaceContext,
} from "@agent-anything/governance";

import { ToolRegistry, type ToolCall } from "@agent-anything/tools";
import {
  CODE_AGENT_RUN_COMMAND_TOOL,
  registerCodeAgentShellTool,
} from "./index.js";

describe("shell governance integration", () => {
  let testRoot: string;
  let codeRoot: string;
  let docsRoot: string;
  let markerPath: string;

  beforeEach(async () => {
    testRoot = await mkdtemp(join(tmpdir(), "agent-anything-shell-gov-"));
    codeRoot = join(testRoot, "code");
    docsRoot = join(testRoot, "docs");
    markerPath = join(docsRoot, "work", "marker.txt");
    await mkdir(codeRoot);
    await mkdir(join(docsRoot, "work"), { recursive: true });
  });

  afterEach(async () => {
    await rm(testRoot, { recursive: true, force: true });
  });

  it("policy denial prevents process creation before the approval gate", async () => {
    const setup = createBoundary({
      policyPort: createPolicyPort((input) => ({
        checkId: input.id,
        status: "denied",
        code: "policy_denied",
        reason: "Command denied by policy.",
        decidedAt: "2026-06-20T00:00:00.000Z",
      })),
    });

    const outcome = await setup.boundary.execute(createExecuteInput());

    expect(outcome).toMatchObject({
      status: "blocked",
      errors: [{ code: "policy_denied" }],
    });
    await expect(access(markerPath)).rejects.toThrow();
  });

  it("the temporary approval gate prevents risky process creation", async () => {
    const setup = createBoundary({
      policyPort: allowPolicy(),
    });

    const outcome = await setup.boundary.execute(createExecuteInput());

    expect(outcome).toMatchObject({
      status: "blocked",
      errors: [{
        owner: "permission",
        code: "permission_approval_required",
        message: "Create a governed marker file.",
      }],
    });
    await expect(access(markerPath)).rejects.toThrow();
  });

  it("passes selected workspace and command metadata to governance", async () => {
    let policyInput: PolicyCheckInput | undefined;
    const setup = createBoundary({
      policyPort: createPolicyPort((input) => {
        policyInput = input;
        return {
          checkId: input.id,
          status: "allowed",
          decidedAt: "2026-06-20T00:00:00.000Z",
        };
      }),
    });

    const outcome = await setup.boundary.execute(createExecuteInput());

    expect(outcome).toMatchObject({
      status: "blocked",
      errors: [{
        owner: "permission",
        code: "permission_approval_required",
        message: "Create a governed marker file.",
      }],
    });
    expect(policyInput).toMatchObject({
      risk: "risky",
      workspace: {
        id: "workspace-docs",
        trustLevel: "trusted",
      },
      target: {
        metadata: {
          command: process.execPath,
          cwd: "work",
          rootName: "docs",
          workspaceId: "workspace-docs",
          timeoutMs: 1_000,
        },
      },
      metadata: {
        taskKind: "code.change",
      },
    });
    await expect(access(markerPath)).rejects.toThrow();
  });

  it("rejects a ToolCall that downgrades risky definition to safe", async () => {
    let policyChecked = false;
    const setup = createBoundary({
      policyPort: createPolicyPort((input) => {
        policyChecked = true;
        return {
          checkId: input.id,
          status: "allowed",
          decidedAt: "2026-06-20T00:00:00.000Z",
        };
      }),
    });
    const executeInput = createExecuteInput();
    executeInput.toolCall = {
      ...executeInput.toolCall,
      risk: "safe",
    };

    const outcome = await setup.boundary.execute(executeInput);

    expect(outcome).toMatchObject({
      status: "failed",
      errors: [{ code: "tool_risk_mismatch" }],
    });
    expect(policyChecked).toBe(false);
    await expect(access(markerPath)).rejects.toThrow();
  });
  function createBoundary(input: {
    policyPort?: PolicyPort;
  }) {
    const registry = new ToolRegistry();
    const workspaceScope = createScope();
    const executionContextResolver = registerCodeAgentShellTool(
      registry,
      {
        workspaceScope,
        limits: {
          defaultTimeoutMs: 1_000,
          maxTimeoutMs: 2_000,
        },
      },
    );

    return {
      boundary: new ToolExecutionBoundary({
        toolRegistry: registry,
        evidenceBuilder: {
          buildFromToolResult: () => [],
        },
        policyPort: input.policyPort,
        toolExecutionContextResolver: executionContextResolver,
      }),
    };
  }

  function createExecuteInput() {
    return {
      task: createTask(),
      toolCall: createShellCall(),
      config: createConfig(),
      workspace: createWorkspace("workspace-code", codeRoot),
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
      id: "task-shell",
      kind: "code.change",
      input: {},
      createdAt: "2026-06-20T00:00:00.000Z",
      metadata: {},
      workspaceScope: createScope(),
    };
  }

  function createScope(): TaskWorkspaceScope {
    return {
      roots: {
        code: createWorkspace("workspace-code", codeRoot),
        docs: createWorkspace("workspace-docs", docsRoot),
      },
      defaultRootName: "code",
    };
  }
});

function createShellCall(): ToolCall {
  return {
    id: "tool-call-shell",
    toolName: CODE_AGENT_RUN_COMMAND_TOOL,
    input: {
      command: process.execPath,
      args: [
        "-e",
        "require('node:fs').writeFileSync('marker.txt', 'ran')",
      ],
      rootName: "docs",
      cwd: "work",
      timeoutMs: 1_000,
      reason: "Create a governed marker file.",
    },
    risk: "risky",
    metadata: {},
  };
}

function createConfig(): ToolExecutionConfig {
  return {
    audit: "optional",
    telemetry: "optional",
  };
}

function createWorkspace(
  id: string,
  rootRef: string,
): WorkspaceContext {
  return {
    id,
    name: id,
    rootRef,
    trustState: "trusted",
    source: "test",
    policyRefs: [],
    metadata: {},
  };
}

function allowPolicy(): PolicyPort {
  return createPolicyPort((input) => ({
    checkId: input.id,
    status: "allowed",
    decidedAt: "2026-06-20T00:00:00.000Z",
  }));
}
function createPolicyPort(
  evaluate: (
    input: Parameters<PolicyPort["evaluate"]>[0],
  ) => Awaited<ReturnType<PolicyPort["evaluate"]>> | ReturnType<PolicyPort["evaluate"]>,
): PolicyPort {
  return {
    async evaluate(input) {
      return evaluate(input);
    },
  };
}
