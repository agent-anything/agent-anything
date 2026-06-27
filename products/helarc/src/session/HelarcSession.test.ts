import type { PlannerInput } from "@agent-anything/agent-core";
import type { Provider, ProviderRequest, ProviderResponse } from "@agent-anything/providers";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { createHelarcTask } from "../task/index.js";
import {
  createHelarcReadOnlyToolRegistry,
  runHelarcReadOnlySession,
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
