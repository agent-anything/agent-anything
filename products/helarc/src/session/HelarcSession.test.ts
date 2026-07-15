import type { ContextProjection } from "@agent-anything/agent-core";
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
import { createHelarcTask } from "../task/index.js";
import {
  createHelarcReadOnlyToolRegistry,
  createHelarcToolRegistry,
  runHelarcReadOnlySession,
  runHelarcSession,
} from "./index.js";

describe("Helarc read-only session", () => {
  it("registers only read-only code-agent tools", () => {
    const task = createTask("D:/workspace");
    const registry = createHelarcReadOnlyToolRegistry(task);

    expect(registry.list().map((tool) => tool.name)).toEqual([
      "codeAgent.listFiles",
      "codeAgent.readFile",
      "codeAgent.searchFiles",
    ]);
    expect(registry.has("codeAgent.writeFile")).toBe(false);
  });

  it("adds governed shell only when shell execution is enabled", () => {
    const task = createTask("D:/workspace");
    const registryResult = createHelarcToolRegistry(task, { enableShell: true });

    expect(registryResult.registry.has("codeAgent.runCommand")).toBe(true);
    expect(registryResult.toolExecutionContextResolver).toBeDefined();
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

    const result = await runHelarcReadOnlySession({
      task: createTask(workspaceRoot),
      provider,
      now: () => "2026-06-28T00:00:00.000Z",
    });

    expect(result.status).toBe("completed");
    expect(result.runResult.status).toBe("succeeded");
    expect(result.output).toMatchObject({
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
      "tool.finished",
      "run.item.appended",
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

    const result = await runHelarcReadOnlySession({
      task: createTask(workspaceRoot),
      provider,
      now: () => "2026-07-14T00:00:00.000Z",
    });

    expect(result.status).toBe("completed");
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

    const result = await runHelarcReadOnlySession({
      task: createTask(workspaceRoot),
      provider,
    });

    expect(result.status).toBe("completed");
    expect(result.output.agentSummary).toBe("Read-only tools completed.");
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

    const result = await runHelarcReadOnlySession({
      task: createTask(workspaceRoot),
      provider,
    });

    expect(result.status).toBe("completed");
    expect(result.output.safeErrors).toEqual([]);
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

  it("exhausts repeated malformed output without materializing model items or Actions", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "helarc-output-exhausted-"));
    const firstInvalidOutput = "PRIVATE_INVALID_OUTPUT_1";
    const provider = new ScriptedProvider([
      firstInvalidOutput,
      "PRIVATE_INVALID_OUTPUT_2",
    ]);

    const result = await runHelarcReadOnlySession({
      task: createTask(workspaceRoot),
      provider,
    });

    expect(result.status).toBe("failed");
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

  it("fails closed before shell process start without Phase16 enforcement", async () => {
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
    const result = await runHelarcSession({
      task: createTask(workspaceRoot),
      provider,
      enableShell: true,
    });

    expect(result.status).toBe("blocked");
    expect(result.output.safeErrors).toEqual([
      {
        code: "permission_unavailable",
        message: "Denied because permissionMode: ask requires a host-provided prompt service.",
      },
    ]);
    await expect(access(markerPath)).rejects.toThrow();
  });

  it("does not let a Host approval composition bypass the temporary shell path", async () => {
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
        summary: "Shell command was not executed.",
      },
    ]);

    const result = await runHelarcSession({
      task: createTask(workspaceRoot),
      provider,
      enableShell: true,
    });

    expect(result.status).toBe("completed");
    expect(result.output.agentSummary).toBe("Shell command was not executed.");
    await expect(access(markerPath)).rejects.toThrow();
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

    const result = await runHelarcReadOnlySession({
      task: createTask(workspaceRoot),
      provider,
    });

    expect(result.status).toBe("completed");
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

    const result = await runHelarcSession({
      task: createTask(workspaceRoot),
      provider,
      patchReviewBridge: async (review) => {
        expect(review).toMatchObject({
          operation: "create",
          path: "src/created.txt",
          originalContent: null,
          proposedContent: "created\n",
          decisionState: "pending",
        });
        return { decision: "accepted", reason: "Looks good." };
      },
    });

    expect(result.status).toBe("completed");
    expect(result.runResult).toMatchObject({
      status: "succeeded",
      finalOutput: {
        kind: "propose",
        summary: "Create a new file.",
      },
      errors: [],
    });
    expect(result.output).toMatchObject({
      patchStatus: "applied",
      appliedPath: "src/created.txt",
      safeErrors: [],
    });
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

    const result = await runHelarcSession({
      task: createTask(workspaceRoot),
      provider,
      patchReviewBridge: async (review) => {
        expect(review).toMatchObject({
          operation: "update",
          originalContent: "before\n",
          proposedContent: "after\n",
        });
        return { decision: "rejected", reason: "Not this change." };
      },
    });

    expect(result.status).toBe("rejected");
    expect(result.runResult).toMatchObject({
      status: "succeeded",
      finalOutput: {
        kind: "propose",
        summary: "Update the file.",
      },
      errors: [],
    });
    expect(result.output).toMatchObject({
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

    const result = await runHelarcSession({
      task: createTask(workspaceRoot),
      provider,
      patchReviewBridge: async () => {
        await writeFile(targetPath, "changed\n");
        return { decision: "accepted" };
      },
    });

    expect(result.status).toBe("failed");
    expect(result.runResult).toMatchObject({
      status: "succeeded",
      finalOutput: {
        kind: "propose",
        summary: "Update the file.",
      },
      errors: [],
    });
    expect(result.output).toMatchObject({
      patchStatus: "failed",
      appliedPath: null,
      safeErrors: [{ code: "patch_stale" }],
    });
    await expect(readFile(targetPath, "utf8")).resolves.toBe("changed\n");
  });
});

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
