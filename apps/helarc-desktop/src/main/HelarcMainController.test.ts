import type {
  HelarcPatchReviewDecisionSubmission,
  HelarcSessionHistoryRecord,
} from "@agent-anything/helarc";
import type {
  ApprovalDecisionKind,
  ApprovalDecisionSubmission,
} from "@agent-anything/permission";
import type {
  InvocationInterruptionContext,
  Provider,
  ProviderCallResult,
  ProviderRequest,
} from "@agent-anything/providers";
import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HelarcMainController, type HelarcMainSnapshot } from "./HelarcMainController.js";
import { FileHelarcThreadStore } from "./thread/index.js";

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
      run: null,
      error: null,
    });
    expect(snapshot.provider).toMatchObject({
      configured: true,
      activeProfile: {
        id: "test-provider",
        displayName: "Injected Test Provider",
        credentialStatus: "empty_allowed",
        isActive: true,
      },
      profiles: [
        {
          id: "test-provider",
          isActive: true,
        },
      ],
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
          activeProfile: null,
          profiles: [],
          error: {
            code: "provider_config_missing",
            message: "Provider configuration is incomplete.",
          },
        },
      },
    });
    expect(JSON.stringify(result)).not.toContain("HELARC_PROVIDER_BASE_URL");
  });

  it("uses injected safe provider profile metadata without exposing secrets", () => {
    const controller = new HelarcMainController({
      provider: new CompleteProvider(),
      providerProfile: {
        id: "env-provider",
        providerKind: "openai-compatible",
        displayName: "Environment Provider",
        endpointLabel: "provider.local",
        baseUrl: "https://provider.local/v1",
        baseUrlOrigin: "https://provider.local",
        model: "model-a",
        timeoutMs: 1500,
        credentialStatus: "present",
        isActive: true,
      },
    });

    const snapshot = controller.getSnapshot();

    expect(snapshot.provider).toEqual({
      configured: true,
      activeProfile: {
        id: "env-provider",
        providerKind: "openai-compatible",
        displayName: "Environment Provider",
        endpointLabel: "provider.local",
        baseUrl: "https://provider.local/v1",
        baseUrlOrigin: "https://provider.local",
        model: "model-a",
        timeoutMs: 1500,
        credentialStatus: "present",
        isActive: true,
      },
      profiles: [
        {
          id: "env-provider",
          providerKind: "openai-compatible",
          displayName: "Environment Provider",
          endpointLabel: "provider.local",
          baseUrl: "https://provider.local/v1",
          baseUrlOrigin: "https://provider.local",
          model: "model-a",
          timeoutMs: 1500,
          credentialStatus: "present",
          isActive: true,
        },
      ],
      error: null,
    });
    expect(JSON.stringify(snapshot)).not.toContain("secret");
  });

  it("exposes recent workspace profiles and selects restored profiles", () => {
    const controller = new HelarcMainController({
      provider: new CompleteProvider(),
      workspaceProfiles: [
        {
          id: "workspace:agent-anything",
          displayName: "agent-anything",
          path: "D:\\projects\\agent-anything",
          lastOpenedAt: "2026-06-30T07:00:00.000Z",
          trustState: "trusted",
        },
      ],
    });

    expect(controller.getSnapshot()).toMatchObject({
      workspace: null,
      workspaceProfiles: [
        {
          id: "workspace:agent-anything",
          displayName: "agent-anything",
          trustState: "trusted",
        },
      ],
    });

    const snapshot = controller.selectWorkspaceProfile({
      id: "workspace:agent-anything",
      displayName: "agent-anything",
      path: "D:\\projects\\agent-anything",
      lastOpenedAt: "2026-06-30T07:00:00.000Z",
      trustState: "trusted",
    });

    expect(snapshot).toMatchObject({
      status: "workspace_selected",
      workspace: {
        id: "workspace:agent-anything",
        name: "agent-anything",
        path: "D:\\projects\\agent-anything",
      },
    });
  });

  it("exposes built-in task templates without changing task flow", () => {
    const controller = new HelarcMainController({ provider: new CompleteProvider() });

    expect(controller.getSnapshot().taskTemplates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "inspect-code",
          title: "Inspect code",
          category: "inspect",
        }),
        expect.objectContaining({
          id: "implement-change",
          title: "Implement change",
          category: "edit",
        }),
      ]),
    );
  });

  it("runs a no-change read-only session after native workspace selection", async () => {
    const controller = new HelarcMainController({ provider: new CompleteProvider() });
    controller.selectWorkspacePath("D:/projects/agent-anything");

    const completed = waitForProductResult(controller, "completed");
    const result = controller.startSession({ taskText: "  Update docs  " });

    expect(result).toMatchObject({
      ok: true,
      taskId: "helarc-task-1",
      snapshot: {
        status: "starting",
        acceptedTask: {
          id: "helarc-task-1",
          prompt: "Update docs",
        },
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
      run: {
        display: { status: "completed", terminal: true, statusSource: "platform" },
        platform: { status: "completed", terminal: { status: "completed" } },
        product: {
          result: {
            output: {
              agentSummary: "No changes needed.",
              runtimeStatus: "succeeded",
              patchStatus: null,
              appliedPath: null,
              safeErrors: [],
            },
          },
        },
      },
      error: null,
    });
    expect(snapshot.run?.product.activity.map((item) => item.kind)).toContain("controller.started");
    expect(snapshot.run?.product.activity.map((item) => item.kind)).toContain("run.item.appended");
    expect(JSON.stringify(snapshot.run?.product.activity)).not.toContain("rawProvider");
    const refreshed = controller.getSnapshot();
    expect(refreshed.run).toBe(snapshot.run);
    expect(refreshed.run).toMatchObject({
      platform: { sequence: snapshot.run?.platform.sequence },
      product: { sequence: snapshot.run?.product.sequence },
    });
  });

  it("persists completed session history records for read-only review", async () => {
    let storedHistory: HelarcSessionHistoryRecord[] = [];
    const controller = new HelarcMainController({
      provider: new CompleteProvider(),
      providerProfile: {
        id: "provider-a",
        providerKind: "openai-compatible",
        displayName: "Provider A",
        endpointLabel: "provider.local",
        baseUrl: "https://provider.local/v1",
        baseUrlOrigin: "https://provider.local",
        model: "model-a",
        timeoutMs: 1000,
        credentialStatus: "present",
        isActive: true,
      },
      onSessionHistoryRecord: (record) => {
        storedHistory = [record, ...storedHistory];
        return storedHistory;
      },
    });
    controller.selectWorkspacePath("D:/projects/agent-anything");

    const completed = waitForSnapshot(
      controller,
      (snapshot) => snapshot.status === "completed" && snapshot.sessionHistory.length === 1,
    );
    controller.startSession({ taskText: "Update docs" });

    const snapshot = await completed;
    expect(snapshot.sessionHistory).toMatchObject([
      {
        taskText: "Update docs",
        status: "completed",
        workspace: {
          displayName: "agent-anything",
        },
        provider: {
          profileId: "provider-a",
          displayName: "Provider A",
          model: "model-a",
        },
        patch: {
          decision: "not_required",
          status: null,
        },
        run: {
          runId: "helarc-run-1",
          status: "completed",
          terminal: {
            status: "completed",
            runtimeStatus: "succeeded",
          },
        },
      },
    ]);
    expect(snapshot.sessionHistory[0]?.run.events.map((item) => item.kind)).toEqual(
      expect.arrayContaining(["planning.started", "provider.output", "runtime.output"]),
    );
    expect(JSON.stringify(snapshot.sessionHistory)).not.toContain("secret");
    expect(JSON.stringify(snapshot.sessionHistory)).not.toContain("rawProvider");
    expect(JSON.stringify(snapshot.sessionHistory)).not.toContain("pendingApproval");

    const restoredController = new HelarcMainController({
      providerConfigError: {
        code: "provider_config_missing",
        message: "Provider configuration is incomplete.",
        missingKeys: [],
      },
      sessionHistory: storedHistory,
    });
    expect(restoredController.getSnapshot().sessionHistory).toHaveLength(1);
  });

  it("does not let persistence failure replace the authoritative RunResult", async () => {
    const controller = new HelarcMainController({
      provider: new CompleteProvider(),
      onSessionHistoryRecord() {
        throw new Error("History store unavailable.");
      },
    });
    controller.selectWorkspacePath("D:/projects/agent-anything");

    const settled = waitForSnapshot(
      controller,
      (snapshot) =>
        snapshot.status === "completed"
        && snapshot.error?.code === "session_persistence_failed",
    );
    controller.startSession({ taskText: "Update docs" });

    const snapshot = await settled;
    expect(snapshot).toMatchObject({
      status: "completed",
      error: {
        code: "session_persistence_failed",
        message: "History store unavailable.",
      },
      run: {
        display: { status: "completed" },
        product: { result: { output: { runtimeStatus: "succeeded" } } },
        platform: {
          status: "completed",
          terminal: { status: "completed", code: null, cancellation: null },
        },
      },
    });
  });

  it("persists work context thread, trigger message, and run records", async () => {
    const threadStore = new FileHelarcThreadStore(await threadFilePath());
    const controller = new HelarcMainController({
      provider: new CompleteProvider(),
      providerProfile: {
        id: "provider-a",
        providerKind: "openai-compatible",
        displayName: "Provider A",
        endpointLabel: "provider.local",
        baseUrl: "https://provider.local/v1",
        baseUrlOrigin: "https://provider.local",
        model: "model-a",
        timeoutMs: 1000,
        credentialStatus: "present",
        isActive: true,
      },
      threadStore,
    });
    controller.selectWorkspacePath("D:/projects/agent-anything");

    const completed = waitForSnapshot(
      controller,
      (snapshot) =>
        snapshot.status === "completed"
        && snapshot.threadSummaries[0]?.latestRun?.status === "completed",
    );
    controller.startSession({ taskText: "Update docs" });
    await completed;

    const summaries = await threadStore.listThreadSummaries();
    expect(summaries).toMatchObject([
      {
        id: "helarc-thread-1",
        title: "Update docs",
        latestRun: {
          runId: "helarc-run-1",
          status: "completed",
        },
      },
    ]);

    await expect(threadStore.loadThread("helarc-thread-1")).resolves.toMatchObject({
      thread: {
        id: "helarc-thread-1",
        activeConversationId: "helarc-conversation-1",
        latestRunId: "helarc-run-1",
      },
      conversations: [
        {
          id: "helarc-conversation-1",
          messageIds: ["helarc-message-1", "helarc-message-1-assistant"],
        },
      ],
      messages: [
        {
          id: "helarc-message-1",
          role: "user",
          content: "Update docs",
          relatedRunIds: ["helarc-run-1"],
        },
        {
          id: "helarc-message-1-assistant",
          role: "assistant",
          content: "No changes needed.",
          relatedRunIds: ["helarc-run-1"],
          relatedArtifactIds: ["helarc-run-1-artifact-final-output"],
        },
      ],
      runs: [
        {
          id: "helarc-run-1",
          triggeringMessageId: "helarc-message-1",
          triggerMessageRole: "user",
          terminal: {
            platform: {
              status: "completed",
            },
            product: {
              status: "completed",
              output: {
                runtimeStatus: "succeeded",
                agentSummary: "No changes needed.",
              },
            },
          },
          artifactIds: ["helarc-run-1-artifact-final-output"],
          provider: {
            profileId: "provider-a",
            displayName: "Provider A",
            model: "model-a",
          },
        },
      ],
      artifacts: [
        {
          id: "helarc-run-1-artifact-final-output",
          kind: "final-output",
          title: "Final output",
          summary: "No changes needed.",
          runId: "helarc-run-1",
        },
      ],
    });

    const snapshot = controller.getSnapshot();
    expect(snapshot.threadSummaries).toMatchObject([
      {
        id: "helarc-thread-1",
        title: "Update docs",
        latestRun: {
          runId: "helarc-run-1",
          status: "completed",
        },
      },
    ]);
    expect(snapshot.activeThread).toMatchObject({
      id: "helarc-thread-1",
      title: "Update docs",
      activeConversationId: "helarc-conversation-1",
      messages: [
        {
          id: "helarc-message-1",
          role: "user",
          content: "Update docs",
        },
        {
          id: "helarc-message-1-assistant",
          role: "assistant",
          content: "No changes needed.",
          relatedArtifactIds: ["helarc-run-1-artifact-final-output"],
        },
      ],
      artifacts: [
        {
          id: "helarc-run-1-artifact-final-output",
          kind: "final-output",
          title: "Final output",
          summary: "No changes needed.",
        },
      ],
    });
  });

  it("correlates versioned approval submissions and preserves a decline", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "helarc-desktop-permission-"));
    const markerPath = join(workspaceRoot, "marker.txt");
    const controller = new HelarcMainController({
      runtimeToolMode: "shell-enabled",
      provider: new ScriptedProvider([
        {
          action: "request_permissions",
          rootId: "workspace",
          permissions: { fileSystem: { write: ["marker.txt"] } },
          reason: "Create a governed marker file.",
        },
        {
          action: "stop",
          reason: "Permission was denied.",
        },
      ]),
    });
    controller.selectWorkspacePath(workspaceRoot);

    const waiting = waitForPendingApproval(controller);
    const blocked = waitForSnapshot(
      controller,
      (snapshot) => snapshot.status === "blocked" && snapshot.sessionHistory.length === 1,
    );
    const result = controller.startSession({ taskText: "Run command" });

    expect(result).toMatchObject({ ok: true, snapshot: { status: "starting" } });
    const waitingSnapshot = await waiting;
    const pending = pendingApproval(waitingSnapshot);
    expect(pending).toMatchObject({
      phase: "reviewing",
      pendingVersion: 1,
      request: {
        category: "permissions",
        reason: "Create a governed marker file.",
      },
    });
    expect(waitingSnapshot.run).toMatchObject({
      display: { status: "waiting_for_approval", statusSource: "platform" },
      platform: {
        status: "waiting_for_approval",
        approval: {
          requestId: pending.request.id,
          pendingVersion: pending.pendingVersion,
          phase: "reviewing",
        },
      },
    });
    expect(controller.getSnapshot()).toMatchObject({
      status: "waiting_for_approval",
      run: { platform: { approval: { requestId: pending.request.id } } },
    });

    const decline = approvalSubmission(waitingSnapshot, "decline", {
      submissionId: "desktop-decline-1",
    });
    expect(controller.submitApprovalDecision({
      ...decline,
      requestId: "stale-request",
    })).toEqual({
      status: "rejected",
      submissionId: "desktop-decline-1",
      code: "approval_not_pending",
    });
    expect(controller.submitApprovalDecision({
      ...decline,
      submissionId: "desktop-stale-version-1",
      pendingVersion: decline.pendingVersion + 1,
    })).toEqual({
      status: "rejected",
      submissionId: "desktop-stale-version-1",
      code: "approval_version_mismatch",
    });

    const receipt = controller.submitApprovalDecision(decline);
    expect(receipt).toMatchObject({
      status: "accepted_for_resolution",
      submissionId: "desktop-decline-1",
      requestId: pending?.request.id,
      pendingVersion: pending?.pendingVersion,
    });
    expect(controller.submitApprovalDecision(decline)).toBe(receipt);
    expect(controller.submitApprovalDecision({
      ...decline,
      optionId: approvalSubmission(waitingSnapshot, "cancel").optionId,
    })).toEqual({
      status: "rejected",
      submissionId: "desktop-decline-1",
      code: "approval_submission_invalid",
    });
    expect(controller.getSnapshot()).toMatchObject({
      status: "waiting_for_approval",
      run: {
        display: { status: "waiting_for_approval" },
        platform: { approval: { phase: "submitted_for_resolution" } },
      },
    });

    const blockedSnapshot = await blocked;
    expect(blockedSnapshot).toMatchObject({
      status: "blocked",
      run: {
        display: { status: "blocked", statusSource: "platform" },
        platform: { status: "blocked", terminal: { status: "blocked" } },
        product: { result: { output: { safeErrors: [] } } },
      },
      sessionHistory: [{
        status: "blocked",
        run: {
          runId: "helarc-run-1",
          status: "failed",
          terminal: {
            status: "failed",
            runtimeStatus: "blocked",
          },
        },
      }],
    });
    expect(JSON.stringify(blockedSnapshot.sessionHistory)).not.toContain("pendingApproval");
    expect(controller.submitApprovalDecision({
      ...decline,
      submissionId: "desktop-late-1",
    })).toEqual({
      status: "rejected",
      submissionId: "desktop-late-1",
      code: "approval_not_pending",
    });
    await expect(access(markerPath)).rejects.toThrow();
  });

  it("accepts one explicit approval request and completes the same run", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "helarc-desktop-permission-allow-"));
    const markerPath = join(workspaceRoot, "marker.txt");
    const controller = new HelarcMainController({
      runtimeToolMode: "shell-enabled",
      provider: new ScriptedProvider([
        {
          action: "request_permissions",
          rootId: "workspace",
          permissions: { fileSystem: { write: ["marker.txt"] } },
          reason: "Create a governed marker file.",
        },
        {
          action: "complete",
          summary: "Permission was granted for this run.",
        },
      ]),
    });
    controller.selectWorkspacePath(workspaceRoot);

    const waiting = waitForPendingApproval(controller);
    const completed = waitForProductResult(controller, "completed");
    controller.startSession({ taskText: "Run command" });

    const waitingSnapshot = await waiting;
    const submitted = waitForSnapshot(
      controller,
      (snapshot) => snapshot.run?.platform.approval?.phase === "submitted_for_resolution",
    );
    expect(controller.submitApprovalDecision(
      approvalSubmission(waitingSnapshot, "grantPermissions"),
    )).toMatchObject({
      status: "accepted_for_resolution",
      requestId: pendingApproval(waitingSnapshot).request.id,
      pendingVersion: pendingApproval(waitingSnapshot).pendingVersion,
    });
    expect(await submitted).toMatchObject({
      status: "waiting_for_approval",
      run: {
        display: { status: "waiting_for_approval" },
        platform: { approval: { phase: "submitted_for_resolution" } },
      },
    });

    const completedSnapshot = await completed;
    expect(completedSnapshot).toMatchObject({
      status: "completed",
      run: {
        display: { status: "completed" },
        platform: { status: "completed", terminal: { status: "completed" } },
        product: {
          result: { output: { agentSummary: "Permission was granted for this run." } },
        },
      },
    });
    await expect(access(markerPath)).rejects.toThrow();
  });

  it("cancels while an explicit approval request is pending", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "helarc-desktop-permission-cancel-"));
    const markerPath = join(workspaceRoot, "marker.txt");
    const controller = new HelarcMainController({
      runtimeToolMode: "shell-enabled",
      provider: new ScriptedProvider([
        {
          action: "request_permissions",
          rootId: "workspace",
          permissions: { fileSystem: { write: ["marker.txt"] } },
          reason: "Create a governed marker file.",
        },
      ]),
    });
    controller.selectWorkspacePath(workspaceRoot);

    const waiting = waitForPendingApproval(controller);
    controller.startSession({ taskText: "Run command" });
    const waitingSnapshot = await waiting;
    const lateSubmission = approvalSubmission(waitingSnapshot, "grantPermissions", {
      submissionId: "desktop-after-cancel-1",
    });

    expect(controller.cancelSession()).toMatchObject({
      ok: true,
      snapshot: {
        status: "cancelling",
        run: {
          display: { status: "cancelling" },
          platform: {
            status: "cancelling",
            approval: null,
            cancellation: {
              origin: "user",
              reasonCode: "user_requested",
            },
          },
        },
      },
    });
    expect(controller.startSession({ taskText: "Start another run" })).toMatchObject({
      ok: false,
      error: { code: "session_already_running" },
      snapshot: { status: "cancelling" },
    });
    expect(controller.submitApprovalDecision(lateSubmission)).toEqual({
      status: "rejected",
      submissionId: "desktop-after-cancel-1",
      code: "approval_not_pending",
    });

    const terminalSnapshot = await waitForSnapshot(
      controller,
      (snapshot) =>
        snapshot.run?.platform.terminal?.status === "cancelled"
        && snapshot.sessionHistory.length === 1,
    );
    expect(terminalSnapshot).toMatchObject({
      status: "cancelled",
      run: {
        display: { status: "cancelled", statusSource: "platform" },
        platform: {
          status: "cancelled",
          terminal: { status: "cancelled", code: "runtime_cancelled" },
        },
      },
      sessionHistory: [{
        status: "cancelled",
        run: {
          runId: "helarc-run-1",
          status: "cancelled",
          terminal: {
            status: "cancelled",
            runtimeStatus: "cancelled",
            runtimeCode: "runtime_cancelled",
            cancellation: {
              origin: "user",
              reasonCode: "user_requested",
            },
          },
        },
      }],
    });
    expect(JSON.stringify(terminalSnapshot.run)).not.toContain(
      "Cancelled from Helarc desktop.",
    );
    expect(JSON.stringify(terminalSnapshot.sessionHistory)).not.toContain("pendingApproval");
    expect(JSON.stringify(terminalSnapshot.sessionHistory)).not.toContain(
      "Cancelled from Helarc desktop.",
    );
    await expect(access(markerPath)).rejects.toThrow();
  });

  it("routes the approval cancel option through Run cancellation", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "helarc-desktop-approval-cancel-"));
    const controller = new HelarcMainController({
      provider: new ScriptedProvider([{
        action: "request_permissions",
        rootId: "workspace",
        permissions: { fileSystem: { write: ["marker.txt"] } },
        reason: "Create a governed marker file.",
      }]),
    });
    controller.selectWorkspacePath(workspaceRoot);

    const waiting = waitForPendingApproval(controller);
    const cancelled = waitForActiveRunTerminal(controller, "cancelled");
    controller.startSession({ taskText: "Request then cancel" });
    const waitingSnapshot = await waiting;

    expect(controller.submitApprovalDecision(
      approvalSubmission(waitingSnapshot, "cancel", {
        submissionId: "desktop-approval-cancel-1",
      }),
    )).toMatchObject({
      status: "accepted_for_resolution",
      submissionId: "desktop-approval-cancel-1",
    });

    expect(await cancelled).toMatchObject({
      status: "cancelled",
      run: {
        display: { status: "cancelled" },
        platform: {
          status: "cancelled",
          approval: null,
          cancellation: {
            origin: "approval",
            reasonCode: "approval_cancelled",
          },
          terminal: { status: "cancelled" },
        },
      },
    });
  });

  it("keeps desktop runtime tool mode read-only by default", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "helarc-desktop-read-only-default-"));
    const markerPath = join(workspaceRoot, "marker.txt");
    const unsupportedShellCall = {
      action: "call_tool",
      reason: "Try a shell command.",
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
    };
    const controller = new HelarcMainController({
      provider: new ScriptedProvider([
        unsupportedShellCall,
        unsupportedShellCall,
      ]),
    });
    controller.selectWorkspacePath(workspaceRoot);

    const failed = waitForSnapshot(
      controller,
      (snapshot) => snapshot.status === "failed" && snapshot.sessionHistory.length === 1,
    );
    controller.startSession({ taskText: "Run command" });

    const snapshot = await failed;
    expect(snapshot).toMatchObject({
      status: "failed",
      run: {
        display: { status: "failed", statusSource: "platform" },
        platform: {
          status: "failed",
          approval: null,
          terminal: { status: "failed", code: "model_structured_output_retry_exhausted" },
        },
        product: {
          result: { output: { safeErrors: [{ code: "model_structured_output_retry_exhausted" }] } },
        },
      },
      sessionHistory: [{
        status: "failed",
        run: {
          runId: "helarc-run-1",
          status: "failed",
          terminal: {
            status: "failed",
            runtimeStatus: "failed",
            runtimeCode: "model_structured_output_retry_exhausted",
          },
        },
      }],
    });
    expect(JSON.stringify(snapshot.sessionHistory)).not.toContain("pendingApproval");
    await expect(access(markerPath)).rejects.toThrow();
  });

  it("rejects approval submissions and cancellation without a running session", () => {
    const controller = new HelarcMainController({ provider: new CompleteProvider() });

    expect(controller.submitApprovalDecision({
      submissionId: "desktop-unknown-1",
      runId: "run-unknown",
      requestId: "unknown",
      pendingVersion: 1,
      optionId: "accept",
      grantedPermissions: null,
      reason: null,
    })).toEqual({
      status: "rejected",
      submissionId: "desktop-unknown-1",
      code: "approval_not_pending",
    });

    expect(controller.cancelSession()).toMatchObject({
      ok: false,
      error: { code: "session_not_running" },
    });
  });

  it("correlates patch review decisions and applies accepted patches", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "helarc-desktop-patch-"));
    await mkdir(join(workspaceRoot, "src"));
    const targetPath = join(workspaceRoot, "src", "created.txt");
    const controller = new HelarcMainController({
      provider: new ScriptedProvider([
        {
          action: "propose",
          summary: "Create a file.",
          change: {
            operation: "create",
            path: "src/created.txt",
            content: "created\n",
          },
        },
      ]),
    });
    controller.selectWorkspacePath(workspaceRoot);

    const waiting = waitForPendingPatchReview(controller);
    const completed = waitForSnapshot(
      controller,
      (snapshot) =>
        snapshot.status === "completed"
        && snapshot.activeThread?.artifacts.length === 3,
    );
    const result = controller.startSession({ taskText: "Create file" });

    expect(result).toMatchObject({ ok: true, snapshot: { status: "starting" } });
    const waitingSnapshot = await waiting;
    expect(pendingPatchReview(waitingSnapshot)).toMatchObject({
      operation: "create",
      path: "src/created.txt",
      proposedContent: "created\n",
    });

    expect(controller.resolvePatchReview(patchSubmission(
      waitingSnapshot,
      "accepted",
      { proposalId: "stale-proposal", submissionId: "stale-submission" },
    ))).toMatchObject({
      ok: false,
      error: { code: "patch_review_not_pending" },
    });

    const acceptedSubmission = patchSubmission(waitingSnapshot, "accepted", {
      reason: "Apply it.",
    });
    const applying = waitForStatus(controller, "applying_patch");
    expect(controller.resolvePatchReview(acceptedSubmission)).toMatchObject({ ok: true });
    await applying;

    const completedSnapshot = await completed;
    expect(completedSnapshot).toMatchObject({
      status: "completed",
      run: {
        display: { status: "completed", terminal: true },
        product: {
          phase: { kind: "none" },
          result: {
            output: {
              patchStatus: "applied",
              appliedPath: "src/created.txt",
              safeErrors: [],
            },
          },
        },
      },
      activeThread: {
        artifacts: [
          {
            kind: "final-output",
            title: "Final output",
            summary: "Create a file.",
          },
          {
            kind: "patch-proposal",
            title: "Patch proposal: create src/created.txt",
            summary: "Accepted create patch for src/created.txt.",
          },
          {
            kind: "applied-patch",
            title: "Applied patch: src/created.txt",
            summary: "Applied create to src/created.txt.",
          },
        ],
      },
    });
    await expect(readFile(targetPath, "utf8")).resolves.toBe("created\n");
    expect(controller.resolvePatchReview({
      ...acceptedSubmission,
      submissionId: "late-patch-submission",
    })).toMatchObject({
      ok: false,
      error: { code: "patch_review_not_pending" },
    });
  });

  it("cancels a pending patch review and rejects its late decision", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "helarc-desktop-patch-cancel-"));
    await mkdir(join(workspaceRoot, "src"));
    const targetPath = join(workspaceRoot, "src", "cancelled.txt");
    const controller = new HelarcMainController({
      provider: new ScriptedProvider([{
        action: "propose",
        summary: "Create a file.",
        change: {
          operation: "create",
          path: "src/cancelled.txt",
          content: "must not be created\n",
        },
      }]),
    });
    controller.selectWorkspacePath(workspaceRoot);

    const waiting = waitForPendingPatchReview(controller);
    const cancelled = waitForProductResult(controller, "cancelled");
    controller.startSession({ taskText: "Create then cancel" });
    const waitingSnapshot = await waiting;
    const lateSubmission = patchSubmission(waitingSnapshot, "accepted", {
      submissionId: "late-after-patch-cancel",
    });

    expect(controller.cancelSession()).toMatchObject({
      ok: true,
      snapshot: {
        status: "cancelling",
        run: {
          display: { status: "cancelling" },
        },
      },
    });
    const cancelledSnapshot = await cancelled;
    expect(cancelledSnapshot).toMatchObject({
      status: "cancelled",
      run: {
        display: { status: "cancelled", terminal: true },
        product: {
          phase: { kind: "none" },
          result: { output: { runtimeStatus: "cancelled", patchStatus: null } },
        },
      },
    });
    expect(controller.resolvePatchReview(lateSubmission)).toMatchObject({
      ok: false,
      error: { code: "patch_review_not_pending" },
    });
    await expect(access(targetPath)).rejects.toThrow();
  });

  it("completes a desktop-host inspect-review-apply scenario", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "helarc-desktop-scenario-"));
    await mkdir(join(workspaceRoot, "src"));
    const targetPath = join(workspaceRoot, "src", "existing.txt");
    await writeFile(targetPath, "before\n");
    const provider = new ScriptedProvider([
      {
        action: "call_tool",
        reason: "Inspect the target file.",
        toolName: "codeAgent.readFile",
        input: { path: "src/existing.txt" },
      },
      {
        action: "propose",
        summary: "Update the target file.",
        change: {
          operation: "update",
          path: "src/existing.txt",
          content: "after\n",
        },
      },
    ]);
    const controller = new HelarcMainController({ provider });
    controller.selectWorkspacePath(workspaceRoot);

    const waitingForReview = waitForPendingPatchReview(controller);
    const completed = waitForProductResult(controller, "completed");
    const result = controller.startSession({ taskText: "Update existing file" });

    expect(result).toMatchObject({ ok: true, snapshot: { status: "starting" } });
    const reviewSnapshot = await waitingForReview;
    expect(reviewSnapshot.run?.product.activity.map((item) => item.kind)).toContain("tool.finished");
    expect(pendingPatchReview(reviewSnapshot)).toMatchObject({
      operation: "update",
      path: "src/existing.txt",
      originalContent: "before\n",
      proposedContent: "after\n",
    });

    controller.resolvePatchReview(patchSubmission(reviewSnapshot, "accepted", {
      reason: "Apply scenario change.",
    }));

    const completedSnapshot = await completed;
    expect(completedSnapshot).toMatchObject({
      status: "completed",
      run: {
        product: {
          result: {
            output: {
              agentSummary: "Update the target file.",
              patchStatus: "applied",
              appliedPath: "src/existing.txt",
              safeErrors: [],
            },
          },
        },
      },
    });
    await expect(readFile(targetPath, "utf8")).resolves.toBe("after\n");
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
  readonly descriptor = {
    id: "complete-provider",
    name: "Complete Provider",
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
    return {
      kind: "succeeded",
      response: {
        output: {
          action: "complete",
          summary: "No changes needed.",
        },
        usage: null,
        metadata: {},
      },
    };
  }
}

class ScriptedProvider implements Provider {
  readonly descriptor = {
    id: "scripted-provider",
    name: "Scripted Provider",
    capabilities: {
      supportsToolPlanning: true,
      supportsStructuredOutput: true,
      supportsStreaming: false,
    },
    requestRetryScheduler: { kind: "platform" as const },
    metadata: {},
  };

  constructor(private readonly outputs: unknown[]) {}

  async send(
    _request: ProviderRequest,
    _context: InvocationInterruptionContext,
  ): Promise<ProviderCallResult> {
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

function pendingApproval(snapshot: HelarcMainSnapshot) {
  const pending = snapshot.run?.platform.approval ?? null;
  if (pending === null || pending.review === null) {
    throw new Error("Expected a pending approval.");
  }
  return {
    ...pending.review,
    phase: pending.phase,
  };
}

function pendingPatchReview(snapshot: HelarcMainSnapshot) {
  const phase = snapshot.run?.product.phase ?? null;
  if (phase?.kind !== "waiting_for_patch_review") {
    throw new Error("Expected a pending patch review.");
  }
  return phase.review;
}

function approvalSubmission(
  snapshot: HelarcMainSnapshot,
  kind: ApprovalDecisionKind,
  overrides: Partial<ApprovalDecisionSubmission> = {},
): ApprovalDecisionSubmission {
  const pending = snapshot.run?.platform.approval ?? null;
  if (pending === null || pending.review === null) {
    throw new Error("Expected a pending approval.");
  }
  const option = pending.review.request.decisionOptions.find((candidate) => candidate.kind === kind);
  if (option === undefined) {
    throw new Error(`Expected approval option ${kind}.`);
  }
  const grantedPermissions = kind === "grantPermissions" &&
      pending.review.request.category === "permissions"
    ? pending.review.request.payload.permissions
    : null;
  return {
    submissionId: "desktop-submission-1",
    runId: pending.review.request.runId,
    requestId: pending.review.request.id,
    pendingVersion: pending.pendingVersion,
    optionId: option.id,
    grantedPermissions,
    reason: kind === "decline" ? "Declined in test." : null,
    ...overrides,
  };
}

function patchSubmission(
  snapshot: HelarcMainSnapshot,
  decision: "accepted" | "rejected",
  overrides: Partial<HelarcPatchReviewDecisionSubmission> = {},
): HelarcPatchReviewDecisionSubmission {
  const phase = snapshot.run?.product.phase ?? null;
  if (phase?.kind !== "waiting_for_patch_review") {
    throw new Error("Expected a pending patch review.");
  }
  const pending = phase.review;
  return {
    submissionId: "desktop-patch-submission-1",
    runId: pending.runId,
    proposalId: pending.proposalId,
    reviewId: pending.reviewId,
    pendingVersion: pending.pendingVersion,
    decision,
    reason: decision === "accepted" ? null : "Rejected in test.",
    ...overrides,
  };
}

function waitForPendingApproval(
  controller: HelarcMainController,
): Promise<HelarcMainSnapshot> {
  return waitForSnapshot(
    controller,
    (snapshot) => snapshot.run?.platform.approval?.review !== null &&
      snapshot.run?.platform.approval?.review !== undefined,
  );
}

function waitForPendingPatchReview(
  controller: HelarcMainController,
): Promise<HelarcMainSnapshot> {
  return waitForSnapshot(
    controller,
    (snapshot) => snapshot.run?.product.phase.kind === "waiting_for_patch_review",
  );
}

function waitForProductResult(
  controller: HelarcMainController,
  status: NonNullable<NonNullable<HelarcMainSnapshot["run"]>["product"]["result"]>["status"],
): Promise<HelarcMainSnapshot> {
  return waitForSnapshot(
    controller,
    (snapshot) => snapshot.run?.product.result?.status === status,
  );
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

function waitForSnapshot(
  controller: HelarcMainController,
  predicate: (snapshot: HelarcMainSnapshot) => boolean,
): Promise<HelarcMainSnapshot> {
  const snapshot = controller.getSnapshot();
  if (predicate(snapshot)) {
    return Promise.resolve(snapshot);
  }

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      unsubscribe();
      reject(new Error("Timed out waiting for matching Helarc snapshot."));
    }, 2_000);

    const unsubscribe = controller.subscribeSnapshot((nextSnapshot) => {
      if (predicate(nextSnapshot)) {
        clearTimeout(timeout);
        unsubscribe();
        resolve(nextSnapshot);
      }
    });
  });
}

async function threadFilePath(): Promise<string> {
  const rootPath = await mkdtemp(join(tmpdir(), "helarc-controller-thread-store-"));
  return join(rootPath, "threads", "threads.json");
}

function waitForActiveRunTerminal(
  controller: HelarcMainController,
  status: NonNullable<NonNullable<HelarcMainSnapshot["run"]>["platform"]["terminal"]>["status"],
): Promise<HelarcMainSnapshot> {
  const snapshot = controller.getSnapshot();
  if (snapshot.run?.platform.terminal?.status === status) {
    return Promise.resolve(snapshot);
  }

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      unsubscribe();
      reject(new Error(`Timed out waiting for active run terminal ${status}.`));
    }, 2_000);

    const unsubscribe = controller.subscribeSnapshot((nextSnapshot) => {
      if (nextSnapshot.run?.platform.terminal?.status === status) {
        clearTimeout(timeout);
        unsubscribe();
        resolve(nextSnapshot);
      }
    });
  });
}
