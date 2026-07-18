import {
  createRunCancellationController,
  type ContextProjection,
} from "@agent-anything/agent-core";
import { createUserApprovalReviewBridge } from "@agent-anything/agent-core/host";
import type { ApprovalReviewInput } from "@agent-anything/permission";
import type {
  InvocationInterruptionContext,
  Provider,
  ProviderCallResult,
  ProviderRequest,
} from "@agent-anything/providers";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  createHelarcActionComposition,
  createHelarcTask,
} from "@agent-anything/helarc";
import {
  prepareHelarcHostRun,
  type PrepareHelarcHostRunInput,
} from "./HelarcHostRunComposition.js";
import { createHelarcPatchReviewBridge } from "./HelarcPatchReviewBridge.js";

type RunHelarcTestInput = Omit<
  PrepareHelarcHostRunInput,
  | "sessionId"
  | "runId"
  | "cancellation"
  | "toolMode"
  | "permissionPreset"
  | "patchReviewBridge"
> & {
  readonly sessionId?: string;
  readonly runId?: string;
  readonly cancellation?: PrepareHelarcHostRunInput["cancellation"];
  readonly enableShell?: boolean;
  readonly permissionPreset?: PrepareHelarcHostRunInput["permissionPreset"];
  readonly patchReviewBridge?: PrepareHelarcHostRunInput["patchReviewBridge"];
};

async function executeTestHostRun(input: RunHelarcTestInput) {
  const prepared = await prepareTestHostRun(input);
  const outcome = await prepared.start().result;
  if (outcome.kind === "start_failure") {
    throw new Error(outcome.failure.code);
  }
  return outcome;
}

async function prepareTestHostRun(input: RunHelarcTestInput) {
  const runId = input.runId ?? input.sessionId ?? input.task.id;
  const permissionPreset = input.permissionPreset ?? "ask_for_approval";
  const userApprovalBridge = permissionPreset === "ask_for_approval"
    ? input.userApprovalBridge ?? createUserApprovalReviewBridge({
        runId,
        descriptor: {
          id: "test-user-reviewer",
          kind: "user",
          displayName: "Test user",
          source: "helarc-host-run-test",
          metadata: {},
        },
      })
    : input.userApprovalBridge;
  return prepareHelarcHostRun({
    ...input,
    runId,
    sessionId: input.sessionId ?? runId,
    cancellation: input.cancellation ?? createRunCancellationController({ runId }),
    toolMode: input.enableShell ? "shell-enabled" : "read-only",
    permissionPreset,
    userApprovalBridge,
    patchReviewBridge: input.patchReviewBridge ?? createHelarcPatchReviewBridge({ runId }),
  });
}

function executeReadOnlyTestHostRun(
  input: Omit<RunHelarcTestInput, "enableShell">,
) {
  return executeTestHostRun({ ...input, enableShell: false });
}

describe("Helarc Host Run composition", () => {
  it("prepares without invoking Runner and permits exactly one start", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "helarc-prepared-run-"));
    const provider = new ScriptedProvider([{ action: "complete", summary: "Prepared." }]);
    const prepared = await prepareTestHostRun({
      task: createTask(workspaceRoot),
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

  it("exposes only read-only Actions while retaining trusted mutation registrations", async () => {
    const task = createTask("D:/workspace");
    const composition = await createHelarcActionComposition(task, { enableShell: false });

    expect(composition.exposedCatalog.tools.map((tool) => tool.name)).toEqual([
      "codeAgent.listFiles",
      "codeAgent.readFile",
      "codeAgent.searchFiles",
    ]);
    expect(composition.registrations.registrations.map(({ actionName }) => actionName))
      .toEqual(expect.arrayContaining([
        "codeAgent.createFile",
        "codeAgent.updateFile",
        "codeAgent.deleteFile",
      ]));
    expect(composition.exposedCatalog.tools.some(({ name }) => name === "codeAgent.createFile"))
      .toBe(false);
  });

  it("adds the canonical command Action only when shell execution is enabled", async () => {
    const task = createTask("D:/workspace");
    const composition = await createHelarcActionComposition(task, { enableShell: true });

    expect(composition.exposedCatalog.tools.map(({ name }) => name))
      .toContain("codeAgent.runCommand");
    expect(composition.registrations.registrations.map(({ actionName }) => actionName))
      .toContain("codeAgent.runCommand");
  });

  it("runs one read-only tool call and completes with ordered activity", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "helarc-session-"));
    await mkdir(join(workspaceRoot, "src"));
    await writeFile(join(workspaceRoot, "src", "index.ts"), "export const value = 1;\n");

    const provider = new ScriptedProvider([
      {
        action: "call_tool",
        reason: "Inspect workspace files.",
        toolName: "codeAgent.listFiles",
        input: { path: ".", recursive: true },
      },
      {
        action: "complete",
        summary: "Workspace contains src/index.ts. No changes needed.",
      },
    ]);

    const result = await executeReadOnlyTestHostRun({
      task: createTask(workspaceRoot),
      provider,
      now: () => "2026-06-28T00:00:00.000Z",
    });

    expect(result.product.status).toBe("completed");
    expect(result.runResult.status).toBe("succeeded");
    expect(result.product.output).toMatchObject({
      agentSummary: "Workspace contains src/index.ts. No changes needed.",
      runtimeStatus: "succeeded",
      patchStatus: null,
      appliedPath: null,
      safeErrors: [],
    });
    expect(result.activity.map((item) => item.kind)).toEqual([
      "run.started",
      "controller.started",
      "run.item.appended",
      "retry.attempt.started",
      "run.item.appended",
      "retry.attempt.started",
      "run.item.appended",
      "retry.attempt.finished",
      "run.item.appended",
      "retry.attempt.finished",
      "run.item.appended",
      "controller.finished",
      "run.item.appended",
      "tool.started",
      "run.item.appended",
      "action.prepared",
      "run.item.appended",
      "action.assessed",
      "run.item.appended",
      "sandbox.attempt.started",
      "run.item.appended",
      "sandbox.attempt.resolved",
      "run.item.appended",
      "observation.created",
      "context.updated",
      "evidence.created",
      "tool.finished",
      "controller.started",
      "run.item.appended",
      "retry.attempt.started",
      "run.item.appended",
      "retry.attempt.started",
      "run.item.appended",
      "retry.attempt.finished",
      "run.item.appended",
      "retry.attempt.finished",
      "run.item.appended",
      "controller.finished",
      "run.item.appended",
      "run.completed",
    ]);
    expect(provider.requests).toHaveLength(2);
    expect(provider.lastControllerInputContexts).toEqual([0, 1]);
    expect(result.activity.find((item) => item.metadata.controllerAction === "call_tool")?.metadata).toMatchObject({
      controllerAction: "call_tool",
      requestedToolName: "codeAgent.listFiles",
      promptArchitectureVersion: "helarc-prompt-v1",
      actionContractVersion: "helarc-action-v1",
      toolCatalogVersion: "helarc-tool-catalog-v1",
      exposedToolNames: [
        "codeAgent.listFiles",
        "codeAgent.readFile",
        "codeAgent.searchFiles",
      ],
    });
  });

  it("projects Provider request retry history through Runner activity", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "helarc-provider-retry-"));
    const provider = new RetryThenCompleteProvider();

    const result = await executeReadOnlyTestHostRun({
      task: createTask(workspaceRoot),
      provider,
      now: () => "2026-07-14T00:00:00.000Z",
    });

    expect(result.product.status).toBe("completed");
    expect(provider.requests).toHaveLength(2);
    const retryActivity = result.activity.filter((item) =>
      item.kind.startsWith("retry.") && item.metadata.owner === "provider_request"
    );
    expect(retryActivity.map((item) => item.kind)).toEqual([
      "retry.attempt.started",
      "retry.attempt.finished",
      "retry.scheduled",
      "retry.attempt.started",
      "retry.attempt.finished",
    ]);
    expect(new Set(retryActivity.map((item) => item.metadata.operationId))).toEqual(
      new Set(["helarc-task-1:controller:1:provider-request:1"]),
    );
    expect(retryActivity.find((item) => item.kind === "retry.scheduled")?.metadata).toMatchObject({
      owner: "provider_request",
      nextAttemptNumber: 2,
      delayMs: 0,
      failureCategory: "transport",
      failureCode: "provider_unavailable",
    });
    expect(retryActivity.every((item) => Object.isFrozen(item.metadata))).toBe(true);
    expect(JSON.stringify(retryActivity)).not.toContain("Provider is temporarily unavailable.");
  });

  it("runs list, read, and search tools inside the workspace boundary", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "helarc-read-only-tools-"));
    await mkdir(join(workspaceRoot, "src"));
    await writeFile(join(workspaceRoot, "src", "index.ts"), "export const value = 42;\n");

    const provider = new ScriptedProvider([
      {
        action: "call_tool",
        reason: "List workspace files.",
        toolName: "codeAgent.listFiles",
        input: { path: ".", recursive: true },
      },
      {
        action: "call_tool",
        reason: "Read the source file.",
        toolName: "codeAgent.readFile",
        input: { path: "src/index.ts" },
      },
      {
        action: "call_tool",
        reason: "Search for the exported value.",
        toolName: "codeAgent.searchFiles",
        input: { path: ".", query: "value" },
      },
      {
        action: "complete",
        summary: "Read-only tools completed.",
      },
    ]);

    const result = await executeReadOnlyTestHostRun({
      task: createTask(workspaceRoot),
      provider,
    });

    expect(result.product.status).toBe("completed");
    expect(result.product.output.agentSummary).toBe("Read-only tools completed.");
    expect(result.runResult.evidenceRefs).toHaveLength(3);
    expect(result.activity.filter((item) => item.kind === "tool.finished")).toHaveLength(3);
    expect(provider.lastControllerInputContexts).toEqual([0, 1, 2, 3]);
  });

  it("does not register shell execution in the default read-only session", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "helarc-read-only-shell-blocked-"));
    const markerPath = join(workspaceRoot, "marker.txt");
    const provider = new ScriptedProvider([
      {
        action: "call_tool",
        reason: "Try a shell command.",
        toolName: "codeAgent.runCommand",
        input: createShellInput(markerPath),
      },
      {
        action: "complete",
        summary: "Shell execution is not available in this session.",
      },
    ]);

    const result = await executeReadOnlyTestHostRun({
      task: createTask(workspaceRoot),
      provider,
    });

    expect(result.product.status).toBe("completed");
    expect(result.product.output.safeErrors).toEqual([]);
    expect(provider.requests).toHaveLength(2);
    expect(provider.requests[1].metadata).toMatchObject({
      structuredOutputAttemptNumber: 2,
      structuredOutputCorrectionCategory: "structured_output_semantic",
      structuredOutputCorrectionCode: "controller_tool_name_unsupported",
    });
    expect(provider.requests[1].messages.at(-1)?.content).toContain(
      "Use only a Tool exposed in the active Tool catalog.",
    );
    expect(result.runResult.items.some((item) =>
      item.kind === "action" && item.action.name === "codeAgent.runCommand"
    )).toBe(false);
    await expect(access(markerPath)).rejects.toThrow();
  });

  it("rejects selected managed enforcement without a matching provider", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "helarc-managed-unavailable-"));
    const provider = new ScriptedProvider([{ action: "complete", summary: "Must not run." }]);

    await expect(executeReadOnlyTestHostRun({
      task: createTask(workspaceRoot),
      provider,
      enforcement: "managed",
    })).rejects.toThrow("requires a matching SandboxProvider");
    expect(provider.requests).toHaveLength(0);
  });

  it("rejects a cross-Run Patch review bridge before Provider or Runner invocation", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "helarc-patch-bridge-mismatch-"));
    const provider = new ScriptedProvider([{ action: "complete", summary: "Must not run." }]);

    await expect(executeReadOnlyTestHostRun({
      task: createTask(workspaceRoot),
      provider,
      patchReviewBridge: createHelarcPatchReviewBridge({ runId: "run-other" }),
    })).rejects.toThrow("patch review bridge Run identity does not match");
    expect(provider.requests).toHaveLength(0);
  });

  it("exhausts repeated malformed output without materializing model items or Actions", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "helarc-output-exhausted-"));
    const firstInvalidOutput = "PRIVATE_INVALID_OUTPUT_1";
    const provider = new ScriptedProvider([
      firstInvalidOutput,
      "PRIVATE_INVALID_OUTPUT_2",
    ]);

    const result = await executeReadOnlyTestHostRun({
      task: createTask(workspaceRoot),
      provider,
    });

    expect(result.product.status).toBe("failed");
    expect(result.runResult).toMatchObject({
      status: "failed",
      code: "model_structured_output_retry_exhausted",
      errors: [{
        owner: "model",
        code: "model_structured_output_retry_exhausted",
      }],
    });
    expect(result.runResult.items.some((item) =>
      item.kind === "model_output" || item.kind === "action"
    )).toBe(false);
    expect(provider.requests).toHaveLength(2);
    expect(JSON.stringify(provider.requests[1])).not.toContain(firstInvalidOutput);
  });

  it("keeps command execution behind approval even when enforcement is disabled", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "helarc-shell-denied-"));
    const markerPath = join(workspaceRoot, "marker.txt");
    const provider = new ScriptedProvider([
      {
        action: "call_tool",
        reason: "Try a shell command.",
        toolName: "codeAgent.runCommand",
        input: createShellInput(markerPath),
      },
      {
        action: "stop",
        reason: "Permission was denied.",
      },
    ]);
    const result = await executeTestHostRun({
      task: createTask(workspaceRoot),
      provider,
      enableShell: true,
      permissionPreset: "approve_for_me",
      automaticApprovalReviewer: automaticReviewer("decline"),
    });

    expect(result.product.status).toBe("blocked");
    expect(result.runResult.items.some((item) => item.kind === "approval_requested")).toBe(true);
    expect(result.runResult.items.some((item) => item.kind === "sandbox_attempt_started"))
      .toBe(false);
    await expect(access(markerPath)).rejects.toThrow();
  });

  it("does not weaken approval when the automatic reviewer is unavailable", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "helarc-reviewer-unavailable-"));
    const markerPath = join(workspaceRoot, "marker.txt");
    const provider = new ScriptedProvider([
      {
        action: "call_tool",
        reason: "Try a shell command.",
        toolName: "codeAgent.runCommand",
        input: createShellInput(markerPath),
      },
      {
        action: "stop",
        reason: "The automatic reviewer is unavailable.",
      },
    ]);

    const result = await executeTestHostRun({
      task: createTask(workspaceRoot),
      provider,
      enableShell: true,
      permissionPreset: "approve_for_me",
      automaticApprovalReviewer: unavailableAutomaticReviewer(),
    });

    expect(result.product.status).toBe("blocked");
    expect(result.runResult.items.some((item) => item.kind === "approval_requested")).toBe(true);
    expect(result.runResult.items).toContainEqual(expect.objectContaining({
      kind: "approval_resolved",
      record: expect.objectContaining({
        resolutionKind: "review_failure",
        code: "approval_reviewer_unavailable",
      }),
    }));
    expect(result.runResult.items.some((item) => item.kind === "sandbox_attempt_started"))
      .toBe(false);
    await expect(access(markerPath)).rejects.toThrow();
  });

  it("executes Full access commands through the explicit unisolated gateway", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "helarc-shell-granted-"));
    const markerPath = join(workspaceRoot, "marker.txt");
    const provider = new ScriptedProvider([
      {
        action: "call_tool",
        reason: "Create a marker.",
        toolName: "codeAgent.runCommand",
        input: createShellInput(markerPath),
      },
      {
        action: "complete",
        summary: "Shell command completed.",
      },
    ]);

    const result = await executeTestHostRun({
      task: createTask(workspaceRoot),
      provider,
      enableShell: true,
      permissionPreset: "full_access",
    });

    expect(result.product.status).toBe("completed");
    expect(result.product.output.agentSummary).toBe("Shell command completed.");
    await expect(access(markerPath)).resolves.toBeUndefined();
    expect(result.product.output.enforcement).toEqual({
      selected: "disabled",
      status: "unisolated",
      code: null,
    });
    expect(result.runResult.items).toContainEqual(expect.objectContaining({
      kind: "sandbox_attempt_resolved",
      resolution: expect.objectContaining({ enforcement: "disabled", outcome: "executed" }),
    }));
    expect(provider.lastControllerInputContexts).toEqual([0, 1]);
  });

  it("updates the Runner-owned plan and exposes it to the next controller turn", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "helarc-plan-update-"));
    const provider = new ScriptedProvider([
      {
        action: "update_plan",
        explanation: "The task has multiple steps.",
        plan: [
          { step: "Inspect workspace", status: "in_progress" },
          { step: "Finish task", status: "pending" },
        ],
      },
      {
        action: "complete",
        summary: "Plan was recorded.",
      },
    ]);

    const result = await executeReadOnlyTestHostRun({
      task: createTask(workspaceRoot),
      provider,
    });

    expect(result.product.status).toBe("completed");
    expect(provider.lastControllerInputPlans).toEqual([
      null,
      {
        id: "helarc-task-1:plan:1",
        version: 1,
        status: "active",
        steps: [
          { step: "Inspect workspace", status: "in_progress" },
          { step: "Finish task", status: "pending" },
        ],
      },
    ]);
  });

  it("materializes and applies an accepted proposed patch", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "helarc-patch-accepted-"));
    await mkdir(join(workspaceRoot, "src"));
    const provider = new ScriptedProvider([
      {
        action: "propose",
        summary: "Create a new file.",
        change: {
          operation: "create",
          path: "src/created.txt",
          content: "created\n",
        },
      },
    ]);

    const result = await executeTestHostRun({
      task: createTask(workspaceRoot),
      provider,
      patchReviewBridge: automaticPatchReviewBridge(
        "helarc-task-1",
        "accepted",
        (review) => {
        expect(review).toMatchObject({
          operation: "create",
          path: "src/created.txt",
          originalContent: null,
          proposedContent: "created\n",
          phase: "reviewing",
        });
        },
      ),
    });

    expect(result.product.status).toBe("completed");
    expect(result.runResult).toMatchObject({
      status: "succeeded",
      finalOutput: {
        kind: "complete",
        summary: "Create a new file.",
      },
      errors: [],
    });
    expect(result.product.output).toMatchObject({
      patchStatus: "applied",
      appliedPath: "src/created.txt",
      safeErrors: [],
    });
    expect(provider.requests).toHaveLength(1);
    expect(result.runResult.items).toContainEqual(expect.objectContaining({
      kind: "action",
      action: expect.objectContaining({ name: "codeAgent.createFile" }),
    }));
    expect(result.runResult.metadata.helarcToolCatalog).not.toEqual(
      expect.objectContaining({
        tools: expect.arrayContaining([
          expect.objectContaining({ name: "codeAgent.createFile" }),
        ]),
      }),
    );
    await expect(readFile(join(workspaceRoot, "src", "created.txt"), "utf8"))
      .resolves.toBe("created\n");
  });

  it("keeps files unchanged when a proposed patch is rejected", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "helarc-patch-rejected-"));
    await mkdir(join(workspaceRoot, "src"));
    await writeFile(join(workspaceRoot, "src", "existing.txt"), "before\n");
    const provider = new ScriptedProvider([
      {
        action: "propose",
        summary: "Update the file.",
        change: {
          operation: "update",
          path: "src/existing.txt",
          content: "after\n",
        },
      },
    ]);

    const result = await executeTestHostRun({
      task: createTask(workspaceRoot),
      provider,
      patchReviewBridge: automaticPatchReviewBridge(
        "helarc-task-1",
        "rejected",
        (review) => {
        expect(review).toMatchObject({
          operation: "update",
          originalContent: "before\n",
          proposedContent: "after\n",
        });
        },
      ),
    });

    expect(result.product.status).toBe("rejected");
    expect(result.runResult).toMatchObject({
      status: "succeeded",
      finalOutput: {
        kind: "complete",
        summary: "Update the file.",
      },
      errors: [],
    });
    expect(result.product.output).toMatchObject({
      patchStatus: "rejected",
      appliedPath: null,
      safeErrors: [],
    });
    await expect(readFile(join(workspaceRoot, "src", "existing.txt"), "utf8"))
      .resolves.toBe("before\n");
  });

  it("reports a stale patch failure when content changes after review", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "helarc-patch-stale-"));
    await mkdir(join(workspaceRoot, "src"));
    const targetPath = join(workspaceRoot, "src", "existing.txt");
    await writeFile(targetPath, "before\n");
    const provider = new ScriptedProvider([
      {
        action: "propose",
        summary: "Update the file.",
        change: {
          operation: "update",
          path: "src/existing.txt",
          content: "after\n",
        },
      },
    ]);

    const result = await executeTestHostRun({
      task: createTask(workspaceRoot),
      provider,
      patchReviewBridge: automaticPatchReviewBridge(
        "helarc-task-1",
        "accepted",
        async () => {
          await writeFile(targetPath, "changed\n");
        },
      ),
    });

    expect(result.product.status).toBe("failed");
    expect(result.runResult).toMatchObject({
      status: "succeeded",
      finalOutput: {
        kind: "complete",
        summary: "Update the file.",
      },
      errors: [],
    });
    expect(result.product.output).toMatchObject({
      patchStatus: "failed",
      appliedPath: null,
      safeErrors: [{
        code: "action_invalid",
        message: "The file target no longer matches the supplied content baseline.",
      }],
    });
    await expect(readFile(targetPath, "utf8")).resolves.toBe("changed\n");
  });
});

function automaticPatchReviewBridge(
  runId: string,
  decision: "accepted" | "rejected",
  onReview?: (
    review: NonNullable<ReturnType<ReturnType<typeof createHelarcPatchReviewBridge>["getPendingProjection"]>>,
  ) => void | Promise<void>,
) {
  const bridge = createHelarcPatchReviewBridge({ runId });
  bridge.subscribe(async (review) => {
    if (review === null || review.phase !== "reviewing") return;
    await onReview?.(review);
    const receipt = bridge.submitDecision({
      submissionId: `${review.reviewId}:test-submission`,
      runId: review.runId,
      proposalId: review.proposalId,
      reviewId: review.reviewId,
      pendingVersion: review.pendingVersion,
      decision,
      reason: decision === "accepted" ? "Looks good." : "Not this change.",
    });
    if (receipt.status !== "accepted_for_resolution") {
      throw new Error(`Patch review submission failed: ${receipt.code}.`);
    }
  });
  return bridge;
}

function automaticReviewer(decisionKind: "accept" | "decline") {
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
  readonly descriptor = {
    id: "scripted-helarc-provider",
    name: "Scripted Helarc Provider",
    capabilities: {
      supportsToolPlanning: true,
      supportsStructuredOutput: true,
      supportsStreaming: false,
    },
    requestRetryScheduler: { kind: "platform" as const },
    metadata: {},
  };
  readonly requests: ProviderRequest[] = [];
  readonly lastControllerInputContexts: number[] = [];
  readonly lastControllerInputPlans: unknown[] = [];

  constructor(private readonly outputs: unknown[]) {}

  async send(
    request: ProviderRequest,
    _context: InvocationInterruptionContext,
  ): Promise<ProviderCallResult> {
    this.requests.push(request);
    this.lastControllerInputContexts.push(readObservationCount(request));
    this.lastControllerInputPlans.push(readCurrentPlan(request));
    const output = this.outputs.shift();
    if (!output) {
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

    return {
      kind: "succeeded",
      response: {
        output,
        usage: null,
        metadata: {},
      },
    };
  }
}

class RetryThenCompleteProvider implements Provider {
  readonly descriptor = {
    id: "retry-then-complete-provider",
    name: "Retry Then Complete Provider",
    capabilities: {
      supportsToolPlanning: true,
      supportsStructuredOutput: true,
      supportsStreaming: false,
    },
    requestRetryScheduler: { kind: "platform" as const },
    metadata: {},
  };
  readonly requests: ProviderRequest[] = [];

  async send(request: ProviderRequest): Promise<ProviderCallResult> {
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

    return {
      kind: "succeeded",
      response: {
        output: { action: "complete", summary: "Recovered after retry." },
        usage: null,
        metadata: {},
      },
    };
  }
}

function createTask(workspaceRoot: string) {
  const result = createHelarcTask({
    taskId: "helarc-task-1",
    prompt: "Inspect the workspace.",
    createdAt: "2026-06-28T00:00:00.000Z",
    workspace: {
      id: "workspace",
      name: "workspace",
      rootRef: workspaceRoot,
    },
  });

  if (!result.ok) {
    throw new Error(result.error.message);
  }

  return result.task;
}

function readObservationCount(request: ProviderRequest): number {
  const content = request.messages.find((message) => message.role === "user")?.content ?? "";
  const marker = "Observations:";
  const nextMarker = "Evidence refs:";
  const index = content.indexOf(marker);
  const nextIndex = content.indexOf(nextMarker);
  if (index < 0 || nextIndex < index) {
    return 0;
  }

  try {
    const json = content.slice(index + marker.length, nextIndex).trim();
    const parsed = JSON.parse(json) as ContextProjection["observations"];
    return Array.isArray(parsed) ? parsed.length : 0;
  } catch {
    return 0;
  }
}

function readCurrentPlan(request: ProviderRequest): unknown {
  const content = request.messages.find((message) => message.role === "user")?.content ?? "";
  const marker = "Current plan:";
  const index = content.indexOf(marker);
  if (index < 0) {
    return null;
  }

  try {
    return JSON.parse(content.slice(index + marker.length).trim()) as unknown;
  } catch {
    return null;
  }
}

function createShellInput(markerPath: string) {
  return {
    command: process.execPath,
    args: [
      "-e",
      `require('node:fs').writeFileSync(${JSON.stringify(markerPath)}, 'ran')`,
    ],
    cwd: ".",
    timeoutMs: 1_000,
    reason: "Create a governed marker file.",
  };
}
