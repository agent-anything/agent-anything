import {
  ActionEnforcementPipeline,
  createCanonicalActorIdentity,
  createCanonicalEnvironmentIdentity,
  createCanonicalSha256Digest,
  createCanonicalWorkspaceIdentity,
  createPreparedActionInvocation,
  createSandboxExecutionGateway,
  createTargetStateAssertions,
} from "@agent-anything/action-execution";
import {
  createRunCancellationController,
  type Agent,
  type AgentTask,
  type Controller,
  type ControllerDecision,
  type RunResult,
} from "@agent-anything/agent-core";
import { Runner, type RunConfig } from "@agent-anything/agent-runtime";
import { EvidenceBuilder } from "@agent-anything/evidence";
import { createAllowAllActionPolicyPort, type ManagedPermissionConstraints } from "@agent-anything/governance";
import type { ApprovalReviewerPort } from "@agent-anything/permission";
import { resolvePermissionProfile } from "@agent-anything/permission/profile";
import { InMemoryStorage } from "@agent-anything/storage";
import type { ToolDescriptor } from "@agent-anything/tools";
import { describe, expect, it, vi } from "vitest";
import { createMcpActionCapability } from "../mcp/index.js";
import { createRemoteToolActionCapability } from "../remote-tools/index.js";
import type {
  RemoteActionCapability,
  RemoteActionRegistrationResolver,
  TrustedRemoteActionRegistration,
} from "./index.js";

const NOW = "2026-07-16T00:00:00.000Z";
const SERVER_FINGERPRINT = `sha256:${"a".repeat(64)}`;
const CHANGED_FINGERPRINT = `sha256:${"b".repeat(64)}`;

describe("canonical remote Actions", () => {
  it("derives remote and network effects from trusted registration, never annotations", async () => {
    const registration = httpRegistration({
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    });
    const capability = createMcpActionCapability({
      registration,
      connectionPort: { async callTool() { throw new Error("not executed"); } },
    });
    const prepared = await capability.adapters[0]!.adapter.prepare({
      actionName: registration.actionName,
      input: { query: "status" },
    }, await preparationContext());
    if (prepared.status !== "prepared") throw new Error(JSON.stringify(prepared));

    expect(prepared.data.effectSet).toMatchObject({
      kind: "effects",
      values: expect.arrayContaining([
        expect.objectContaining({ kind: "remote_tool", operation: "invoke" }),
        expect.objectContaining({ kind: "network", operation: "connect" }),
      ]),
    });
    expect(prepared.data.approvalCategory).toBe("mcpToolCall");
    expect(prepared.data.approvalPayload).toMatchObject({
      annotations: { readOnlyHint: true, destructiveHint: false },
    });
  });

  it("invalidates endpoint or registration-fingerprint changes before dispatch", async () => {
    const initial = httpRegistration();
    let current = initial;
    const resolver: RemoteActionRegistrationResolver = {
      async resolve() { return current; },
    };
    const capability = createMcpActionCapability({
      registration: initial,
      registrationResolver: resolver,
      connectionPort: { async callTool() { throw new Error("not executed"); } },
    });
    const context = await preparationContext();
    const adapter = capability.adapters[0]!.adapter;
    const prepared = await adapter.prepare({
      actionName: initial.actionName,
      input: { query: "status" },
    }, context);
    if (prepared.status !== "prepared") throw new Error(JSON.stringify(prepared));

    current = httpRegistration({
      server: { ...initial.server, registrationFingerprint: CHANGED_FINGERPRINT },
    });
    await expect(adapter.revalidate(
      createPreparedActionInvocation(prepared.data.preparedInvocation),
      createTargetStateAssertions(prepared.data.targetAssertions),
      context,
    )).resolves.toMatchObject({
      status: "invalidated",
      code: "remote_registration_changed",
    });
  });

  it("rejects unavailable trusted registration instead of falling back to Tool metadata", async () => {
    const registration = httpRegistration();
    const capability = createMcpActionCapability({
      registration,
      registrationResolver: { async resolve() { return null; } },
      connectionPort: { async callTool() { throw new Error("not executed"); } },
    });
    await expect(capability.adapters[0]!.adapter.prepare({
      actionName: registration.actionName,
      input: {},
    }, await preparationContext())).resolves.toMatchObject({
      status: "rejected",
      code: "action_invalid",
    });
  });

  it("runs MCP through the enforcement pipeline, approval, and gateway", async () => {
    const registration = httpRegistration();
    const callTool = vi.fn(async (input: {
      serverId: string;
      toolName: string;
      toolCallId: string;
    }) => ({
      toolCallId: input.toolCallId,
      toolName: input.toolName,
      output: { answer: "mcp-ok" },
      metadata: {},
    }));
    const capability = createMcpActionCapability({
      registration,
      connectionPort: { callTool },
      now: () => NOW,
    });
    const result = await runRemoteAction(capability, registration.actionName, { query: "status" });

    expect(result.status).toBe("succeeded");
    expect(toolResultOf(result)).toMatchObject({
      status: "succeeded",
      output: { answer: "mcp-ok" },
    });
    expect(callTool).toHaveBeenCalledWith(expect.objectContaining({
      serverId: registration.server.serverId,
      toolName: registration.toolName,
      timeoutMs: registration.timeoutMs,
      metadata: {},
    }));
  });

  it("runs stdio remote Tool without inventing a network effect", async () => {
    const registration = stdioRegistration();
    const call = vi.fn(async (input: {
      id: string;
      toolCallId: string;
      toolName: string;
    }) => ({
      remoteCallId: input.id,
      toolResult: {
        toolCallId: input.toolCallId,
        toolName: input.toolName,
        status: "succeeded" as const,
        output: { answer: "remote-ok" },
        error: null,
        startedAt: NOW,
        finishedAt: NOW,
        metadata: {},
      },
      metadata: {},
    }));
    const capability = createRemoteToolActionCapability({
      registration,
      remoteToolPort: { call },
      now: () => NOW,
    });
    const prepared = await capability.adapters[0]!.adapter.prepare({
      actionName: registration.actionName,
      input: { path: "README.md" },
    }, await preparationContext());
    if (prepared.status !== "prepared") throw new Error(JSON.stringify(prepared));
    expect(prepared.data.effectSet).toMatchObject({
      kind: "effects",
      values: [expect.objectContaining({ kind: "remote_tool" })],
    });

    const result = await runRemoteAction(capability, registration.actionName, { path: "README.md" });
    expect(toolResultOf(result)).toMatchObject({ output: { answer: "remote-ok" } });
    expect(call).toHaveBeenCalledWith(expect.objectContaining({ metadata: {} }));
  });
});

function httpRegistration(
  overrides: Partial<TrustedRemoteActionRegistration> = {},
): TrustedRemoteActionRegistration {
  return {
    actionName: "mcp.status",
    server: {
      serverId: "mcp_server",
      registrationFingerprint: SERVER_FINGERPRINT,
      transport: "http",
      endpoint: {
        transport: "tcp",
        host: "127.0.0.1",
        port: 8080,
        applicationProtocol: "http",
      },
    },
    serverDisplayName: "MCP Server",
    toolName: "status",
    toolDisplayName: "Status",
    description: "Read remote status.",
    inputSchema: { type: "object" },
    annotations: {},
    supportsSessionAuthority: true,
    timeoutMs: 1_000,
    ...overrides,
  };
}

function stdioRegistration(): TrustedRemoteActionRegistration {
  return {
    actionName: "remote.read",
    server: {
      serverId: "remote_node",
      registrationFingerprint: SERVER_FINGERPRINT,
      transport: "stdio",
      endpoint: null,
    },
    serverDisplayName: "Remote Node",
    toolName: "read",
    toolDisplayName: "Read",
    inputSchema: { type: "object" },
    annotations: { readOnlyHint: true },
    supportsSessionAuthority: false,
    timeoutMs: null,
  };
}

async function runRemoteAction(
  capability: RemoteActionCapability,
  actionName: string,
  input: unknown,
): Promise<RunResult<{ summary: string }>> {
  const pipeline = new ActionEnforcementPipeline({
    registrations: capability.registrations,
    adapters: capability.adapters,
    policyPort: createAllowAllActionPolicyPort(),
    now: () => NOW,
  });
  const gateway = createSandboxExecutionGateway({
    registrations: capability.registrations,
    executors: capability.executors,
    limits: { maxResultBytes: 1_000_000 },
    now: () => NOW,
  });
  const runner = new Runner({
    controller: new ScriptedController(actionName, input),
    actionEnforcementPipeline: pipeline,
    sandboxExecutionGateway: gateway,
    evidenceBuilder: new EvidenceBuilder(),
    evidenceStorage: new InMemoryStorage(),
    now: () => NOW,
  });
  return runner.run(
    agent(actionName),
    { runId: `run_${actionName.replaceAll(".", "_")}`, task: task(), conversationItems: [], metadata: {} },
    await runConfig(actionName),
  );
}

class ScriptedController implements Controller<unknown> {
  private iteration = 0;
  constructor(private readonly actionName: string, private readonly input: unknown) {}
  async next(): Promise<ControllerDecision<unknown>> {
    this.iteration += 1;
    return this.iteration === 1
      ? {
          kind: "actions",
          actions: [{ kind: "tool", name: this.actionName, input: this.input, modelItemId: "model_1" }],
          modelItems: [{ id: "model_1", kind: "assistant", content: {}, metadata: {} }],
        }
      : {
          kind: "final_output",
          output: { summary: "done" },
          modelItems: [{ id: "model_2", kind: "assistant", content: {}, metadata: {} }],
        };
  }
}

function agent(actionName: string): Agent<{ summary: string }> {
  const descriptor: ToolDescriptor = {
    name: actionName,
    inputSchema: {},
    annotations: {},
    metadata: {},
  };
  return {
    id: "remote_test_agent",
    name: "Remote Test Agent",
    instructions: "Execute one remote Action.",
    tools: [descriptor],
    output: {
      validate(candidate) {
        return typeof candidate === "object" && candidate !== null &&
          "summary" in candidate && typeof candidate.summary === "string"
          ? { valid: true, output: { summary: candidate.summary } }
          : { valid: false, message: "summary required" };
      },
    },
    metadata: {},
  };
}

function task(): AgentTask {
  return {
    id: "task_remote",
    kind: "test.remote",
    input: {},
    workspaceScope: {
      defaultRootName: "root",
      roots: { root: workspace() },
    },
    createdAt: NOW,
    metadata: {},
  };
}

function workspace() {
  return {
    id: "workspace_remote",
    name: "Remote Workspace",
    rootRef: process.cwd(),
    trustState: "trusted" as const,
    source: "test",
    policyRefs: [],
    metadata: {},
  };
}

async function runConfig(actionName: string): Promise<RunConfig> {
  const runId = `run_${actionName.replaceAll(".", "_")}`;
  const managedConstraints: ManagedPermissionConstraints = {
    constraintSetId: "test-disabled",
    selectableProfiles: { allowedProfileIds: null, deniedProfileIds: [] },
    fileSystem: [],
    network: { enabled: null, allowedDomains: [], deniedDomains: [] },
    allowUnenforcedExecution: true,
  };
  const reviewer: ApprovalReviewerPort = {
    async review(input) {
      const option = input.request.decisionOptions.find(({ kind }) => kind === "accept");
      if (option === undefined) throw new Error("Accept option missing.");
      return {
        status: "decided",
        submission: {
          submissionId: "submission_remote",
          runId: input.request.runId,
          requestId: input.request.id,
          pendingVersion: input.pendingVersion,
          optionId: option.id,
          grantedPermissions: null,
          reason: null,
        },
        rationale: null,
      };
    },
  };
  return {
    workspace: workspace(),
    identity: { id: "user_remote", kind: "user", displayName: "Test User", metadata: {} },
    actionContext: await preparationContext(),
    permissions: {
      permissionProfile: resolvePermissionProfile({
        profileId: ":danger-full-access",
        profiles: [],
        environment: {
          environmentId: "test-local",
          platform: platform(),
          workspaceRoots: [{ rootId: "workspace_remote", path: process.cwd() }],
        },
        managedConstraints,
      }),
      approvalPolicy: "on-request",
      reviewer: {
        bindingId: "binding_remote",
        kind: "user",
        reviewer,
        descriptor: {
          id: "reviewer_remote",
          kind: "user",
          displayName: "Test Reviewer",
          source: "test",
          metadata: {},
        },
        reviewTimeoutMs: null,
      },
      rules: [],
      networkRules: [],
      managedConstraints,
      sessionAuthority: null,
      persistentPolicyAmendments: null,
      approvalLimits: {
        maxRequestsPerRun: 4,
        maxRequestsPerActionFingerprint: 2,
        maxConsecutiveDeclines: 2,
        maxConsecutiveReviewFailures: 2,
      },
      authorityApplicationLimits: { commitTimeoutMs: 1_000 },
    },
    limits: {
      maxIterations: 3,
      maxActions: 2,
      maxConsecutiveActionFailures: 1,
      maxDurationMs: 10_000,
      plan: { maxSteps: 4, maxStepLength: 100, maxExplanationLength: 200 },
    },
    audit: "optional",
    telemetry: "optional",
    cancellation: createRunCancellationController({ runId }),
    cancellationLimits: {
      operationSettlementTimeoutMs: 1_000,
      processGracePeriodMs: 100,
      processForceKillTimeoutMs: 500,
      finalizationTimeoutMs: 1_000,
    },
    retry: {
      providerRequest: retryPolicy(),
      structuredOutput: retryPolicy(),
      approvalsReviewer: retryPolicy(),
    },
    metadata: {},
  };
}

async function preparationContext() {
  const rootFingerprint = await createCanonicalSha256Digest(
    "agent-anything.extensions.remote-test-root.v1",
    { path: process.cwd() },
  );
  return Object.freeze({
    workspace: createCanonicalWorkspaceIdentity({
      workspaceId: "workspace_remote",
      trustState: "trusted",
      roots: [{
        rootId: "workspace_remote",
        platform: platform(),
        path: process.cwd(),
        resolvedPath: process.cwd(),
        resolutionFingerprint: rootFingerprint,
      }],
    }),
    actor: createCanonicalActorIdentity({ identityId: "user_remote", kind: "user" }),
    environment: createCanonicalEnvironmentIdentity({
      environmentId: "test-local",
      platform: platform(),
      configurationFingerprint: await createCanonicalSha256Digest(
        "agent-anything.extensions.remote-test-environment.v1",
        { platform: platform() },
      ),
    }),
    interruption: { signal: new AbortController().signal, interruption: null },
  });
}

function platform(): "win32" | "posix" {
  return process.platform === "win32" ? "win32" : "posix";
}

function retryPolicy() {
  return {
    maxRetries: 0,
    delay: {
      kind: "exponential_jitter" as const,
      baseDelayMs: 0,
      maxDelayMs: 0,
      multiplier: 2 as const,
      jitterRatio: 0.1 as const,
    },
    retryableCategories: [] as string[],
    serverDelay: { mode: "ignore" as const },
  };
}

function toolResultOf(result: RunResult<{ summary: string }>) {
  const observation = result.items.find((item) => item.kind === "observation" &&
    item.observation.kind === "tool_result");
  if (observation?.kind !== "observation" || observation.observation.kind !== "tool_result") {
    throw new Error(`Expected a ToolResult observation: ${JSON.stringify(result)}`);
  }
  return observation.observation.result;
}
