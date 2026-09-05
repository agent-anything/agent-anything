import {
  createStaticHostIdentityResolver,
  createStaticHostWorkspaceResolver,
  type HostIdentityResolver,
  type HostIdentitySelection,
  type HostWorkspaceResolver,
  type HostWorkspaceSelection,
} from "@agent-anything/host/context";
import type { ApprovalReviewInput } from "@agent-anything/permission";
import type {
  Provider,
  ProviderCallResult,
  ProviderRequest,
} from "@agent-anything/model-interaction";
import {
  createModelCallRef,
  createModelTurnId,
  snapshotModelToolCall,
  snapshotProviderResponse,
  type ModelJsonValue,
} from "@agent-anything/model-interaction";
import type { InvocationInterruptionContext } from "@agent-anything/agent-core/control";
import { createFakeProviderContext } from "@agent-anything/test-support";
import type { WorkspaceSelection } from "@agent-anything/workspace/selection";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { createHelarcTask } from "@agent-anything/helarc/task";
import { createHelarcProviderProfile } from "@agent-anything/helarc/configuration";
import { createDefaultHelarcInstructionSettings } from "@agent-anything/helarc/configuration";
import {
  prepareHelarcHostRun,
  type PrepareHelarcHostRunInput,
} from "./HelarcHostRunComposition.js";

type RunHelarcTestInput = Omit<
  PrepareHelarcHostRunInput,
  | "sessionId"
  | "productRunId"
  | "permissionPreset"
  | "inputItems"
  | "workspaceResolver"
  | "workspaceSelection"
  | "identityResolver"
  | "identitySelection"
  | "providerProfile"
> & {
  readonly workspace: WorkspaceSelection;
  readonly workspaceResolver?: HostWorkspaceResolver;
  readonly workspaceSelection?: HostWorkspaceSelection;
  readonly identityResolver?: HostIdentityResolver;
  readonly identitySelection?: HostIdentitySelection;
  readonly sessionId?: string;
  readonly productRunId?: string;
  readonly enableShell?: boolean;
  readonly permissionPreset?: PrepareHelarcHostRunInput["permissionPreset"];
  readonly inputItems?: PrepareHelarcHostRunInput["inputItems"];
  readonly providerProfile?: PrepareHelarcHostRunInput["providerProfile"];
};

async function executeTestHostRun(input: RunHelarcTestInput) {
  const prepared = await prepareTestHostRun(input);
  const composition = prepared.start();
  return composition.result;
}

async function executeSuspendedThenCancelledTestHostRun(input: RunHelarcTestInput) {
  const prepared = await prepareTestHostRun(input);
  const composition = prepared.start();
  await waitUntil(() => composition.activeRun.getStatus().status === "suspended");
  const suspended = composition.activeRun.getStatus();
  const cancellation = composition.activeRun.cancel({
    origin: "user",
    reasonCode: "user_requested",
  });
  return Object.freeze({
    suspended,
    cancellation,
    result: await composition.result,
  });
}

async function prepareTestHostRun(input: RunHelarcTestInput) {
  const productRunId = input.productRunId ?? input.sessionId ?? input.task.id;
  const permissionPreset = input.permissionPreset ?? "ask_for_approval";
  const {
    workspace,
    workspaceResolver,
    workspaceSelection,
    identityResolver,
    identitySelection,
    enableShell,
    inputItems,
    providerProfile,
    ...hostInput
  } = input;
  return prepareHelarcHostRun({
    ...hostInput,
    workspaceResolver: workspaceResolver ??
      createStaticHostWorkspaceResolver(workspace),
    workspaceSelection: workspaceSelection ?? {
      kind: "references",
      primaryRef: workspace.primary.id,
      additionalRefs: workspace.additional.map((candidate) => candidate.id),
    },
    identityResolver: identityResolver ?? createStaticHostIdentityResolver({
      id: "test-anonymous",
      kind: "anonymous",
      displayName: "Test user",
      metadata: {},
    }),
    identitySelection: identitySelection ?? { kind: "anonymous" },
    productRunId,
    sessionId: input.sessionId ?? productRunId,
    inputItems: inputItems ?? [],
    permissionPreset,
    providerProfile: providerProfile ?? createTestProviderProfile(input.provider),
  });
}

function createTestProviderProfile(
  provider: Provider,
): PrepareHelarcHostRunInput["providerProfile"] {
  const result = createHelarcProviderProfile({
    id: "test-provider",
    providerKind: provider.descriptor.id === "ollama.api"
      ? "ollama"
      : "openai-compatible",
    displayName: "Test Provider",
    baseUrl: "https://provider.local/v1",
    model: provider.modelContext.target.model,
    timeoutMs: 30_000,
    credentialStatus: "empty_allowed",
    qualificationPolicy: "allow_experimental",
    isActive: true,
  });
  if (!result.ok) throw new TypeError("Test Provider profile is invalid.");
  return result.profile;
}

function executeReadOnlyTestHostRun(
  input: Omit<RunHelarcTestInput, "enableShell">,
) {
  return executeTestHostRun({ ...input, enableShell: false });
}

describe("Helarc Host Run composition", () => {
  it("binds instruction settings before asynchronous preparation and allows a Run with no system instructions", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "helarc-no-instructions-"));
    const provider = new ScriptedProvider([{ kind: "completion", summary: "Completed." }]);
    const defaults = createDefaultHelarcInstructionSettings();
    const settings = {
      agent: defaults.agent.map((entry) => ({ ...entry, enabled: false })),
      delegated: defaults.delegated.map((entry) => ({ ...entry, enabled: false })),
      protocol: defaults.protocol.map((entry) => ({ ...entry, enabled: false })),
      stop: defaults.stop.map((entry) => ({ ...entry, enabled: false })),
    };
    const preparing = prepareTestHostRun({ ...createTask(workspaceRoot), provider, instructionSettings: settings });
    settings.agent[0]!.enabled = true;
    settings.protocol[0]!.enabled = true;
    settings.stop[0]!.enabled = true;
    const prepared = await preparing;
    const result = await prepared.start().result;
    expect(result.runResult.status).toBe("succeeded");
    expect(provider.requests[0]?.instructions.content).toEqual([]);
    expect(provider.requests[0]?.interaction).toMatchObject({ kind: "native_tool_turn" });
    expect(provider.stopRequests).toHaveLength(1);
    expect(provider.stopRequests[0]?.instructions.content).toEqual([]);
  });
  it("passes custom Stop text through Host and Product composition without adding it to the main loop", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "helarc-stop-instructions-"));
    const provider = new ScriptedProvider([{ kind: "completion", summary: "Completed." }]);
    const defaults = createDefaultHelarcInstructionSettings();
    const instructionSettings = { ...defaults, stop: [{ ...defaults.stop[0]!, content: "Check only the supplied completion evidence." }] };
    await executeTestHostRun({ ...createTask(workspaceRoot), provider, instructionSettings });
    expect(provider.stopRequests).toHaveLength(1);
    expect(provider.stopRequests[0]?.instructions.content).toEqual([
      { kind: "text", text: "Check only the supplied completion evidence." },
    ]);
    expect(JSON.stringify(provider.requests[0]?.instructions)).not.toContain("Check only the supplied completion evidence.");
  });
  it("prepares without invoking Runner and permits exactly one start", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "helarc-prepared-run-"));
    const provider = new ScriptedProvider([{ kind: "completion", summary: "Prepared." }]);
    const prepared = await prepareTestHostRun({
      ...createTask(workspaceRoot),
      provider,
    });

    expect(provider.requests).toHaveLength(0);
    const composition = prepared.start();
    expect(() => prepared.start()).toThrow("only once");
    await expect(composition.result).resolves.toMatchObject({
      kind: "run_result",
      product: { status: "completed" },
    });
    expect(provider.requests).toHaveLength(1);
  });

  it("keeps the complete Run deadline separate from one Provider request window", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "helarc-run-deadline-"));
    const startedAt = Date.parse("2026-08-20T00:00:00.000Z");
    let elapsedMs = 0;
    const provider = new ScriptedProvider(
      [{ kind: "completion", summary: "Completed after a long model request." }],
      () => {
        elapsedMs = 31_000;
      },
    );

    const result = await executeReadOnlyTestHostRun({
      ...createTask(workspaceRoot),
      provider,
      now: () => new Date(startedAt + elapsedMs).toISOString(),
    });

    expect(result.runResult).toMatchObject({ status: "succeeded" });
    expect(result.product).toMatchObject({ status: "completed" });
  });

  it("fails Host Workspace acquisition before a Runner can start", async () => {
    const provider = new ScriptedProvider([
      { kind: "completion", summary: "Must not run." },
    ]);

    await expect(prepareTestHostRun({
      ...createTask("D:/missing-workspace"),
      provider,
      workspaceResolver: {
        async resolve() {
          throw new Error("Workspace unavailable.");
        },
      },
    })).rejects.toMatchObject({
      code: "host_workspace_resolution_failed",
    });
    expect(provider.requests).toHaveLength(0);
  });

  it("runs one read-only tool call and completes with ordered activity", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "helarc-session-"));
    await mkdir(join(workspaceRoot, "src"));
    await writeFile(join(workspaceRoot, "src", "index.ts"), "export const value = 1;\n");

    const provider = new ScriptedProvider([
      {
        kind: "tool_call",
        reason: "Inspect workspace files.",
        toolName: "Glob",
        input: { pattern: "**/*", path: "." },
      },
      {
        kind: "completion",
        summary: "Workspace contains src/index.ts. No changes needed.",
      },
    ]);

    const result = await executeReadOnlyTestHostRun({
      ...createTask(workspaceRoot),
      provider,
      now: () => "2026-06-28T00:00:00.000Z",
    });

    expect(result.product.status).toBe("completed");
    expect(result.runResult.status).toBe("succeeded");
    expect(result.product.output).toMatchObject({
      agentSummary: "Workspace contains src/index.ts. No changes needed.",
      runtimeStatus: "succeeded",
      safeErrors: [],
    });
    expect(result.activity.map((item) => item.kind)).toEqual([
      "run.started",
      "context.transition.committed",
      "context.transition.committed",
      "run.item.appended",
      "context.transition.committed",
      "context.projection.completed",
      "controller.started",
      "run.item.appended",
      "controller.tool_exposure.resolved",
      "controller.finished",
      "run.item.appended",
      "operation.started",
      "operation.finished",
      "context.transition.committed",
      "run.item.appended",
      "run.item.appended",
      "context.transition.committed",
      "context.projection.completed",
      "controller.started",
      "run.item.appended",
      "controller.tool_exposure.resolved",
      "controller.finished",
      "verification.gate.evaluated",
      "context.transition.committed",
      "run.item.appended",
      "run.item.appended",
      "run.item.appended",
      "run.item.appended",
      "run.completed",
    ]);
    const modelCallSettlement = result.activity.find(
      (item) => item.kind === "run.item.appended" &&
        item.metadata.itemKind === "model_call_settlement",
    );
    expect(modelCallSettlement).toBeDefined();
    const contextProjection = result.activity.find(
      (item) => item.kind === "context.projection.completed",
    );
    expect(contextProjection?.metadata).toMatchObject({
      outcome: "projected",
      accountingUnit: "bytes",
    });
    expect(contextProjection?.metadata).not.toHaveProperty("records");
    expect(provider.requests).toHaveLength(2);
    expect(provider.lastControllerInputContexts).toEqual([0, 1]);
    expect(result.activity.find((item) => item.kind === "controller.finished")?.metadata).toMatchObject({
      promptArchitectureVersion: "helarc-prompt-v7",
      toolExposureVersion: "trusted-tool-exposure-v1",
    });
    expect(result.activity.find((item) => item.kind === "controller.finished")?.metadata)
      .not.toHaveProperty("actionContractVersion");
    expect(provider.requests[1]?.messages).toContainEqual(expect.objectContaining({
      role: "tool",
      content: [expect.objectContaining({
        kind: "model_tool_result",
        result: expect.objectContaining({ settlement: "succeeded" }),
      })],
    }));
  });

  it("asks one correlated clarification and resumes the same Run", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "helarc-clarification-"));
    const provider = new ScriptedProvider([
      {
        kind: "tool_call",
        toolName: "AskUserQuestion",
        input: {
          questions: [{
            id: "scope",
            prompt: "Which package should be inspected?",
            options: [{
              label: "Runtime",
              description: "Inspect the runtime package.",
            }],
            allow_multiple: false,
          }],
        },
      },
      { kind: "completion", summary: "Clarification received." },
    ]);
    const prepared = await prepareTestHostRun({
      ...createTask(workspaceRoot),
      provider,
    });
    const composition = prepared.start();
    await waitUntil(() => composition.activeRun.getStatus().pendingInteractions.length === 1);
    const pending = composition.activeRun.getStatus().pendingInteractions[0]!;

    expect(pending.presentation).toMatchObject({
      questions: [{ id: "scope", prompt: "Which package should be inspected?" }],
    });
    expect(composition.activeRun.submitInteraction({
      request: pending.request,
      submissionId: "clarification-submission-1",
      payload: {
        answers: [{
          question_id: "scope",
          selected_labels: ["Runtime"],
          text: null,
        }],
      },
    }).status).toBe("accepted_for_resolution");

    const result = await composition.result;
    expect(result.runResult.status).toBe("succeeded");
    expect(result.product.interactions).toEqual([
      expect.objectContaining({ owner: "helarc", status: "resolved" }),
    ]);
    expect(result.runResult.items).toContainEqual(expect.objectContaining({
      payload: expect.objectContaining({
        kind: "observation",
        observation: expect.objectContaining({
          payload: expect.objectContaining({
            kind: "interaction",
            toolResult: expect.objectContaining({ status: "succeeded" }),
          }),
        }),
      }),
    }));
    expect(provider.requests).toHaveLength(2);
  });

  it("delegates one Agent Tool call to an isolated descendant Run", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "helarc-descendant-"));
    const provider = new ScriptedProvider([
      {
        kind: "tool_call",
        toolName: "Agent",
        input: {
          prompt: "Inspect the runtime contracts.",
          description: "Contract inspection",
        },
      },
      { kind: "completion", summary: "Child inspection complete." },
      { kind: "completion", summary: "Parent received the child result." },
    ]);

    const result = await executeTestHostRun({
      ...createTask(workspaceRoot),
      provider,
    });

    expect(result.runResult.status).toBe("succeeded");
    expect(result.product.children).toEqual([
      expect.objectContaining({ owner: "agent-runtime", status: "succeeded" }),
    ]);
    expect(result.runResult.items).toContainEqual(expect.objectContaining({
      payload: expect.objectContaining({
        kind: "observation",
        observation: expect.objectContaining({
          payload: expect.objectContaining({
            kind: "descendant_run",
            status: "succeeded",
            toolResult: expect.objectContaining({ status: "succeeded" }),
          }),
        }),
      }),
    }));
    expect(operationResults(result)).toEqual([]);
    expect(provider.requests).toHaveLength(3);
  });

  it("projects Provider request retry history through Runner activity", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "helarc-provider-retry-"));
    const provider = new RetryThenCompleteProvider();

    const prepared = await prepareTestHostRun({
      ...createTask(workspaceRoot),
      provider,
      now: () => "2026-07-14T00:00:00.000Z",
    });
    const composition = prepared.start();
    const result = await composition.result;

    expect(result.product.status).toBe("completed");
    expect(provider.requests).toHaveLength(2);
    const retryProjection = composition.activeRun.getStatus().retry;
    expect(retryProjection).not.toBeNull();
    const retryActivity = retryProjection?.recentEvents.filter((item) =>
      item.owner === "provider_request"
    );
    expect(retryActivity?.map((item) => item.event)).toEqual([
      "retry_attempt_started",
      "retry_attempt_finished",
      "retry_scheduled",
      "retry_attempt_started",
      "retry_attempt_finished",
    ]);
    expect(new Set(retryActivity?.map((item) => item.operationId))).toEqual(
      new Set([`${result.harnessRunId}:controller:1:provider-request:1`]),
    );
    expect(retryActivity?.find((item) => item.event === "retry_scheduled")).toMatchObject({
      owner: "provider_request",
      attemptNumber: 2,
      delayMs: 0,
      code: "provider_unavailable",
    });
    expect(retryActivity?.every(Object.isFrozen)).toBe(true);
    expect(JSON.stringify(retryActivity)).not.toContain("Provider is temporarily unavailable.");
  });

  it("runs Glob, Read, and Grep inside the Workspace scope", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "helarc-read-only-tools-"));
    await mkdir(join(workspaceRoot, "src"));
    await writeFile(join(workspaceRoot, "src", "index.ts"), "export const value = 42;\n");

    const provider = new ScriptedProvider([
      {
        kind: "tool_call",
        reason: "List workspace files.",
        toolName: "Glob",
        input: { pattern: "**/*", path: "." },
      },
      {
        kind: "tool_call",
        reason: "Read the source file.",
        toolName: "Read",
        input: { file_path: "src/index.ts" },
      },
      {
        kind: "tool_call",
        reason: "Search for the exported value.",
        toolName: "Grep",
        input: { pattern: "value", path: "." },
      },
      {
        kind: "completion",
        summary: "Read-only tools completed.",
      },
    ]);

    const result = await executeReadOnlyTestHostRun({
      ...createTask(workspaceRoot),
      provider,
    });

    expect(result.product.status).toBe("completed");
    expect(result.product.output.agentSummary).toBe("Read-only tools completed.");
    expect(result.runResult.evidenceRefs).toHaveLength(0);
    expect(result.product.effects).toHaveLength(3);
    expect(result.product.effects.every((effect) => effect.status === "succeeded")).toBe(true);
    expect(result.activity.filter((item) => item.kind === "operation.finished")).toHaveLength(3);
    expect(provider.lastControllerInputContexts).toEqual([0, 1, 2, 3]);
    expect(operationOutputs(result)).toMatchObject([
      { matches: ["src", "src/index.ts"], truncated: false, omitted_count: 0 },
      { file_path: "src/index.ts", content: "export const value = 42;\n", truncated: false },
      {
        output_mode: "content",
        entries: [{ file_path: "src/index.ts", line: 1, text: "export const value = 42;" }],
        truncated: false,
      },
    ]);
  });

  it("rejects selected managed enforcement without a matching provider", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "helarc-managed-unavailable-"));
    const provider = new ScriptedProvider([{ kind: "completion", summary: "Must not run." }]);

    await expect(executeReadOnlyTestHostRun({
      ...createTask(workspaceRoot),
      provider,
      enforcement: "managed",
    })).rejects.toThrow("requires a matching SandboxProvider");
    expect(provider.requests).toHaveLength(0);
  });

  it("fails malformed native output without structured-output correction", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "helarc-output-exhausted-"));
    const firstInvalidOutput = "PRIVATE_INVALID_OUTPUT_1";
    const provider = new ScriptedProvider([
      firstInvalidOutput,
      "PRIVATE_INVALID_OUTPUT_2",
    ]);

    const result = await executeReadOnlyTestHostRun({
      ...createTask(workspaceRoot),
      provider,
    });

    expect(result.product.status).toBe("failed");
    expect(result.runResult).toMatchObject({
      status: "failed",
      cause: {
        kind: "failure",
        failure: {
          kind: "provider",
          failure: { code: "provider_request_failed" },
        },
      },
    });
    expect(result.runResult.items.some((item) =>
      item.payload.kind === "run_action"
    )).toBe(false);
    expect(provider.requests).toHaveLength(1);
    expect(JSON.stringify(provider.requests[0])).not.toContain(firstInvalidOutput);
  });

  it("keeps command execution behind approval even when enforcement is disabled", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "helarc-shell-denied-"));
    const markerPath = join(workspaceRoot, "marker.txt");
    const provider = new ScriptedProvider([
      {
        kind: "tool_call",
        reason: "Try a shell command.",
        toolName: nativeShellTool(),
        input: createShellInput(markerPath),
      },
      {
        kind: "stop",
        reason: "Permission was denied.",
      },
    ]);
    const execution = await executeSuspendedThenCancelledTestHostRun({
      ...createTask(workspaceRoot),
      provider,
      enableShell: true,
      permissionPreset: "approve_for_me",
      automaticApprovalReviewer: automaticReviewer("decline"),
    });
    const { result } = execution;

    expect(execution.suspended.status).toBe("suspended");
    expect(execution.cancellation.status).toBe("accepted");
    expect(result.product.status, JSON.stringify(result, null, 2)).toBe("cancelled");
    expect(result.runResult.items.some((item) =>
      item.payload.kind === "pending_transition" &&
      item.payload.transition === "opened" &&
      item.payload.pending.kind === "interaction"
    )).toBe(true);
    expect(result.product.output.enforcement.status).toBe("denied");
    await expect(access(markerPath)).rejects.toThrow();
  });

  it("does not weaken approval when the automatic reviewer is unavailable", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "helarc-reviewer-unavailable-"));
    const markerPath = join(workspaceRoot, "marker.txt");
    const provider = new ScriptedProvider([
      {
        kind: "tool_call",
        reason: "Try a shell command.",
        toolName: nativeShellTool(),
        input: createShellInput(markerPath),
      },
      {
        kind: "stop",
        reason: "The automatic reviewer is unavailable.",
      },
    ]);

    const execution = await executeSuspendedThenCancelledTestHostRun({
      ...createTask(workspaceRoot),
      provider,
      enableShell: true,
      permissionPreset: "approve_for_me",
      automaticApprovalReviewer: unavailableAutomaticReviewer(),
    });
    const { result } = execution;

    expect(execution.suspended.status).toBe("suspended");
    expect(execution.cancellation.status).toBe("accepted");
    expect(result.product.status, JSON.stringify(result, null, 2)).toBe("cancelled");
    expect(result.runResult.items.some((item) =>
      item.payload.kind === "pending_transition" &&
      item.payload.transition === "opened" &&
      item.payload.pending.kind === "interaction"
    )).toBe(true);
    expect(JSON.stringify(result.runResult.items)).toContain("approval_reviewer_unavailable");
    expect(result.product.output.enforcement.status).toBe("failed");
    await expect(access(markerPath)).rejects.toThrow();
  });

  it("executes Full access commands through the explicit unisolated gateway", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "helarc-shell-granted-"));
    const markerPath = join(workspaceRoot, "marker.txt");
    const provider = new ScriptedProvider([
      {
        kind: "tool_call",
        reason: "Create a marker.",
        toolName: nativeShellTool(),
        input: createShellInput(markerPath),
      },
      {
        kind: "completion",
        summary: "Shell command completed.",
      },
    ]);

    const result = await executeTestHostRun({
      ...createTask(workspaceRoot),
      provider,
      enableShell: true,
      permissionPreset: "full_access",
    });

    expect(result.product.status, JSON.stringify(result, null, 2)).toBe("completed");
    expect(result.product.output.agentSummary).toBe("Shell command completed.");
    expect(result.product.output.safeErrors).toEqual([]);
    const commandResults = result.runResult.items.flatMap((item) =>
      item.payload.kind === "observation" &&
        item.payload.observation.payload.kind === "operation"
        ? [item.payload.observation.payload.result]
        : []
    );
    expect(commandResults).toHaveLength(1);
    expect(commandResults[0]).toMatchObject({
      status: "succeeded",
      output: {
        mode: "foreground",
        exit_code: 0,
        signal: null,
        stdout: { integrity: "exact", truncated: false },
        stderr: { text: "", integrity: "exact", truncated: false },
      },
    });
    await expect(access(markerPath)).resolves.toBeUndefined();
    expect(result.product.output.enforcement).toEqual({
      selected: "disabled",
      status: "unisolated",
      code: null,
    });
    expect(result.product.actions).toContainEqual(expect.objectContaining({
      status: "succeeded",
    }));
    expect(result.product.effects[0]?.lowerRefs).toContainEqual(expect.objectContaining({
      owner: "canonical-action",
      kind: "action_settlement",
    }));
    expect(provider.lastControllerInputContexts).toEqual([0, 1]);
  });

  it("starts and stops one background shell task through its exact TaskStop identity", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "helarc-background-shell-"));
    const provider = new ScriptedProvider([
      {
        kind: "tool_call",
        reason: "Start one bounded background task.",
        toolName: nativeShellTool(),
        input: {
          command: process.platform === "win32"
            ? "Start-Sleep -Seconds 30"
            : "sleep 30",
          timeout_ms: 60_000,
          description: "Start a test background task.",
          run_in_background: true,
        },
      },
      (request: ProviderRequest) => ({
        kind: "tool_call",
        reason: "Stop the exact background task.",
        toolName: "TaskStop",
        input: { task_id: readBackgroundTaskId(request) },
      }),
      { kind: "completion", summary: "Background task was stopped." },
    ]);

    const result = await executeTestHostRun({
      ...createTask(workspaceRoot),
      provider,
      permissionPreset: "full_access",
    });

    expect(result.product.status, JSON.stringify(result, null, 2)).toBe("completed");
    expect(
      operationOutputs(result),
      JSON.stringify(operationResults(result), null, 2),
    ).toEqual([
      expect.objectContaining({
        mode: "background",
        status: "running",
        task_id: expect.any(String),
        output_file: expect.any(String),
      }),
      expect.objectContaining({
        status: "stopped",
        effect_certainty: "known_applied",
        task_id: expect.any(String),
      }),
    ]);
    expect(provider.lastControllerInputContexts).toEqual([0, 1, 2]);
  });

  it("updates the Runner-owned plan and exposes it to the next controller turn", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "helarc-plan-update-"));
    const provider = new ScriptedProvider([
      {
        kind: "plan_update",
        explanation: "The task has multiple steps.",
        plan: [
          { step: "Inspect workspace", status: "in_progress" },
          { step: "Finish task", status: "pending" },
        ],
      },
      {
        kind: "completion",
        summary: "Plan was recorded.",
      },
      {
        kind: "completion",
        summary: "Plan was recorded after reconciliation feedback.",
      },
    ]);

    const result = await executeReadOnlyTestHostRun({
      ...createTask(workspaceRoot),
      provider,
    });

    expect(result.product.status).toBe("completed");
    expect(provider.lastControllerInputPlans).toEqual([
      null,
      {
        id: `${result.harnessRunId}:plan:1`,
        version: 1,
        status: "active",
        steps: [
          { step: "Inspect workspace", status: "in_progress" },
          { step: "Finish task", status: "pending" },
        ],
      },
    ]);
  });

  it("allows bounded Controller correction after three rejected Actions", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "helarc-action-correction-"));
    const provider = new ScriptedProvider([
      {
        kind: "plan_update",
        plan: [{ step: "Inspect workspace", status: "started" }],
      },
      {
        kind: "tool_call",
        toolName: "Glob",
        input: { directory: "." },
      },
      {
        kind: "tool_call",
        toolName: "Read",
        input: { file: "Program.cs" },
      },
      {
        kind: "completion",
        summary: "Corrected the rejected decisions.",
      },
    ]);

    const result = await executeReadOnlyTestHostRun({
      ...createTask(workspaceRoot),
      provider,
    });

    expect(result.runResult).toMatchObject({ status: "succeeded" });
    expect(result.product.status).toBe("completed");
    expect(result.product.runActions.map(({ status }) => status)).toEqual([
      "rejected",
      "rejected",
      "rejected",
    ]);
    expect(provider.requests).toHaveLength(4);
    expect(provider.lastControllerInputContexts).toEqual([0, 1, 2, 3]);
  });

  it("executes multiple model-origin file mutations and continues until completion", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "helarc-file-mutations-"));
    await mkdir(join(workspaceRoot, "src"));
    await writeFile(join(workspaceRoot, "src", "existing.txt"), "before\n");
    const provider = new ScriptedProvider([
      {
        kind: "tool_call",
        toolName: "Write",
        input: { file_path: "src/created.txt", content: "created\n" },
      },
      {
        kind: "tool_call",
        toolName: "Edit",
        input: {
          file_path: "src/existing.txt",
          old_string: "before",
          new_string: "after",
        },
      },
      { kind: "completion", summary: "Both file changes are complete." },
    ]);

    const result = await executeTestHostRun({
      ...createTask(workspaceRoot),
      provider,
      permissionPreset: "full_access",
    });

    expect(result.product.status).toBe("completed");
    expect(result.product.output.agentSummary).toBe("Both file changes are complete.");
    expect(result.product.effects).toHaveLength(2);
    expect(result.product.effects.every(({ status }) => status === "succeeded")).toBe(true);
    expect(result.product.actions).toHaveLength(2);
    expect(provider.requests).toHaveLength(3);
    expect(provider.lastControllerInputContexts).toEqual([0, 1, 2]);
    await expect(readFile(join(workspaceRoot, "src", "created.txt"), "utf8"))
      .resolves.toBe("created\n");
    await expect(readFile(join(workspaceRoot, "src", "existing.txt"), "utf8"))
      .resolves.toBe("after\n");
  });

  it("derives generic approval review from the exact prepared Write action", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "helarc-write-approved-"));
    const targetPath = join(workspaceRoot, "approved.txt");
    const reviewedInputs: ApprovalReviewInput[] = [];
    const provider = new ScriptedProvider([
      {
        kind: "tool_call",
        toolName: "Write",
        input: { file_path: "approved.txt", content: "approved\n" },
      },
      { kind: "completion", summary: "The approved write completed." },
    ]);

    const result = await executeTestHostRun({
      ...createTask(workspaceRoot),
      provider,
      permissionPreset: "approve_for_me",
      automaticApprovalReviewer: automaticReviewer("accept", (input) => {
        reviewedInputs.push(input);
      }),
    });

    expect(result.product.status).toBe("completed");
    expect(reviewedInputs[0]?.request.category).toBe("fileChange");
    expect(reviewedInputs[0]?.request.payload).toMatchObject({
      changes: [{ operation: "create", displayPath: "approved.txt" }],
    });
    await expect(readFile(targetPath, "utf8")).resolves.toBe("approved\n");
  });

  it("does not execute a Write when generic approval is declined", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "helarc-write-declined-"));
    const targetPath = join(workspaceRoot, "declined.txt");
    const provider = new ScriptedProvider([
      {
        kind: "tool_call",
        toolName: "Write",
        input: { file_path: "declined.txt", content: "must not exist\n" },
      },
      { kind: "stop", reason: "The requested file change was declined." },
    ]);

    const execution = await executeSuspendedThenCancelledTestHostRun({
      ...createTask(workspaceRoot),
      provider,
      permissionPreset: "approve_for_me",
      automaticApprovalReviewer: automaticReviewer("decline"),
    });
    const { result } = execution;

    expect(execution.suspended.status).toBe("suspended");
    expect(result.product.status).toBe("cancelled");
    expect(result.product.output.enforcement.status).toBe("denied");
    await expect(access(targetPath)).rejects.toThrow();
  });

  it("rejects an ambiguous Edit without changing the file", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "helarc-edit-ambiguous-"));
    const targetPath = join(workspaceRoot, "duplicate.txt");
    await writeFile(targetPath, "same same\n");
    const provider = new ScriptedProvider([
      {
        kind: "tool_call",
        toolName: "Edit",
        input: {
          file_path: "duplicate.txt",
          old_string: "same",
          new_string: "changed",
        },
      },
      { kind: "stop", reason: "The exact edit was ambiguous." },
    ]);

    const execution = await executeSuspendedThenCancelledTestHostRun({
      ...createTask(workspaceRoot),
      provider,
      permissionPreset: "full_access",
    });
    const { result } = execution;

    expect(execution.suspended.status).toBe("suspended");
    expect(result.product.status).toBe("cancelled");
    expect(result.product.output.safeErrors).toContainEqual(expect.objectContaining({
      code: "file_edit_ambiguous",
    }));
    await expect(readFile(targetPath, "utf8")).resolves.toBe("same same\n");
  });

  it("invalidates an approved Edit when its prepared baseline becomes stale", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "helarc-edit-stale-"));
    const targetPath = join(workspaceRoot, "stale.txt");
    await writeFile(targetPath, "before\n");
    const provider = new ScriptedProvider([
      {
        kind: "tool_call",
        toolName: "Edit",
        input: {
          file_path: "stale.txt",
          old_string: "before",
          new_string: "after",
        },
      },
      { kind: "stop", reason: "The prepared baseline became stale." },
    ]);

    const execution = await executeSuspendedThenCancelledTestHostRun({
      ...createTask(workspaceRoot),
      provider,
      permissionPreset: "approve_for_me",
      automaticApprovalReviewer: automaticReviewer("accept", async () => {
        await writeFile(targetPath, "changed externally\n");
      }),
    });
    const { result } = execution;

    expect(execution.suspended.status).toBe("suspended");
    expect(result.product.status).toBe("cancelled");
    expect(result.product.output.safeErrors).toContainEqual(expect.objectContaining({
      code: "file_target_changed",
    }));
    await expect(readFile(targetPath, "utf8")).resolves.toBe("changed externally\n");
  });
});

function operationOutputs(result: Awaited<ReturnType<typeof executeTestHostRun>>): unknown[] {
  return operationResults(result).map((operation) => operation.output);
}

function operationResults(result: Awaited<ReturnType<typeof executeTestHostRun>>) {
  return result.runResult.items.flatMap((item) =>
    item.payload.kind === "observation" &&
      item.payload.observation.payload.kind === "operation"
      ? [item.payload.observation.payload.result]
      : []
  );
}

function automaticReviewer(
  decisionKind: "accept" | "decline",
  onReview: (input: ApprovalReviewInput) => void | Promise<void> = () => {},
) {
  return {
    bindingId: `test-auto-${decisionKind}`,
    kind: "auto_review" as const,
    descriptor: {
      id: `test-auto-${decisionKind}`,
      kind: "auto_review" as const,
      displayName: "Test automatic reviewer",
      source: "helarc-session-test",
      metadata: {},
    },
    reviewer: {
      async review(input: ApprovalReviewInput) {
        await onReview(input);
        const option = input.request.decisionOptions.find(({ kind }) => kind === decisionKind);
        if (option === undefined) throw new Error(`Missing '${decisionKind}' decision option.`);
        return {
          status: "decided" as const,
          submission: {
            submissionId: `test-submission-${decisionKind}`,
            runId: input.request.runId,
            requestId: input.request.id,
            pendingVersion: input.pendingVersion,
            optionId: option.id,
            grantedPermissions: null,
            reason: decisionKind === "decline" ? "Denied by test reviewer." : null,
          },
          rationale: null,
        };
      },
    },
    reviewTimeoutMs: 1_000,
  };
}

function unavailableAutomaticReviewer() {
  return {
    bindingId: "test-auto-unavailable",
    kind: "auto_review" as const,
    descriptor: {
      id: "test-auto-unavailable",
      kind: "auto_review" as const,
      displayName: "Unavailable automatic reviewer",
      source: "helarc-session-test",
      metadata: {},
    },
    reviewer: {
      async review() {
        return {
          status: "failed" as const,
          failure: {
            code: "approval_reviewer_unavailable" as const,
            message: "Automatic reviewer is unavailable.",
            retryable: false,
            metadata: {},
          },
        };
      },
    },
    reviewTimeoutMs: 1_000,
  };
}

class ScriptedProvider implements Provider {
  readonly stopRequests: ProviderRequest[] = [];
  private readonly context = createFakeProviderContext(
    "scripted-helarc-provider",
    "host-run-test-model",
  );
  readonly modelContext = this.context.modelContext;
  readonly requestBodyTransportLimit = this.context.requestBodyTransportLimit;
  readonly descriptor = {
    id: "scripted-helarc-provider",
    name: "Scripted Helarc Provider",
    capabilities: {
      nativeToolInteraction: {
        supported: true as const,
        callableDefinitions: true as const,
        modelCalls: true as const,
        resultMessages: true as const,
        multipleCalls: true,
        callCorrelation: "provider_supplied" as const,
      },
      structuredGeneration: { supported: true as const },
      streaming: { supported: false as const },
      modelContext: providerModelContextCapability(this.modelContext),
      continuation: { supported: false as const },
      compaction: { supported: false as const },
      usageMetering: {
        inputTokens: "unavailable" as const,
        outputTokens: "unavailable" as const,
        costUnits: "unavailable" as const,
      },
    },
    requestRetryScheduler: { kind: "harness" as const },
    metadata: {},
  };
  readonly requests: ProviderRequest[] = [];
  readonly lastControllerInputContexts: number[] = [];
  readonly lastControllerInputPlans: unknown[] = [];

  constructor(
    private readonly outputs: unknown[],
    private readonly beforeResponse: () => void = () => {},
  ) {}

  async send(
    request: ProviderRequest,
    _context: InvocationInterruptionContext,
  ): Promise<ProviderCallResult> {
    if (request.purpose === "helarc.task-fulfillment") {
      this.stopRequests.push(request);
      return scriptedTaskFulfillmentResult(request, this.descriptor.id);
    }
    this.requests.push(request);
    this.lastControllerInputContexts.push(readObservationCount(request));
    this.lastControllerInputPlans.push(readCurrentPlan(request));
    this.beforeResponse();
    const scriptedOutput = this.outputs.shift();
    if (scriptedOutput === undefined) {
      return {
        kind: "failed",
        failure: {
          category: "fake",
          code: "script_exhausted",
          message: "Scripted provider exhausted.",
          metadata: {},
        },
      };
    }

    const output = typeof scriptedOutput === "function"
      ? scriptedOutput(request)
      : scriptedOutput;

    return scriptedNativeProviderResult(
      request,
      output,
      this.descriptor.id,
      this.requests.length,
    );
  }
}

class RetryThenCompleteProvider implements Provider {
  private readonly context = createFakeProviderContext(
    "retry-then-complete-provider",
    "host-run-test-model",
  );
  readonly modelContext = this.context.modelContext;
  readonly requestBodyTransportLimit = this.context.requestBodyTransportLimit;
  readonly descriptor = {
    id: "retry-then-complete-provider",
    name: "Retry Then Complete Provider",
    capabilities: {
      nativeToolInteraction: {
        supported: true as const,
        callableDefinitions: true as const,
        modelCalls: true as const,
        resultMessages: true as const,
        multipleCalls: true,
        callCorrelation: "provider_supplied" as const,
      },
      structuredGeneration: { supported: true as const },
      streaming: { supported: false as const },
      modelContext: providerModelContextCapability(this.modelContext),
      continuation: { supported: false as const },
      compaction: { supported: false as const },
      usageMetering: {
        inputTokens: "unavailable" as const,
        outputTokens: "unavailable" as const,
        costUnits: "unavailable" as const,
      },
    },
    requestRetryScheduler: { kind: "harness" as const },
    metadata: {},
  };
  readonly requests: ProviderRequest[] = [];

  async send(request: ProviderRequest): Promise<ProviderCallResult> {
    if (request.purpose === "helarc.task-fulfillment") {
      return scriptedTaskFulfillmentResult(request, this.descriptor.id);
    }
    this.requests.push(request);
    if (this.requests.length === 1) {
      return {
        kind: "failed",
        failure: {
          category: "transport",
          code: "provider_unavailable",
          message: "Provider is temporarily unavailable.",
          retryAfterMs: 0,
          metadata: {},
        },
      };
    }

    return scriptedNativeProviderResult(
      request,
      { kind: "completion", summary: "Recovered after retry." },
      this.descriptor.id,
      this.requests.length,
    );
  }
}

function scriptedTaskFulfillmentResult(
  request: ProviderRequest,
  providerId: string,
): ProviderCallResult {
  if (request.interaction.kind !== "structured_generation") {
    return providerTestFailure("task_fulfillment_request_kind_invalid");
  }
  return Object.freeze({
    kind: "succeeded" as const,
    response: snapshotProviderResponse({
      kind: "structured_generation",
      output: Object.freeze({
        status: "fulfilled",
        rationale: "The scripted Host Run fixture accepts the settled trajectory.",
        missingOutcomes: Object.freeze([]),
        unsupportedClaims: Object.freeze([]),
      }),
      responseId: `${providerId}:task-fulfillment`,
      continuation: null,
      usage: null,
      metadata: Object.freeze({ fixture: true }),
    }),
  });
}

function scriptedNativeProviderResult(
  request: ProviderRequest,
  output: unknown,
  providerId: string,
  responseSequence: number,
): ProviderCallResult {
  if (request.interaction.kind !== "native_tool_turn") {
    return providerTestFailure("provider_request_kind_invalid");
  }
  if (typeof output === "string") {
    return providerTestFailure("model_output_invalid");
  }
  if (typeof output !== "object" || output === null || !("kind" in output)) {
    return providerTestFailure("model_output_invalid");
  }

  const scripted = output as Record<string, unknown>;
  const responseId = `${providerId}:response:${responseSequence}`;
  const turnId = createModelTurnId({
    providerId,
    requestId: request.requestId,
    responseId,
  });
  const content = scripted.kind === "completion"
    ? [{ kind: "text" as const, text: String(scripted.summary) }]
    : [Object.freeze({
        kind: "model_tool_call" as const,
        call: snapshotModelToolCall({
          modelCallRef: createModelCallRef({
            providerRequestId: request.requestId,
            controllerRequestId: request.correlation.controllerRequestId,
            turnId,
            contentBlockOrdinal: 0,
            branchId: request.correlation.branchId,
          }),
          providerCallRef: { providerId, id: `${responseId}:call:0` },
          name: scriptedCallableName(request, scripted),
          input: scriptedCallInput(scripted),
          ordinal: 0,
        }),
      })];

  return {
    kind: "succeeded",
    response: snapshotProviderResponse({
      kind: "native_tool_turn",
      turn: {
        turnId,
        assistant: { role: "assistant", content },
        finish: { kind: "normal" },
        usage: null,
        responseRef: { providerId, requestId: request.requestId, responseId },
      },
      continuation: null,
      metadata: {},
    }),
  };
}

function scriptedCallableName(
  request: ProviderRequest,
  scripted: Record<string, unknown>,
): string {
  if (scripted.kind === "plan_update") return "update_plan";
  if (scripted.kind === "stop") return "stop";
  if (scripted.kind !== "tool_call" || typeof scripted.toolName !== "string") {
    return "unknown_scripted_callable";
  }
  const stem = scripted.toolName.replace(/[^A-Za-z0-9_-]/gu, "_").replace(/_+/gu, "_")
    .replace(/^_+|_+$/gu, "").slice(0, 42) || "tool";
  return request.interaction.kind === "native_tool_turn"
    ? request.interaction.callables.find(({ name }) => name.startsWith(`${stem}_`))?.name ??
      `unknown_${stem}`
    : `unknown_${stem}`;
}

function scriptedCallInput(scripted: Record<string, unknown>): {
  readonly [key: string]: ModelJsonValue;
} {
  if (scripted.kind === "plan_update") {
    return {
      ...(typeof scripted.explanation === "string"
        ? { explanation: scripted.explanation }
        : {}),
      plan: scripted.plan as ModelJsonValue,
    };
  }
  if (scripted.kind === "stop") return { reason: String(scripted.reason) };
  return scripted.input as { readonly [key: string]: ModelJsonValue };
}

function providerTestFailure(code: string): ProviderCallResult {
  return {
    kind: "failed",
    failure: {
      category: "fake",
      code,
      message: "Scripted provider could not create a native Model Turn.",
      metadata: {},
    },
  };
}

function providerModelContextCapability(modelContext: Provider["modelContext"]) {
  return {
    capacity: modelContext.capacity,
    requestedOutput: modelContext.requestedOutput,
    inputPreservation: modelContext.inputPreservation,
  };
}

function createTask(workspaceRoot: string) {
  const result = createHelarcTask({
    taskId: "helarc-task-1",
    prompt: "Inspect the workspace.",
    createdAt: "2026-06-28T00:00:00.000Z",
  });

  if (!result.ok) {
    throw new Error(result.error.message);
  }

  return {
    task: result.task,
    workspace: {
      primary: {
        id: "workspace",
        name: "workspace",
        rootRef: workspaceRoot,
        trustState: "trusted" as const,
        source: "test",
        policyRefs: [],
        metadata: {},
      },
      additional: [],
    },
  };
}

function readObservationCount(request: ProviderRequest): number {
  const marker = "Context projection:";
  const content = findTextBlock(request, marker);
  if (content === undefined) {
    return 0;
  }

  return content.slice(marker.length).split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      try {
        return JSON.parse(line) as unknown;
      } catch {
        return null;
      }
    })
    .filter((block) =>
      typeof block === "object" &&
      block !== null &&
      "payload" in block &&
      typeof block.payload === "object" &&
      block.payload !== null &&
      "value" in block.payload &&
      typeof block.payload.value === "object" &&
      block.payload.value !== null &&
      "kind" in block.payload.value &&
      block.payload.value.kind === "run_observation"
    ).length;
}

function readCurrentPlan(request: ProviderRequest): unknown {
  const marker = "Current plan:";
  const content = findTextBlock(request, marker);
  if (content === undefined) {
    return null;
  }

  try {
    return JSON.parse(content.slice(marker.length).trim()) as unknown;
  } catch {
    return null;
  }
}

function findTextBlock(request: ProviderRequest, marker: string): string | undefined {
  for (const message of request.messages) {
    for (const block of message.content) {
      if (block.kind === "text" && block.text.startsWith(marker)) return block.text;
    }
  }
  return undefined;
}

function readBackgroundTaskId(request: ProviderRequest): string {
  const match = /\"task_id\"\s*:\s*\"([^\"]+)\"/.exec(
    request.messages.map(modelMessageText).join("\n"),
  );
  if (match?.[1] === undefined) {
    throw new Error("The background task observation did not contain task_id.");
  }
  return match[1];
}

function modelMessageText(message: ProviderRequest["messages"][number]): string {
  return message.content
    .map((block) => block.kind === "text" ? block.text : JSON.stringify(block))
    .join("");
}

function createShellInput(markerPath: string) {
  return {
    command: process.platform === "win32"
      ? `[System.IO.File]::WriteAllText('${markerPath.replaceAll("'", "''")}', 'ran')`
      : `printf 'ran' > '${markerPath.replaceAll("'", "'\\''")}'`,
    timeout_ms: 5_000,
    description: "Create a governed marker file.",
  };
}

function nativeShellTool(): "Bash" | "PowerShell" {
  return process.platform === "win32" ? "PowerShell" : "Bash";
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("Timed out waiting for Helarc Host Run state.");
}
