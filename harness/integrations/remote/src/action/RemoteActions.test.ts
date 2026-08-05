import {
  ActionEnforcementPipeline,
  createCanonicalActorIdentity,
  createCanonicalEnvironmentIdentity,
  createCanonicalSha256Digest,
  createCanonicalWorkspaceIdentity,
  createPreparedActionInvocation,
  createSandboxExecutionGateway,
  createTargetStateAssertions,
  createToolActionBindingSnapshot,
  type ToolActionBindingSnapshot,
} from "@agent-anything/action-execution";
import type { Controller } from "@agent-anything/agent-runtime/controller";
import type { RunResult } from "@agent-anything/agent-runtime/run";
import type { Agent } from "@agent-anything/agent-core/agent";
import type { AgentTask } from "@agent-anything/agent-core/task";
import type { ControllerDecision } from "@agent-anything/agent-runtime/controller";
import { createRunCancellationController } from "@agent-anything/agent-runtime/run";
import { Runner, type RunConfig } from "@agent-anything/agent-runtime/runner";
import { EvidenceBuilder } from "@agent-anything/context/evidence";
import type { EvidencePersistencePort } from "@agent-anything/context/persistence";
import { createAllowAllActionPolicyPort, type ManagedPermissionConstraints } from "@agent-anything/governance";
import type { ApprovalReviewerPort } from "@agent-anything/permission";
import { resolvePermissionProfile } from "@agent-anything/permission/profile";
import { createToolSelectionSnapshot } from "@agent-anything/tools";
import { describe, expect, it, vi } from "vitest";
import { createRemoteToolActionCapability } from "../tools/index.js";
import {
  createRemoteActionCapability,
  type RemoteActionCapability,
  type RemoteActionRegistrationResolver,
  type TrustedRemoteActionRegistration,
} from "./index.js";

const NOW = "2026-07-16T00:00:00.000Z";
const SERVER_FINGERPRINT = `sha256:${"a".repeat(64)}`;

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
    const capability = createRemoteActionCapability({
      registration,
      invokePort: { async invoke() { throw new Error("not executed"); } },
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
    expect(prepared.data.approvalCategory).toBe("remoteToolCall");
    expect(prepared.data.approvalPayload).toMatchObject({
      source: {
        kind: "mcp",
        sourceId: "mcp_server",
        sourceRevision: "server-revision-1",
        activationEpoch: 1,
        capabilityId: "status",
      },
      server: {
        serverId: "mcp_server",
        displayName: "MCP Server",
      },
      tool: {
        name: "status",
        displayName: "Status",
      },
      annotations: { readOnlyHint: true, destructiveHint: false },
    });
  });

  it("invalidates source activation changes before dispatch", async () => {
    const initial = httpRegistration();
    let current = initial;
    const resolver: RemoteActionRegistrationResolver = {
      async resolve() { return current; },
    };
    const capability = createRemoteActionCapability({
      registration: initial,
      registrationResolver: resolver,
      invokePort: { async invoke() { throw new Error("not executed"); } },
    });
    const context = await preparationContext();
    const adapter = capability.adapters[0]!.adapter;
    const prepared = await adapter.prepare({
      actionName: initial.actionName,
      input: { query: "status" },
    }, context);
    if (prepared.status !== "prepared") throw new Error(JSON.stringify(prepared));

    current = httpRegistration({
      source: { ...initial.source, activationEpoch: 2 },
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
    const capability = createRemoteActionCapability({
      registration,
      registrationResolver: { async resolve() { return null; } },
      invokePort: { async invoke() { throw new Error("not executed"); } },
    });
    await expect(capability.adapters[0]!.adapter.prepare({
      actionName: registration.actionName,
      input: {},
    }, await preparationContext())).resolves.toMatchObject({
      status: "rejected",
      code: "action_invalid",
    });
  });

  it("runs an HTTP remote Action through enforcement, approval, and gateway", async () => {
    const registration = httpRegistration();
    const invoke = vi.fn(async (input: {
      actionId: string;
      actionName: string;
      serverId: string;
      toolName: string;
      signal: AbortSignal;
    }) => ({
      toolCallId: input.actionId,
      toolName: input.actionName,
      status: "succeeded" as const,
      output: { answer: "remote-http-ok" },
      startedAt: NOW,
      finishedAt: NOW,
      metadata: {},
    }));
    const capability = createRemoteActionCapability({
      registration,
      invokePort: { invoke },
      now: () => NOW,
    });
    const result = await runRemoteAction(capability, registration.localToolName, { query: "status" });

    expect(result.status).toBe("succeeded");
    expect(toolResultOf(result)).toMatchObject({
      status: "succeeded",
      output: { answer: "remote-http-ok" },
    });
    expect(invoke).toHaveBeenCalledWith(expect.objectContaining({
      serverId: registration.server.serverId,
      toolName: registration.toolName,
      timeoutMs: registration.timeoutMs,
      signal: expect.any(AbortSignal),
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
    expect(prepared.data).toMatchObject({
      approvalCategory: "remoteToolCall",
      approvalPayload: {
        source: {
          kind: "remote",
          sourceId: "remote_node",
          capabilityId: "read",
        },
      },
    });

    const result = await runRemoteAction(capability, registration.localToolName, { path: "README.md" });
    expect(toolResultOf(result)).toMatchObject({ output: { answer: "remote-ok" } });
    expect(call).toHaveBeenCalledWith(expect.objectContaining({ metadata: {} }));
  });
});

function httpRegistration(
  overrides: Partial<TrustedRemoteActionRegistration> = {},
): TrustedRemoteActionRegistration {
  return {
    localToolName: "mcp.status",
    actionName: "remote.invoke.mcp.status",
    source: {
      kind: "mcp",
      sourceId: "mcp_server",
      sourceRevision: "server-revision-1",
      activationEpoch: 1,
      capabilityId: "status",
    },
    sourceDisplayName: "MCP Server",
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
    schema: {
      dialect: "json-schema-2020-12",
      translationVersion: "native-v1",
    },
    annotations: {},
    registrationVersion: "1",
    supportsSessionAuthority: true,
    timeoutMs: 1_000,
    ...overrides,
  };
}

function stdioRegistration(): TrustedRemoteActionRegistration {
  return {
    localToolName: "remote.read",
    actionName: "remote.invoke.read",
    source: {
      kind: "remote",
      sourceId: "remote_node",
      sourceRevision: "node-revision-1",
      activationEpoch: 1,
      capabilityId: "read",
    },
    sourceDisplayName: "Remote Node",
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
    schema: {
      dialect: "json-schema-2020-12",
      translationVersion: "native-v1",
    },
    annotations: { readOnlyHint: true },
    registrationVersion: "1",
    supportsSessionAuthority: false,
    timeoutMs: null,
  };
}

async function runRemoteAction(
  capability: RemoteActionCapability,
  localToolName: string,
  input: unknown,
): Promise<RunResult<{ summary: string }>> {
  const toolSelection = createToolSelectionSnapshot(
    capability.toolRegistrations,
    [{ toolName: localToolName, origins: ["model"] }],
  );
  const toolBindings = createToolActionBindingSnapshot(
    toolSelection,
    capability.actionRegistrations,
  );
  const pipeline = new ActionEnforcementPipeline({
    registrations: capability.actionRegistrations,
    toolBindings,
    adapters: capability.adapters,
    policyPort: createAllowAllActionPolicyPort(),
    now: () => NOW,
  });
  const gateway = createSandboxExecutionGateway({
    registrations: capability.actionRegistrations,
    executors: capability.executors,
    limits: { maxResultBytes: 1_000_000 },
    now: () => NOW,
  });
  const runner = new Runner({
    controller: new ScriptedController(localToolName, input),
    actionEnforcementPipeline: pipeline,
    sandboxExecutionGateway: gateway,
    evidenceBuilder: new EvidenceBuilder(),
    evidencePersistence: createEvidencePersistence(),
    now: () => NOW,
  });
  return runner.run(
    agent(),
    { task: task(), items: [], metadata: {} },
    await runConfig(localToolName, toolBindings),
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
          actions: [{
            kind: "tool",
            name: this.actionName,
            input: this.input,
            origin: "model",
            modelItemId: "model_1",
          }],
          modelItems: [{ id: "model_1", kind: "assistant", content: {}, metadata: {} }],
        }
      : {
          kind: "final_output",
          output: { summary: "done" },
          modelItems: [{ id: "model_2", kind: "assistant", content: {}, metadata: {} }],
        };
  }
}

function agent(): Agent<{ summary: string }> {
  return {
    id: "remote_test_agent",
    name: "Remote Test Agent",
    instructions: "Execute one remote Action.",
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

async function runConfig(
  localToolName: string,
  toolBindings: ToolActionBindingSnapshot,
): Promise<RunConfig> {
  const runId = `run_${localToolName.replaceAll(".", "_")}`;
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
    workspace: { primary: workspace(), additional: [] },
    identity: { id: "user_remote", kind: "user", displayName: "Test User", metadata: {} },
    actionContext: await preparationContext(),
    toolBindings,
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
    "agent-anything.remote-integrations.remote-test-root.v1",
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
        "agent-anything.remote-integrations.remote-test-environment.v1",
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

function createEvidencePersistence(): EvidencePersistencePort {
  return {
    async persistEvidence(evidence) {
      return {
        status: "stored",
        artifact: {
          storageId: `remote_test_${evidence.id}`,
          evidenceRef: evidence.id,
          artifactRef: `memory://remote-test/${evidence.id}`,
          createdAt: NOW,
          metadata: {},
        },
      };
    },
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
