import { createHash } from "node:crypto";
import { mkdtemp, readFile, unlink, writeFile } from "node:fs/promises";
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
  Runner,
  type Agent,
  type AgentTask,
  type Controller,
  type ControllerDecision,
  type RunConfig,
  type RunResult,
} from "@agent-anything/agent-core";
import { EvidenceBuilder } from "@agent-anything/evidence";
import { createAllowAllActionPolicyPort, type ManagedPermissionConstraints } from "@agent-anything/governance";
import { resolvePermissionProfile } from "@agent-anything/permission/profile";
import { InMemoryStorage } from "@agent-anything/storage";
import type { ToolDescriptor } from "@agent-anything/tools";
import { describe, expect, it } from "vitest";
import { acceptPatch, createPatchProposal } from "../patch/index.js";
import {
  CODE_AGENT_CREATE_FILE_ACTION,
  CODE_AGENT_DELETE_FILE_ACTION,
  CODE_AGENT_LIST_FILES_ACTION,
  CODE_AGENT_READ_FILE_ACTION,
  CODE_AGENT_SEARCH_FILES_ACTION,
  CODE_AGENT_UPDATE_FILE_ACTION,
  createAcceptedPatchFileAction,
  createCodeAgentCanonicalWorkspaceRoots,
  createCodeAgentFileActionCapability,
} from "./index.js";

const NOW = "2026-07-16T00:00:00.000Z";

describe("code-agent file Actions", () => {
  it("separates declarative catalog entries from trusted execution registrations", async () => {
    const fixture = await createFixture();
    const capability = createCodeAgentFileActionCapability({ workspaceScope: fixture.scope });

    expect(capability.catalog.tools.map(({ name }) => name)).toEqual([
      CODE_AGENT_LIST_FILES_ACTION,
      CODE_AGENT_READ_FILE_ACTION,
      CODE_AGENT_SEARCH_FILES_ACTION,
      CODE_AGENT_CREATE_FILE_ACTION,
      CODE_AGENT_UPDATE_FILE_ACTION,
      CODE_AGENT_DELETE_FILE_ACTION,
    ]);
    expect(capability.catalog.tools.every((tool) => !("execute" in tool))).toBe(true);
    expect(capability.registrations.registrations.map(({ actionName }) => actionName))
      .toEqual(capability.catalog.tools.map(({ name }) => name));
    expect(capability.executors).toHaveLength(1);
  });

  it("runs read, list, search, create, update, and delete only through Runner and gateway", async () => {
    const fixture = await createFixture();
    await writeFile(join(fixture.root, "source.txt"), "alpha\nbeta alpha\n", "utf8");

    expect(await outputOf(await runFileAction(fixture, CODE_AGENT_READ_FILE_ACTION, {
      path: "source.txt",
    }))).toMatchObject({ content: "alpha\nbeta alpha\n", sizeBytes: 17 });
    expect(await outputOf(await runFileAction(fixture, CODE_AGENT_LIST_FILES_ACTION, {
      path: ".",
    }))).toMatchObject({ entries: [expect.objectContaining({ path: "source.txt" })] });
    await writeFile(join(fixture.root, "second.txt"), "second", "utf8");
    expect(await outputOf(await runFileAction(fixture, CODE_AGENT_LIST_FILES_ACTION, {
      path: ".",
    }, { maxListEntries: 1 }))).toMatchObject({
      entries: [expect.any(Object)],
      truncated: true,
    });
    expect(await outputOf(await runFileAction(fixture, CODE_AGENT_SEARCH_FILES_ACTION, {
      path: ".",
      query: "alpha",
    }))).toMatchObject({ matches: [
      expect.objectContaining({ line: 1, column: 1 }),
      expect.objectContaining({ line: 2, column: 6 }),
    ] });

    expect(await outputOf(await runFileAction(fixture, CODE_AGENT_CREATE_FILE_ACTION, {
      path: "empty.txt",
      content: "",
    }))).toMatchObject({ created: true, bytesWritten: 0 });
    expect(await readFile(join(fixture.root, "empty.txt"), "utf8")).toBe("");

    expect(await outputOf(await runFileAction(fixture, CODE_AGENT_UPDATE_FILE_ACTION, {
      path: "empty.txt",
      content: "updated",
    }))).toMatchObject({ replaced: true, bytesWritten: 7 });
    expect(await readFile(join(fixture.root, "empty.txt"), "utf8")).toBe("updated");

    expect(await outputOf(await runFileAction(fixture, CODE_AGENT_DELETE_FILE_ACTION, {
      path: "empty.txt",
    }))).toMatchObject({ deleted: true });
    await expect(readFile(join(fixture.root, "empty.txt"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("invalidates a prepared update when its content baseline changes", async () => {
    const fixture = await createFixture();
    const target = join(fixture.root, "target.txt");
    await writeFile(target, "before", "utf8");
    const capability = createCodeAgentFileActionCapability({ workspaceScope: fixture.scope });
    const context = await actionPreparationContext(fixture);
    const adapter = capability.adapters.find(
      ({ actionName }) => actionName === CODE_AGENT_UPDATE_FILE_ACTION,
    )!.adapter;
    const prepared = await adapter.prepare({
      actionName: CODE_AGENT_UPDATE_FILE_ACTION,
      input: { path: "target.txt", content: "after" },
    }, context);
    if (prepared.status !== "prepared") throw new Error(JSON.stringify(prepared));

    await writeFile(target, "changed", "utf8");
    const revalidated = await adapter.revalidate(
      createPreparedActionInvocation(prepared.data.preparedInvocation),
      createTargetStateAssertions(prepared.data.targetAssertions),
      context,
    );
    expect(revalidated).toMatchObject({
      status: "invalidated",
      code: "tool_file_target_changed",
    });
    expect(await readFile(target, "utf8")).toBe("changed");
  });

  it("rejects extra fields, outside-root paths, existing creates, and oversize content", async () => {
    const fixture = await createFixture();
    await writeFile(join(fixture.root, "exists.txt"), "x", "utf8");
    const capability = createCodeAgentFileActionCapability({
      workspaceScope: fixture.scope,
      limits: { maxWriteBytes: 3 },
    });
    const context = await actionPreparationContext(fixture);
    const createAdapter = capability.adapters.find(
      ({ actionName }) => actionName === CODE_AGENT_CREATE_FILE_ACTION,
    )!.adapter;

    await expect(createAdapter.prepare({
      actionName: CODE_AGENT_CREATE_FILE_ACTION,
      input: { path: "new.txt", content: "x", surprise: true },
    }, context)).resolves.toMatchObject({ status: "rejected", code: "action_invalid" });
    await expect(createAdapter.prepare({
      actionName: CODE_AGENT_CREATE_FILE_ACTION,
      input: { path: "../outside.txt", content: "x" },
    }, context)).resolves.toMatchObject({ status: "rejected", code: "action_invalid" });
    await expect(createAdapter.prepare({
      actionName: CODE_AGENT_CREATE_FILE_ACTION,
      input: { path: "exists.txt", content: "x" },
    }, context)).resolves.toMatchObject({ status: "rejected", code: "action_invalid" });
    await expect(createAdapter.prepare({
      actionName: CODE_AGENT_CREATE_FILE_ACTION,
      input: { path: "new.txt", content: "four" },
    }, context)).resolves.toMatchObject({ status: "rejected", code: "action_invalid" });
  });

  it("returns attributed interruption before filesystem preparation", async () => {
    const fixture = await createFixture();
    const capability = createCodeAgentFileActionCapability({ workspaceScope: fixture.scope });
    const context = await actionPreparationContext(fixture);
    const controller = new AbortController();
    const interruption = {
      kind: "run_cancellation" as const,
      cancellation: { runId: "run_cancelled", requestId: "request_cancelled" },
    };
    controller.abort(interruption);
    const adapter = capability.adapters[0]!.adapter;

    await expect(adapter.prepare({
      actionName: CODE_AGENT_LIST_FILES_ACTION,
      input: { path: "." },
    }, { ...context, interruption: { signal: controller.signal, interruption } }))
      .resolves.toEqual({ status: "interrupted", interruption });
  });

  it("translates accepted patch baselines into canonical mutation Action input", async () => {
    const fixture = await createFixture();
    await writeFile(join(fixture.root, "patch.txt"), "before", "utf8");
    const proposed = await createPatchProposal({
      workspaceScope: fixture.scope,
      change: { kind: "update", path: "patch.txt", proposedContent: "after" },
      summary: "Update patch file",
      rationale: "Test canonical patch translation",
    }, { createPatchId: () => "patch_1", now: () => NOW });
    const action = createAcceptedPatchFileAction(acceptPatch(proposed, { now: () => NOW }));

    expect(action).toEqual({
      actionName: CODE_AGENT_UPDATE_FILE_ACTION,
      input: {
        rootName: "root",
        path: "patch.txt",
        expectedContentDigest: `sha256:${createHash("sha256").update("before").digest("hex")}`,
        content: "after",
      },
    });
  });
});

interface Fixture {
  readonly root: string;
  readonly workspace: NonNullable<AgentTask["workspaceScope"]>["roots"][string];
  readonly scope: NonNullable<AgentTask["workspaceScope"]>;
  readonly platform: "win32" | "posix";
}

async function createFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "code-agent-action-"));
  const workspace = {
    id: "workspace_1",
    name: "Workspace",
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

async function runFileAction(
  fixture: Fixture,
  actionName: string,
  input: Record<string, unknown>,
  limits?: Parameters<typeof createCodeAgentFileActionCapability>[0]["limits"],
): Promise<RunResult<{ summary: string }>> {
  const capability = createCodeAgentFileActionCapability({
    workspaceScope: fixture.scope,
    limits,
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
  const runId = `run_${actionName.replaceAll(".", "_")}`;
  const controller = new ScriptedController(actionName, input);
  const runner = new Runner({
    controller,
    actionEnforcementPipeline: pipeline,
    sandboxExecutionGateway: gateway,
    evidenceBuilder: new EvidenceBuilder(),
    evidenceStorage: new InMemoryStorage(),
    now: () => NOW,
  });
  return runner.run(
    agent(actionName),
    {
      runId,
      task: task(fixture),
      conversationItems: [],
      metadata: {},
    },
    await runConfig(fixture, runId),
  );
}

class ScriptedController implements Controller<unknown> {
  private iteration = 0;
  constructor(private readonly actionName: string, private readonly input: unknown) {}

  async next(): Promise<ControllerDecision<unknown>> {
    this.iteration += 1;
    if (this.iteration === 1) {
      return {
        kind: "actions",
        actions: [{ kind: "tool", name: this.actionName, input: this.input, modelItemId: "model_1" }],
        modelItems: [{ id: "model_1", kind: "assistant", content: {}, metadata: {} }],
      };
    }
    return {
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
    id: "code_agent_test",
    name: "Code Agent Test",
    instructions: "Execute one test Action.",
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
    id: "task_1",
    kind: "test.code-agent",
    input: {},
    workspaceScope: fixture.scope,
    createdAt: NOW,
    metadata: {},
  };
}

async function runConfig(fixture: Fixture, runId: string): Promise<RunConfig> {
  const actionContext = await actionPreparationContext(fixture);
  const managedConstraints: ManagedPermissionConstraints = {
    constraintSetId: "test-disabled",
    selectableProfiles: { allowedProfileIds: null, deniedProfileIds: [] },
    fileSystem: [],
    network: { enabled: null, allowedDomains: [], deniedDomains: [] },
    allowUnenforcedExecution: true,
  };
  return {
    workspace: fixture.workspace,
    identity: { id: "user_1", kind: "user", displayName: "Test User", metadata: {} },
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

async function actionPreparationContext(fixture: Fixture) {
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
    actor: createCanonicalActorIdentity({ identityId: "user_1", kind: "user" }),
    environment: createCanonicalEnvironmentIdentity({
      environmentId: "test-local",
      platform: fixture.platform,
      configurationFingerprint: await createCanonicalSha256Digest(
        "agent-anything.code-agent.test-environment.v1",
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

function outputOf(result: RunResult<{ summary: string }>): unknown {
  expect(result.status).toBe("succeeded");
  const observation = result.items.find((item) => item.kind === "observation" &&
    item.observation.kind === "tool_result");
  if (observation?.kind !== "observation" || observation.observation.kind !== "tool_result") {
    throw new Error(`Expected a ToolResult observation: ${JSON.stringify(result)}`);
  }
  return observation.observation.result.output;
}
