import type { Provider, ProviderRequest, ProviderResponse } from "@agent-anything/providers";
import { access, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HelarcMainController, type HelarcMainSnapshot } from "./HelarcMainController.js";

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

    const completed = waitForStatus(controller, "completed");
    const result = controller.startSession({ taskText: "  Update docs  " });

    expect(result).toMatchObject({
      ok: true,
      taskId: "helarc-task-1",
      snapshot: {
        status: "running",
        acceptedTask: {
          id: "helarc-task-1",
          prompt: "Update docs",
        },
        output: null,
        error: null,
      },
    });

    const snapshot = await completed;
    expect(snapshot).toMatchObject({
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
    });
    expect(snapshot.activity.map((item) => item.kind)).toContain("planner.started");
    expect(snapshot.activity.map((item) => item.kind)).toContain("plan.created");
  });

  it("correlates shell permission decisions and blocks denied commands", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "helarc-desktop-permission-"));
    const markerPath = join(workspaceRoot, "marker.txt");
    const controller = new HelarcMainController({
      provider: new ScriptedProvider([
        {
          action: "call_tool",
          reason: "Create a marker.",
          toolName: "codeAgent.runCommand",
          input: {
            command: process.execPath,
            args: [
              "-e",
              `require('node:fs').writeFileSync(${JSON.stringify(markerPath)}, 'ran')`,
            ],
            cwd: ".",
            timeoutMs: 1_000,
            reason: "Create a governed marker file.",
          },
        },
      ]),
    });
    controller.selectWorkspacePath(workspaceRoot);

    const waiting = waitForStatus(controller, "waiting_for_permission");
    const blocked = waitForStatus(controller, "blocked");
    const result = controller.startSession({ taskText: "Run command" });

    expect(result).toMatchObject({ ok: true, snapshot: { status: "running" } });
    const waitingSnapshot = await waiting;
    const requestId = waitingSnapshot.pendingPermission?.requestId ?? "";
    expect(waitingSnapshot.pendingPermission).toMatchObject({
      toolName: "codeAgent.runCommand",
      reason: "Create a governed marker file.",
      command: process.execPath,
    });

    expect(controller.resolvePermission({
      requestId: "stale-request",
      decision: "granted",
    })).toMatchObject({
      ok: false,
      error: { code: "permission_request_mismatch" },
    });

    expect(controller.resolvePermission({
      requestId,
      decision: "denied",
    })).toMatchObject({ ok: true, snapshot: { status: "running" } });

    const blockedSnapshot = await blocked;
    expect(blockedSnapshot).toMatchObject({
      status: "blocked",
      output: {
        safeErrors: [{ code: "permission_denied" }],
      },
    });
    expect(controller.resolvePermission({
      requestId,
      decision: "granted",
    })).toMatchObject({
      ok: false,
      error: { code: "permission_not_pending" },
    });
    await expect(access(markerPath)).rejects.toThrow();
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

class ScriptedProvider implements Provider {
  readonly capabilities = {
    id: "scripted-provider",
    name: "Scripted Provider",
    supportsToolPlanning: true,
    supportsStructuredOutput: true,
    supportsStreaming: false,
    metadata: {},
  };

  constructor(private readonly outputs: unknown[]) {}

  async send(_request: ProviderRequest): Promise<ProviderResponse> {
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

function waitForStatus(
  controller: HelarcMainController,
  status: HelarcMainSnapshot["status"],
): Promise<HelarcMainSnapshot> {
  const snapshot = controller.getSnapshot();
  if (snapshot.status === status) {
    return Promise.resolve(snapshot);
  }

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      unsubscribe();
      reject(new Error(`Timed out waiting for ${status}.`));
    }, 2_000);

    const unsubscribe = controller.subscribeSnapshot((nextSnapshot) => {
      if (nextSnapshot.status === status) {
        clearTimeout(timeout);
        unsubscribe();
        resolve(nextSnapshot);
      }
    });
  });
}
