import type { PlannerInput } from "@agent-anything/agent-core";
import type { HostPermissionBridge } from "@agent-anything/agent-core/host";
import type { Provider, ProviderRequest, ProviderResponse } from "@agent-anything/providers";
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
    expect(result.runtimeResult.status).toBe("succeeded");
    expect(result.output).toMatchObject({
      agentSummary: "Workspace contains src/index.ts. No changes needed.",
      runtimeStatus: "succeeded",
      patchStatus: null,
      appliedPath: null,
      safeErrors: [],
    });
    expect(result.activity.map((item) => item.kind)).toEqual([
      "loop.iteration.started",
      "planner.started",
      "planner.finished",
      "plan.created",
      "tool.started",
      "tool.finished",
      "observation.created",
      "context.updated",
      "loop.iteration.finished",
      "loop.iteration.started",
      "planner.started",
      "planner.finished",
      "plan.created",
      "loop.iteration.finished",
    ]);
    expect(provider.requests).toHaveLength(2);
    expect(provider.lastPlannerInputContexts).toEqual([0, 1]);
  });

  it("blocks shell execution when permission is denied before process start", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "helarc-shell-denied-"));
    const markerPath = join(workspaceRoot, "marker.txt");
    const provider = new ScriptedProvider([
      {
        action: "call_tool",
        reason: "Try a shell command.",
        toolName: "codeAgent.runCommand",
        input: createShellInput(markerPath),
      },
    ]);
    const permissionBridge: HostPermissionBridge = async () => ({
      status: "denied",
      reason: "Denied by test.",
    });

    const result = await runHelarcSession({
      task: createTask(workspaceRoot),
      provider,
      enableShell: true,
      permissionBridge,
    });

    expect(result.status).toBe("blocked");
    expect(result.output.safeErrors).toEqual([
      { code: "permission_denied", message: "Denied by test." },
    ]);
    await expect(access(markerPath)).rejects.toThrow();
  });

  it("continues the same session after shell permission is granted", async () => {
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
    const permissionBridge: HostPermissionBridge = async () => ({
      status: "granted",
      reason: "Granted by test.",
    });

    const result = await runHelarcSession({
      task: createTask(workspaceRoot),
      provider,
      enableShell: true,
      permissionBridge,
    });

    expect(result.status).toBe("completed");
    expect(result.output.agentSummary).toBe("Shell command completed.");
    await expect(access(markerPath)).resolves.toBeUndefined();
    expect(provider.lastPlannerInputContexts).toEqual([0, 1]);
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
    expect(result.output).toMatchObject({
      patchStatus: "failed",
      appliedPath: null,
      safeErrors: [{ code: "patch_stale" }],
    });
    await expect(readFile(targetPath, "utf8")).resolves.toBe("changed\n");
  });
});

class ScriptedProvider implements Provider {
  readonly capabilities = {
    id: "scripted-helarc-provider",
    name: "Scripted Helarc Provider",
    supportsToolPlanning: true,
    supportsStructuredOutput: true,
    supportsStreaming: false,
    metadata: {},
  };
  readonly requests: ProviderRequest[] = [];
  readonly lastPlannerInputContexts: number[] = [];

  constructor(private readonly outputs: unknown[]) {}

  async send(request: ProviderRequest): Promise<ProviderResponse> {
    this.requests.push(request);
    this.lastPlannerInputContexts.push(readObservationCount(request));
    const output = this.outputs.shift();
    if (!output) {
      return {
        status: "failed",
        output: null,
        usage: null,
        error: { code: "script_exhausted", message: "Scripted provider exhausted." },
        metadata: {},
      };
    }

    return {
      status: "succeeded",
      output,
      usage: null,
      error: null,
      metadata: {},
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
    const parsed = JSON.parse(json) as PlannerInput["context"]["observations"];
    return Array.isArray(parsed) ? parsed.length : 0;
  } catch {
    return 0;
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
