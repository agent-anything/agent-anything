import type {
  InvocationInterruptionContext,
  Provider,
  ProviderCallResult,
  ProviderRequest,
} from "@agent-anything/providers";
import { describe, expect, it } from "vitest";
import { createHelarcTask } from "../task/index.js";
import { createHelarcProductComposition } from "./HelarcProductComposition.js";

describe("HelarcProductComposition", () => {
  it("defines one invocation's product behavior without exposing an execution entry point", async () => {
    const composition = await createHelarcProductComposition({
      task: createTask("D:/workspace"),
      provider: new UnusedProvider(),
      toolMode: "read-only",
    });

    expect(composition.agent).toMatchObject({
      id: "helarc-code-agent",
      name: "Helarc",
    });
    expect(composition.runMetadata).toMatchObject({
      product: "helarc",
      toolMode: "read-only",
    });
    expect("run" in composition).toBe(false);
    expect("start" in composition).toBe(false);
    expect("runner" in composition).toBe(false);
  });

  it("keeps the model catalog narrower than trusted mutation registrations", async () => {
    const composition = await createHelarcProductComposition({
      task: createTask("D:/workspace"),
      provider: new UnusedProvider(),
      toolMode: "read-only",
    });

    expect(composition.actions.exposedCatalog.tools.map(({ name }) => name)).toEqual([
      "codeAgent.listFiles",
      "codeAgent.readFile",
      "codeAgent.searchFiles",
    ]);
    expect(composition.actions.registrations.registrations.map(({ actionName }) => actionName))
      .toEqual(expect.arrayContaining([
        "codeAgent.createFile",
        "codeAgent.updateFile",
        "codeAgent.deleteFile",
      ]));
  });
});

function createTask(workspaceRoot: string) {
  const result = createHelarcTask({
    taskId: "helarc-composition-test-task",
    prompt: "Inspect the workspace.",
    workspace: {
      id: "workspace-1",
      name: "Workspace",
      rootRef: workspaceRoot,
    },
  });
  if (!result.ok) throw new Error(result.error.message);
  return result.task;
}

class UnusedProvider implements Provider {
  readonly descriptor = {
    id: "unused-provider",
    name: "Unused provider",
    capabilities: {
      supportsToolPlanning: true,
      supportsStructuredOutput: true,
      supportsStreaming: false,
    },
    requestRetryScheduler: { kind: "platform" as const },
    metadata: {},
  };

  async send(
    _request: ProviderRequest,
    _context: InvocationInterruptionContext,
  ): Promise<ProviderCallResult> {
    throw new Error("Provider must not be called while composing Helarc product behavior.");
  }
}
