import type { Provider, ProviderRequest, ProviderResponse } from "@agent-anything/providers";
import { describe, expect, it } from "vitest";
import { HelarcMainController } from "./HelarcMainController.js";

describe("HelarcMainController", () => {
  it("keeps workspace authority in main state", () => {
    const controller = new HelarcMainController({ provider: new CompleteProvider() });

    const snapshot = controller.selectWorkspacePath("D:/projects/agent-anything");

    expect(snapshot).toMatchObject({
      status: "workspace_selected",
      workspace: {
        id: "workspace",
        name: "agent-anything",
        path: "D:\\projects\\agent-anything",
      },
      provider: { configured: true },
      activity: [],
      output: null,
      error: null,
    });
  });

  it("rejects renderer task text until main has a workspace", async () => {
    const controller = new HelarcMainController({ provider: new CompleteProvider() });

    const result = await controller.startSession({ taskText: "Update docs" });

    expect(result).toMatchObject({
      ok: false,
      error: { code: "workspace_not_selected" },
      snapshot: { status: "idle", workspace: null },
    });
  });

  it("rejects starting when provider configuration is missing", async () => {
    const controller = new HelarcMainController({
      providerConfigError: {
        code: "provider_config_missing",
        message: "Provider configuration is incomplete.",
        missingKeys: ["HELARC_PROVIDER_BASE_URL"],
      },
    });
    controller.selectWorkspacePath("D:/projects/agent-anything");

    const result = await controller.startSession({ taskText: "Update docs" });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "provider_config_missing",
        message: "Provider configuration is incomplete.",
      },
      snapshot: {
        provider: {
          configured: false,
          error: {
            code: "provider_config_missing",
            message: "Provider configuration is incomplete.",
          },
        },
      },
    });
    expect(JSON.stringify(result)).not.toContain("HELARC_PROVIDER_BASE_URL");
  });

  it("runs a no-change read-only session after native workspace selection", async () => {
    const controller = new HelarcMainController({ provider: new CompleteProvider() });
    controller.selectWorkspacePath("D:/projects/agent-anything");

    const result = await controller.startSession({ taskText: "  Update docs  " });

    expect(result).toMatchObject({
      ok: true,
      taskId: "helarc-task-1",
      snapshot: {
        status: "completed",
        acceptedTask: {
          id: "helarc-task-1",
          prompt: "Update docs",
        },
        output: {
          agentSummary: "No changes needed.",
          runtimeStatus: "succeeded",
          patchStatus: null,
          appliedPath: null,
          safeErrors: [],
        },
        error: null,
      },
    });
    expect(result.snapshot.activity.map((item) => item.kind)).toContain("planner.started");
    expect(result.snapshot.activity.map((item) => item.kind)).toContain("plan.created");
  });

  it("rejects relative workspace paths", () => {
    const controller = new HelarcMainController({ provider: new CompleteProvider() });

    const snapshot = controller.selectWorkspacePath("relative/project");

    expect(snapshot).toMatchObject({
      status: "idle",
      workspace: null,
      error: { code: "workspace_path_not_absolute" },
    });
  });
});

class CompleteProvider implements Provider {
  readonly capabilities = {
    id: "complete-provider",
    name: "Complete Provider",
    supportsToolPlanning: true,
    supportsStructuredOutput: true,
    supportsStreaming: false,
    metadata: {},
  };

  async send(_request: ProviderRequest): Promise<ProviderResponse> {
    return {
      status: "succeeded",
      output: {
        action: "complete",
        summary: "No changes needed.",
      },
      usage: null,
      error: null,
      metadata: {},
    };
  }
}
