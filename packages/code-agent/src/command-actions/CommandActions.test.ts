import { mkdtemp, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ActionEnforcementPipeline,
  createCanonicalActorIdentity,
  createCanonicalEnvironmentIdentity,
  createCanonicalSha256Digest,
  createCanonicalWorkspaceIdentity,
  createPreparedActionInvocation,
  createRunCancellationController,
  createSandboxExecutionGateway,
  createTargetStateAssertions,
  type Agent,
  type AgentTask,
  type Controller,
  type ControllerDecision,
  type RunResult,
} from "@agent-anything/agent-core";
import { Runner, type RunConfig } from "@agent-anything/agent-runtime";
import { EvidenceBuilder } from "@agent-anything/evidence";
import { createAllowAllActionPolicyPort, type ManagedPermissionConstraints } from "@agent-anything/governance";
import { resolvePermissionProfile } from "@agent-anything/permission/profile";
import { InMemoryStorage } from "@agent-anything/storage";
import type { ToolDescriptor } from "@agent-anything/tools";
import { describe, expect, it } from "vitest";
import { createCodeAgentCanonicalWorkspaceRoots } from "../file-actions/index.js";
import {
  CODE_AGENT_RUN_COMMAND_ACTION,
  createCodeAgentCommandActionCapability,
} from "./index.js";

const NOW = "2026-07-16T00:00:00.000Z";

describe("code-agent command Action", () => {
  it("executes an exact process only through Runner and the sandbox gateway", async () => {
    const fixture = await createFixture();
    const result = await runCommand(fixture, {
      command: process.execPath,
      args: ["-e", "process.stdout.write('canonical-command')"],
      cwd: ".",
      reason: "Verify the canonical command Action path.",
    });

    expect(result.status).toBe("succeeded");
    expect(toolResultOf(result)).toMatchObject({
      status: "succeeded",
      output: {
        stdout: "canonical-command",
        cancellationAttributed: false,
        settlementConfirmed: true,
      },
    });
  });

  it("binds process, cwd, environment, and rejects caller-supplied execution fields", async () => {
    const fixture = await createFixture();
    const capability = await createCodeAgentCommandActionCapability({
      workspaceScope: fixture.scope,
      environment: { ACTION_TEST: "trusted" },
      environmentPolicyId: "test.command.environment",
    });
    expect(capability.catalog.tools[0]).not.toHaveProperty("execute");
    const adapter = capability.adapters[0]!.adapter;
    const context = await preparationContext(fixture);

    await expect(adapter.prepare({
      actionName: CODE_AGENT_RUN_COMMAND_ACTION,
      input: {
        command: process.execPath,
        args: [],
        reason: "Invalid caller override",
        environment: { ACTION_TEST: "attacker" },
      },
    }, context)).resolves.toMatchObject({ status: "rejected", code: "action_invalid" });

    const prepared = await adapter.prepare({
      actionName: CODE_AGENT_RUN_COMMAND_ACTION,
      input: { command: process.execPath, args: [], cwd: ".", reason: "Inspect bindings" },
    }, context);
    if (prepared.status !== "prepared") throw new Error(JSON.stringify(prepared));
    expect(prepared.data.effectSet).toMatchObject({
      kind: "effects",
      values: [{ kind: "process", operation: "spawn" }],
    });
    expect(prepared.data.targetAssertions.map(({ kind }) => kind)).toEqual(expect.arrayContaining([
      "workspace_root_identity",
      "canonical_path_identity",
      "file_baseline",
      "executable_identity",
    ]));
    expect(prepared.data.approvalPayload).toMatchObject({
      environmentId: "test-local",
      commandActions: [{ kind: "process" }],
    });
  });

  it("invalidates the command when its bound workspace identity changes", async () => {
    const fixture = await createFixture();
    const capability = await createCodeAgentCommandActionCapability({ workspaceScope: fixture.scope });
    const adapter = capability.adapters[0]!.adapter;
    const context = await preparationContext(fixture);
    const prepared = await adapter.prepare({
      actionName: CODE_AGENT_RUN_COMMAND_ACTION,
      input: { command: process.execPath, args: [], cwd: ".", reason: "Bind workspace" },
    }, context);
    if (prepared.status !== "prepared") throw new Error(JSON.stringify(prepared));

    await rename(fixture.root, `${fixture.root}-moved`);
    const revalidated = await adapter.revalidate(
      createPreparedActionInvocation(prepared.data.preparedInvocation),
      createTargetStateAssertions(prepared.data.targetAssertions),
      context,
    );
    expect(revalidated).toMatchObject({ status: "invalidated", code: "command_target_changed" });
  });

  it("retains Run cancellation attribution while terminating a command process", async () => {
    const fixture = await createFixture();
    const cancellation = createRunCancellationController({ runId: "run_command_cancel" });
    const promise = runCommand(fixture, {
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      reason: "Verify process cancellation attribution.",
    }, cancellation);
    await new Promise((resolve) => setTimeout(resolve, 100));
    cancellation.requestCancellation({ origin: "user", reasonCode: "user_requested" });
    const result = await promise;
    const serialized = JSON.stringify(result);
    expect(result.status).toBe("cancelled");
    expect(serialized).toContain("run_command_cancel");
  }, 10_000);
});

interface Fixture {
  readonly root: string;
  readonly workspace: NonNullable<AgentTask["workspaceScope"]>["roots"][string];
  readonly scope: NonNullable<AgentTask["workspaceScope"]>;
  readonly platform: "win32" | "posix";
}

async function createFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "code-agent-command-action-"));
  const workspace = {
    id: "workspace_command",
    name: "Command Workspace",
    rootRef: root,
    trustState: "trusted" as const,
    source: "test",
    policyRefs: [],
    metadata: {},
  };
  return {
    root,
    workspace,
    scope: { defaultRootName: "root", roots: { root: workspace } },
    platform: process.platform === "win32" ? "win32" : "posix",
  };
}

async function runCommand(
  fixture: Fixture,
  input: Record<string, unknown>,
  cancellation = createRunCancellationController({ runId: "run_command" }),
): Promise<RunResult<{ summary: string }>> {
  const capability = await createCodeAgentCommandActionCapability({
    workspaceScope: fixture.scope,
    now: () => NOW,
  });
  const pipeline = new ActionEnforcementPipeline({
    registrations: capability.registrations,
    adapters: capability.adapters,
    policyPort: createAllowAllActionPolicyPort(),
    now: () => NOW,
  });
  const gateway = createSandboxExecutionGateway({
    registrations: capability.registrations,
    executors: capability.executors,
    limits: { maxResultBytes: 2_000_000 },
    now: () => NOW,
  });
  const runner = new Runner({
    controller: new ScriptedController(input),
    actionEnforcementPipeline: pipeline,
    sandboxExecutionGateway: gateway,
    evidenceBuilder: new EvidenceBuilder(),
    evidenceStorage: new InMemoryStorage(),
    now: () => NOW,
  });
  return runner.run(
    agent(),
    {
      runId: cancellation.context.runId,
      task: task(fixture),
      conversationItems: [],
      metadata: {},
    },
    await runConfig(fixture, cancellation),
  );
}

class ScriptedController implements Controller<unknown> {
  private iteration = 0;
  constructor(private readonly input: unknown) {}
  async next(): Promise<ControllerDecision<unknown>> {
    this.iteration += 1;
    return this.iteration === 1
      ? {
          kind: "actions",
          actions: [{
            kind: "tool",
            name: CODE_AGENT_RUN_COMMAND_ACTION,
            input: this.input,
            modelItemId: "model_command",
          }],
          modelItems: [{ id: "model_command", kind: "assistant", content: {}, metadata: {} }],
        }
      : {
          kind: "final_output",
          output: { summary: "done" },
          modelItems: [{ id: "model_final", kind: "assistant", content: {}, metadata: {} }],
        };
  }
}

function agent(): Agent<{ summary: string }> {
  const descriptor: ToolDescriptor = {
    name: CODE_AGENT_RUN_COMMAND_ACTION,
    inputSchema: {},
    annotations: {},
    metadata: {},
  };
  return {
    id: "command_test_agent",
    name: "Command Test Agent",
    instructions: "Execute one command Action.",
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

function task(fixture: Fixture): AgentTask {
  return {
    id: "task_command",
    kind: "test.command",
    input: {},
    workspaceScope: fixture.scope,
    createdAt: NOW,
    metadata: {},
  };
}

async function runConfig(
  fixture: Fixture,
  cancellation: ReturnType<typeof createRunCancellationController>,
): Promise<RunConfig> {
  const actionContext = await preparationContext(fixture);
  const managedConstraints: ManagedPermissionConstraints = {
    constraintSetId: "test-disabled",
    selectableProfiles: { allowedProfileIds: null, deniedProfileIds: [] },
    fileSystem: [],
    network: { enabled: null, allowedDomains: [], deniedDomains: [] },
    allowUnenforcedExecution: true,
  };
  return {
    workspace: fixture.workspace,
    identity: { id: "user_command", kind: "user", displayName: "Test User", metadata: {} },
    actionContext,
    permissions: {
      permissionProfile: resolvePermissionProfile({
        profileId: ":danger-full-access",
        profiles: [],
        environment: {
          environmentId: "test-local",
          platform: fixture.platform,
          workspaceRoots: actionContext.workspace.roots.map((root) => ({
            rootId: root.rootId,
            path: root.resolvedPath ?? root.canonicalPath,
          })),
        },
        managedConstraints,
      }),
      approvalPolicy: "never",
      reviewer: null,
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
    cancellation,
    cancellationLimits: {
      operationSettlementTimeoutMs: 2_000,
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

async function preparationContext(fixture: Fixture) {
  const roots = await createCodeAgentCanonicalWorkspaceRoots({
    workspaceScope: fixture.scope,
    platform: fixture.platform,
  });
  return Object.freeze({
    workspace: createCanonicalWorkspaceIdentity({
      workspaceId: fixture.workspace.id,
      trustState: fixture.workspace.trustState,
      roots,
    }),
    actor: createCanonicalActorIdentity({ identityId: "user_command", kind: "user" }),
    environment: createCanonicalEnvironmentIdentity({
      environmentId: "test-local",
      platform: fixture.platform,
      configurationFingerprint: await createCanonicalSha256Digest(
        "agent-anything.code-agent.command-test-environment.v1",
        { root: fixture.root },
      ),
    }),
    interruption: { signal: new AbortController().signal, interruption: null },
  });
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
