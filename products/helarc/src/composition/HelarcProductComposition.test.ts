import type {
  Provider,
  ProviderCallResult,
  ProviderRequest,
} from "@agent-anything/providers";
import type { InvocationInterruptionContext } from "@agent-anything/shared";
import { createFailedRunResult } from "@agent-anything/agent-core/run";
import { describe, expect, it } from "vitest";
import { createHelarcTask } from "../task/index.js";
import { createHelarcProductComposition } from "./HelarcProductComposition.js";

describe("HelarcProductComposition", () => {
  it("defines one invocation's product behavior without exposing an execution entry point", async () => {
    const composition = await createHelarcProductComposition({
      runId: "run-1",
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
      runId: "run-1",
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

  it("projects trusted failures into bounded product messages without leaking raw data", async () => {
    const secret = "sentinel-provider-secret";
    const composition = await createHelarcProductComposition({
      runId: "run-1",
      task: createTask("D:/workspace"),
      provider: new UnusedProvider(),
      toolMode: "read-only",
    });

    const result = composition.projectResult(createFailedRunResult({
      runId: "run-1",
      taskId: "helarc-composition-test-task",
      metadata: { rawProvider: secret },
    }, "provider_request_failed", [{
      owner: "provider",
      code: "provider_request_failed",
      message: `Provider failed with ${secret}.`,
      retryable: false,
      metadata: { apiKey: secret },
    }]), "disabled");

    expect(result.output.safeErrors).toEqual([{
      code: "provider_request_failed",
      message: "The model request could not be completed.",
    }]);
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(result)).not.toContain("rawProvider");
    expect(JSON.stringify(result)).not.toContain("apiKey");
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
