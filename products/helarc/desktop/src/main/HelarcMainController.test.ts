import type { HelarcPatchReviewDecisionSubmission } from "@agent-anything/helarc/composition";
import { HOST_COMMAND_VERSION } from "@agent-anything/host/transport";
import type {
  ApprovalDecisionKind,
  ApprovalDecisionSubmission,
} from "@agent-anything/permission";
import type {
  Provider,
  ProviderCallResult,
  ProviderRequest,
} from "@agent-anything/model-interaction";
import type { InvocationInterruptionContext } from "@agent-anything/agent-core/control";
import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { HelarcMainController, type HelarcMainSnapshot } from "./HelarcMainController.js";
import { FileHelarcThreadStore, InMemoryHelarcThreadStore } from "./thread/index.js";

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

  it("isolates snapshot listener failures", () => {
    const controller = new HelarcMainController({ provider: new CompleteProvider() });
    const delivered: HelarcMainSnapshot[] = [];
    controller.subscribeSnapshot(() => {
      throw new Error("Injected listener failure.");
    });
    controller.subscribeSnapshot((snapshot) => delivered.push(snapshot));

    expect(() => controller.selectWorkspacePath("D:/projects/agent-anything")).not.toThrow();
    expect(delivered).toHaveLength(1);
  });

  it("rejects renderer task text until main has a workspace", async () => {
    const controller = new HelarcMainController({ provider: new CompleteProvider() });

    const result = await controller.startRun({
      taskText: "Update docs",
      target: { kind: "new_thread" },
    });

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

    const result = await controller.startRun({
      taskText: "Update docs",
      target: { kind: "new_thread" },
    });

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

  it("runs a no-change read-only Run after native workspace selection", async () => {
    const controller = new HelarcMainController({ provider: new CompleteProvider() });
    controller.selectWorkspacePath("D:/projects/agent-anything");

    const completed = waitForProductResult(controller, "completed");
    const result = await controller.startRun({
      taskText: "  Update docs  ",
      target: { kind: "new_thread" },
    });

    expect(result).toMatchObject({
      ok: true,
      taskId: "helarc-task-1",
      snapshot: {
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
        display: { status: "completed", terminal: true, statusSource: "host" },
        host: { status: "completed", terminal: { status: "completed" } },
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
      host: { sequence: snapshot.run?.host.sequence },
      product: { sequence: snapshot.run?.product.sequence },
    });
  });

  it("persists completed Runs in Thread work context for history review", async () => {
    const storePath = await threadFilePath();
    const threadStore = new FileHelarcThreadStore(storePath);
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
      (snapshot) => snapshot.status === "completed" && snapshot.activeThread?.messages.length === 2,
    );
    void controller.startRun({
      taskText: "Update docs",
      target: { kind: "new_thread" },
    });

    const snapshot = await completed;
    expect(snapshot.threadSummaries).toMatchObject([{
      id: "helarc-thread-1",
      latestRun: { runId: "helarc-run-1", status: "completed" },
    }]);
    expect(snapshot.activeThread).toMatchObject({
      title: "Update docs",
      messages: [
        { role: "user", content: "Update docs" },
        { role: "assistant", content: "No changes needed." },
      ],
    });
    expect(JSON.stringify(snapshot.activeThread)).not.toContain("secret");
    expect(JSON.stringify(snapshot.activeThread)).not.toContain("rawProvider");
    expect(JSON.stringify(snapshot.activeThread)).not.toContain("pendingApproval");

    const restoredStore = new FileHelarcThreadStore(storePath);
    const restoredController = new HelarcMainController({
      providerConfigError: {
        code: "provider_config_missing",
        message: "Provider configuration is incomplete.",
        missingKeys: [],
      },
      threadSummaries: await restoredStore.listThreadSummaries(),
      threadStore: restoredStore,
    });
    await expect(restoredController.openThread("helarc-thread-1")).resolves.toMatchObject({
      ok: true,
      snapshot: {
        activeThread: { messages: [{ role: "user" }, { role: "assistant" }] },
      },
    });
  });

  it("does not let persistence failure replace the authoritative RunResult", async () => {
    const threadStore = new InMemoryHelarcThreadStore();
    vi.spyOn(threadStore, "commitRunTerminal").mockRejectedValue(
      new Error("sentinel-thread-store-secret"),
    );
    const controller = new HelarcMainController({
      provider: new CompleteProvider(),
      threadStore,
    });
    controller.selectWorkspacePath("D:/projects/agent-anything");

    const settled = waitForSnapshot(
      controller,
      (snapshot) =>
        snapshot.status === "completed"
        && snapshot.error?.code === "run_persistence_failed",
    );
    controller.startRun({
      taskText: "Update docs",
      target: { kind: "new_thread" },
    });

    const snapshot = await settled;
    expect(snapshot).toMatchObject({
      status: "completed",
      error: {
        code: "run_persistence_failed",
        message: "Helarc could not persist the terminal Run state.",
      },
      run: {
        display: { status: "completed" },
        product: { result: { output: { runtimeStatus: "succeeded" } } },
        host: {
          status: "completed",
          terminal: { status: "completed", code: null, cancellation: null },
        },
      },
    });
    expect(JSON.stringify(snapshot)).not.toContain("sentinel-thread-store-secret");
  });

  it("awaits every queued progress commit before the terminal aggregate commit", async () => {
    const threadStore = new InMemoryHelarcThreadStore();
    const order: string[] = [];
    const originalProgress = threadStore.commitRunProgress.bind(threadStore);
    const originalTerminal = threadStore.commitRunTerminal.bind(threadStore);
    let releaseFirstProgress!: () => void;
    let reportFirstProgress!: () => void;
    const firstProgressGate = new Promise<void>((resolve) => {
      releaseFirstProgress = resolve;
    });
    const firstProgressStarted = new Promise<void>((resolve) => {
      reportFirstProgress = resolve;
    });
    let shouldBlock = true;

    vi.spyOn(threadStore, "commitRunProgress").mockImplementation(async (commit) => {
      order.push(`progress:${commit.progressSequence}:started`);
      if (shouldBlock) {
        shouldBlock = false;
        reportFirstProgress();
        await firstProgressGate;
      }
      const result = await originalProgress(commit);
      order.push(`progress:${commit.progressSequence}:settled`);
      return result;
    });
    vi.spyOn(threadStore, "commitRunTerminal").mockImplementation(async (commit) => {
      order.push("terminal:started");
      const result = await originalTerminal(commit);
      order.push("terminal:settled");
      return result;
    });

    const controller = new HelarcMainController({
      provider: new CompleteProvider(),
      threadStore,
    });
    controller.selectWorkspacePath("D:/projects/agent-anything");
    const terminalPersisted = waitForSnapshot(
      controller,
      (snapshot) => snapshot.threadSummaries[0]?.latestRun?.status === "completed",
    );
    void controller.startRun({
      taskText: "Verify persistence ordering",
      target: { kind: "new_thread" },
    });

    await firstProgressStarted;
    await Promise.resolve();
    expect(order).not.toContain("terminal:started");

    releaseFirstProgress();
    await terminalPersisted;

    const terminalIndex = order.indexOf("terminal:started");
    const settledProgressIndexes = order
      .map((entry, index) => entry.startsWith("progress:") && entry.endsWith(":settled") ? index : -1)
      .filter((index) => index >= 0);
    expect(terminalIndex).toBeGreaterThan(-1);
    expect(settledProgressIndexes.length).toBeGreaterThan(0);
    expect(settledProgressIndexes.every((index) => index < terminalIndex)).toBe(true);
    expect(order.filter((entry) => entry === "terminal:started")).toHaveLength(1);
  });

  it("does not expose trusted failure text or trusted-only objects in Renderer snapshots", async () => {
    const secret = "sentinel-desktop-provider-secret";
    const controller = new HelarcMainController({
      provider: new SecretFailingProvider(secret),
    });
    controller.selectWorkspacePath("D:/projects/agent-anything");
    const failed = waitForSnapshot(
      controller,
      (snapshot) => snapshot.status === "failed" && snapshot.run?.product.result !== null,
    );
    void controller.startRun({
      taskText: "Fail without exposing trusted details",
      target: { kind: "new_thread" },
    });

    const snapshot = await failed;
    const serialized = JSON.stringify(snapshot);
    expect(snapshot.run?.product.result?.output.safeErrors[0]).toMatchObject({
      message: "The model request could not be completed.",
    });
    expect(serialized).not.toContain(secret);
    for (const trustedName of [
      "apiKey",
      "rawProvider",
      "runResult",
      "RunState",
      "cancellationController",
      "commitLedger",
      "providerInstance",
      "reviewerBridge",
      "sessionAuthorityStore",
      "policyAmendmentStore",
      "canonicalSubject",
      "preparedInvocation",
      "executor",
    ]) {
      expect(serialized).not.toContain(trustedName);
    }
  });

  it("persists work context thread, trigger message, and run records", async () => {
    const storePath = await threadFilePath();
    const threadStore = new FileHelarcThreadStore(storePath);
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
    controller.startRun({
      taskText: "Update docs",
      target: { kind: "new_thread" },
    });
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
        latestRunId: "helarc-run-1",
      },
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
            host: {
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

    const document = JSON.parse(await readFile(storePath, "utf8")) as {
      aggregates: Array<{ commitLedger: Array<{ kind: string }> }>;
    };
    const commitKinds = document.aggregates[0]?.commitLedger.map((entry) => entry.kind) ?? [];
    expect(commitKinds[0]).toBe("run_start");
    expect(commitKinds.at(-1)).toBe("run_terminal");
    expect(commitKinds.slice(1, -1).length).toBeGreaterThan(0);
    expect(commitKinds.slice(1, -1).every((kind) => kind === "run_progress")).toBe(true);
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
      (snapshot) => snapshot.status === "blocked"
        && snapshot.threadSummaries[0]?.latestRun?.status === "blocked",
    );
    const result = await controller.startRun({
      taskText: "Run command",
      target: { kind: "new_thread" },
    });

    expect(result).toMatchObject({ ok: true });
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
      display: { status: "waiting_for_approval", statusSource: "host" },
      host: {
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
      run: { host: { approval: { requestId: pending.request.id } } },
    });

    const decline = approvalSubmission(waitingSnapshot, "decline", {
      submissionId: "desktop-decline-1",
    });
    expect(dispatchApprovalCommand(controller, {
      ...decline,
      requestId: "stale-request",
    }, "host-stale-request")).toMatchObject({
      status: "handled",
      kind: "approval.submit",
      result: {
        status: "rejected",
        submissionId: "desktop-decline-1",
        code: "approval_not_pending",
      },
    });
    expect(dispatchApprovalCommand(controller, {
      ...decline,
      submissionId: "desktop-stale-version-1",
      pendingVersion: decline.pendingVersion + 1,
    })).toMatchObject({
      status: "handled",
      result: {
        status: "rejected",
        submissionId: "desktop-stale-version-1",
        code: "approval_version_mismatch",
      },
    });

    const receipt = dispatchApprovalCommand(controller, decline);
    expect(receipt).toMatchObject({
      status: "handled",
      kind: "approval.submit",
      result: {
        status: "accepted_for_resolution",
        submissionId: "desktop-decline-1",
        requestId: pending?.request.id,
        pendingVersion: pending?.pendingVersion,
      },
    });
    expect(dispatchApprovalCommand(controller, decline)).toBe(receipt);
    expect(dispatchApprovalCommand(controller, {
      ...decline,
      optionId: approvalSubmission(waitingSnapshot, "cancel").optionId,
    })).toMatchObject({
      status: "rejected",
      commandId: "host-approval-desktop-decline-1",
      code: "host_command_id_conflict",
    });
    expect(controller.getSnapshot()).toMatchObject({
      status: "waiting_for_approval",
      run: {
        display: { status: "waiting_for_approval" },
        host: { approval: { phase: "submitted_for_resolution" } },
      },
    });

    const blockedSnapshot = await blocked;
    expect(blockedSnapshot).toMatchObject({
      status: "blocked",
      run: {
        display: { status: "blocked", statusSource: "host" },
        host: { status: "blocked", terminal: { status: "blocked" } },
        product: { result: { output: { safeErrors: [] } } },
      },
      threadSummaries: [{ latestRun: { runId: "helarc-run-1", status: "blocked" } }],
      activeThread: { messages: [{ role: "user" }, { role: "assistant", content: "Run blocked." }] },
    });
    expect(JSON.stringify(blockedSnapshot.activeThread)).not.toContain("pendingApproval");
    expect(dispatchApprovalCommand(controller, {
      ...decline,
      submissionId: "desktop-late-1",
    })).toMatchObject({
      status: "rejected",
      code: "host_command_run_not_active",
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
    controller.startRun({
      taskText: "Run command",
      target: { kind: "new_thread" },
    });

    const waitingSnapshot = await waiting;
    const submitted = waitForSnapshot(
      controller,
      (snapshot) => snapshot.run?.host.approval?.phase === "submitted_for_resolution",
    );
    expect(dispatchApprovalCommand(
      controller,
      approvalSubmission(waitingSnapshot, "grantPermissions"),
    )).toMatchObject({
      status: "handled",
      result: {
        status: "accepted_for_resolution",
        requestId: pendingApproval(waitingSnapshot).request.id,
        pendingVersion: pendingApproval(waitingSnapshot).pendingVersion,
      },
    });
    expect(await submitted).toMatchObject({
      status: "waiting_for_approval",
      run: {
        display: { status: "waiting_for_approval" },
        host: { approval: { phase: "submitted_for_resolution" } },
      },
    });

    const completedSnapshot = await completed;
    expect(completedSnapshot).toMatchObject({
      status: "completed",
      run: {
        display: { status: "completed" },
        host: { status: "completed", terminal: { status: "completed" } },
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
    controller.startRun({
      taskText: "Run command",
      target: { kind: "new_thread" },
    });
    const waitingSnapshot = await waiting;
    const lateSubmission = approvalSubmission(waitingSnapshot, "grantPermissions", {
      submissionId: "desktop-after-cancel-1",
    });

    expect(dispatchCancellationCommand(
      controller,
      pendingApproval(waitingSnapshot).request.runId,
    )).toMatchObject({
      status: "handled",
      kind: "run.cancel",
      result: { status: "accepted" },
      projection: {
        status: "cancelling",
        approval: null,
        cancellation: {
          origin: "user",
          reasonCode: "user_requested",
        },
      },
    });
    expect(controller.getSnapshot()).toMatchObject({
      status: "cancelling",
      run: { display: { status: "cancelling" } },
    });
    await expect(controller.startRun({
      taskText: "Start another run",
      target: { kind: "new_thread" },
    })).resolves.toMatchObject({
      ok: false,
      error: { code: "run_already_active" },
      snapshot: { status: "cancelling" },
    });
    expect(dispatchApprovalCommand(controller, lateSubmission)).toMatchObject({
      status: "handled",
      result: {
        status: "rejected",
        submissionId: "desktop-after-cancel-1",
        code: "approval_not_pending",
      },
    });

    const terminalSnapshot = await waitForSnapshot(
      controller,
      (snapshot) =>
        snapshot.run?.host.terminal?.status === "cancelled"
        && snapshot.threadSummaries[0]?.latestRun?.status === "cancelled",
    );
    expect(terminalSnapshot).toMatchObject({
      status: "cancelled",
      run: {
        display: { status: "cancelled", statusSource: "host" },
        host: {
          status: "cancelled",
          terminal: { status: "cancelled", code: "runtime_cancelled" },
        },
      },
      threadSummaries: [{ latestRun: { runId: "helarc-run-1", status: "cancelled" } }],
      activeThread: { messages: [{ role: "user" }, { role: "assistant", content: "Run cancelled." }] },
    });
    expect(JSON.stringify(terminalSnapshot.run)).not.toContain(
      "Cancelled from Helarc desktop.",
    );
    expect(JSON.stringify(terminalSnapshot.activeThread)).not.toContain("pendingApproval");
    expect(JSON.stringify(terminalSnapshot.activeThread)).not.toContain(
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
    controller.startRun({
      taskText: "Request then cancel",
      target: { kind: "new_thread" },
    });
    const waitingSnapshot = await waiting;

    expect(dispatchApprovalCommand(
      controller,
      approvalSubmission(waitingSnapshot, "cancel", {
        submissionId: "desktop-approval-cancel-1",
      }),
    )).toMatchObject({
      status: "handled",
      result: {
        status: "accepted_for_resolution",
        submissionId: "desktop-approval-cancel-1",
      },
    });

    expect(await cancelled).toMatchObject({
      status: "cancelled",
      run: {
        display: { status: "cancelled" },
        host: {
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
      (snapshot) => snapshot.status === "failed"
        && snapshot.threadSummaries[0]?.latestRun?.status === "failed",
    );
    controller.startRun({
      taskText: "Run command",
      target: { kind: "new_thread" },
    });

    const snapshot = await failed;
    expect(snapshot).toMatchObject({
      status: "failed",
      run: {
        display: { status: "failed", statusSource: "host" },
        host: {
          status: "failed",
          approval: null,
          terminal: { status: "failed", code: "model_structured_output_retry_exhausted" },
        },
        product: {
          result: { output: { safeErrors: [{ code: "model_structured_output_retry_exhausted" }] } },
        },
      },
      threadSummaries: [{ latestRun: { runId: "helarc-run-1", status: "failed" } }],
    });
    expect(JSON.stringify(snapshot.activeThread)).not.toContain("pendingApproval");
    await expect(access(markerPath)).rejects.toThrow();
  });

  it("rejects approval submissions and cancellation without an active Run", () => {
    const controller = new HelarcMainController({ provider: new CompleteProvider() });

    expect(dispatchApprovalCommand(controller, {
      submissionId: "desktop-unknown-1",
      runId: "run-unknown",
      requestId: "unknown",
      pendingVersion: 1,
      optionId: "accept",
      grantedPermissions: null,
      reason: null,
    })).toMatchObject({
      status: "rejected",
      code: "host_command_run_not_active",
    });

    expect(dispatchCancellationCommand(controller, "run-unknown")).toMatchObject({
      status: "rejected",
      code: "host_command_run_not_active",
    });
  });

  it("rejects a stale cancellation without touching a newer active Run", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "helarc-desktop-stale-cancel-"));
    const controller = new HelarcMainController({
      runtimeToolMode: "shell-enabled",
      provider: new ScriptedProvider([
        {
          action: "complete",
          summary: "First Run completed.",
        },
        {
          action: "request_permissions",
          rootId: "workspace",
          permissions: { fileSystem: { write: ["marker.txt"] } },
          reason: "Keep the second Run active.",
        },
      ]),
    });
    controller.selectWorkspacePath(workspaceRoot);

    const firstCompleted = waitForSnapshot(
      controller,
      (snapshot) =>
        snapshot.run?.host.terminal?.status === "completed" &&
        snapshot.threadSummaries[0]?.latestRun?.status === "completed",
    );
    await controller.startRun({
      taskText: "Complete first",
      target: { kind: "new_thread" },
    });
    await firstCompleted;

    const secondWaiting = waitForPendingApproval(controller);
    await controller.startRun({
      taskText: "Wait second",
      target: { kind: "new_thread" },
    });
    const secondSnapshot = await secondWaiting;
    expect(secondSnapshot.run?.productRunId).toBe("helarc-run-2");
    const secondHarnessRunId = secondSnapshot.run?.harnessRunId;
    if (secondHarnessRunId === undefined) throw new Error("Expected active Harness Run id.");

    expect(dispatchCancellationCommand(
      controller,
      "harness-run-stale",
      "host-stale-cancel-run-1",
    )).toMatchObject({
      status: "rejected",
      runId: "harness-run-stale",
      code: "host_command_run_not_active",
    });
    expect(controller.getSnapshot()).toMatchObject({
      status: "waiting_for_approval",
      run: {
        productRunId: "helarc-run-2",
        harnessRunId: secondHarnessRunId,
        display: { status: "waiting_for_approval" },
      },
    });

    const secondCancelled = waitForActiveRunTerminal(controller, "cancelled");
    expect(dispatchCancellationCommand(
      controller,
      secondHarnessRunId,
      "host-cancel-run-2",
    )).toMatchObject({
      status: "handled",
      result: { status: "accepted" },
    });
    await secondCancelled;
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
    const result = await controller.startRun({
      taskText: "Create file",
      target: { kind: "new_thread" },
    });

    expect(result).toMatchObject({ ok: true });
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
    controller.startRun({
      taskText: "Create then cancel",
      target: { kind: "new_thread" },
    });
    const waitingSnapshot = await waiting;
    const lateSubmission = patchSubmission(waitingSnapshot, "accepted", {
      submissionId: "late-after-patch-cancel",
    });

    expect(dispatchCancellationCommand(
      controller,
      pendingPatchReview(waitingSnapshot).runId,
    )).toMatchObject({
      status: "handled",
      result: { status: "accepted" },
      projection: { status: "cancelling" },
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
    const storePath = await threadFilePath();
    const threadStore = new FileHelarcThreadStore(storePath);
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
    const controller = new HelarcMainController({ provider, threadStore });
    controller.selectWorkspacePath(workspaceRoot);

    const waitingForReview = waitForPendingPatchReview(controller);
    const completed = waitForProductResult(controller, "completed");
    const persisted = waitForSnapshot(
      controller,
      (snapshot) =>
        snapshot.status === "completed"
        && snapshot.threadSummaries[0]?.latestRun?.status === "completed",
      15_000,
    );
    const result = await controller.startRun({
      taskText: "Update existing file",
      target: { kind: "new_thread" },
    });

    expect(result).toMatchObject({ ok: true });
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
    await persisted;

    await expect(threadStore.loadThread("helarc-thread-1")).resolves.toMatchObject({
      messages: [
        {
          role: "user",
          content: "Update existing file",
          relatedRunIds: ["helarc-run-1"],
        },
        {
          role: "assistant",
          content: "Update the target file.",
          relatedRunIds: ["helarc-run-1"],
          relatedArtifactIds: expect.arrayContaining([
            "helarc-run-1-artifact-final-output",
            "helarc-run-1-artifact-patch-proposal",
            "helarc-run-1-artifact-applied-patch",
          ]),
        },
      ],
      runs: [{
        id: "helarc-run-1",
        terminal: {
          host: { status: "completed" },
          product: {
            status: "completed",
            output: {
              runtimeStatus: "succeeded",
              patchStatus: "applied",
              appliedPath: "src/existing.txt",
            },
          },
        },
        artifactIds: expect.arrayContaining([
          "helarc-run-1-artifact-final-output",
          "helarc-run-1-artifact-patch-proposal",
          "helarc-run-1-artifact-applied-patch",
        ]),
      }],
      artifacts: expect.arrayContaining([
        expect.objectContaining({ kind: "final-output", runId: "helarc-run-1" }),
        expect.objectContaining({ kind: "patch-proposal", runId: "helarc-run-1" }),
        expect.objectContaining({ kind: "applied-patch", runId: "helarc-run-1" }),
      ]),
    });

    const document = JSON.parse(await readFile(storePath, "utf8")) as {
      aggregates: Array<{ commitLedger: Array<{ kind: string }> }>;
    };
    const commitKinds = document.aggregates[0]?.commitLedger.map(({ kind }) => kind) ?? [];
    expect(commitKinds[0]).toBe("run_start");
    expect(commitKinds.at(-1)).toBe("run_terminal");
    expect(commitKinds.filter((kind) => kind === "run_terminal")).toHaveLength(1);
  }, 20_000);

  it("reserves the active slot before asynchronous preparation", async () => {
    const controller = new HelarcMainController({ provider: new CompleteProvider() });
    controller.selectWorkspacePath("D:/projects/agent-anything");

    const firstStart = controller.startRun({
      taskText: "First task",
      target: { kind: "new_thread" },
    });
    const secondStart = await controller.startRun({
      taskText: "Second task",
      target: { kind: "new_thread" },
    });

    expect(secondStart).toMatchObject({
      ok: false,
      error: { code: "run_already_active" },
    });
    await expect(firstStart).resolves.toMatchObject({ ok: true, taskId: "helarc-task-1" });
    await waitForActiveRunTerminal(controller, "completed");
    expect(controller.getSnapshot().threadSummaries).toHaveLength(1);
  });

  it("does not invoke the Provider when the atomic start commit fails", async () => {
    const provider = new CountingCompleteProvider();
    const threadStore = new FileHelarcThreadStore(await threadFilePath(), {
      operations: {
        async replace() {
          throw new Error("Injected start replacement failure.");
        },
      },
    });
    const controller = new HelarcMainController({ provider, threadStore });
    controller.selectWorkspacePath("D:/projects/agent-anything");

    const result = await controller.startRun({
      taskText: "Must not execute",
      target: { kind: "new_thread" },
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: "run_persistence_failed" },
    });
    expect(provider.callCount).toBe(0);
    expect(controller.getSnapshot().run).toBeNull();
  });

  it("opens a persisted Thread through the safe Store query", async () => {
    const storePath = await threadFilePath();
    const threadStore = new FileHelarcThreadStore(storePath);
    const first = new HelarcMainController({ provider: new CompleteProvider(), threadStore });
    first.selectWorkspacePath("D:/projects/agent-anything");
    const completed = waitForSnapshot(
      first,
      (snapshot) => snapshot.threadSummaries[0]?.latestRun?.status === "completed",
    );
    await first.startRun({
      taskText: "Persisted task",
      target: { kind: "new_thread" },
    });
    await completed;

    const restoredStore = new FileHelarcThreadStore(storePath);
    const restored = new HelarcMainController({
      provider: new CompleteProvider(),
      threadStore: restoredStore,
      threadSummaries: await restoredStore.listThreadSummaries(),
    });
    const opened = await restored.openThread("helarc-thread-1");

    expect(opened).toMatchObject({
      ok: true,
      snapshot: {
        activeThread: {
          id: "helarc-thread-1",
          messages: [
            { role: "user", content: "Persisted task" },
            { role: "assistant", content: "No changes needed." },
          ],
        },
      },
    });

    const secondCompleted = waitForSnapshot(
      restored,
      (snapshot) => snapshot.threadSummaries.some(
        (thread) => thread.id === "helarc-thread-2" && thread.latestRun?.status === "completed",
      ),
    );
    await expect(restored.startRun({
      taskText: "Second persisted task",
      target: { kind: "new_thread" },
    })).resolves
      .toMatchObject({ ok: true, taskId: "helarc-task-2" });
    await secondCompleted;
  });

  it("opens a stored non-terminal Run as inactive work without recovering execution", async () => {
    const provider = new DeferredCompleteProvider();
    const threadStore = new InMemoryHelarcThreadStore();
    const activeController = new HelarcMainController({ provider, threadStore });
    activeController.selectWorkspacePath("D:/projects/agent-anything");
    const started = await activeController.startRun({
      taskText: "Wait for external completion",
      target: { kind: "new_thread" },
    });
    if (!started.ok) {
      throw new Error("Expected the active Run to start.");
    }
    await vi.waitFor(() => {
      expect(provider.callCount).toBe(1);
    });

    const observer = new HelarcMainController({
      provider: new CompleteProvider(),
      threadStore,
      threadSummaries: await threadStore.listThreadSummaries(),
    });
    const opened = await observer.openThread(started.threadId);

    expect(opened).toMatchObject({
      ok: true,
      snapshot: {
        status: "workspace_selected",
        acceptedTask: null,
        run: null,
        activeThread: { id: started.threadId },
        threadSummaries: [{
          id: started.threadId,
          latestRun: {
            runId: started.productRunId,
            status: "inactive",
          },
        }],
      },
    });
    expect(provider.callCount).toBe(1);

    provider.complete();
    await waitForSnapshot(
      activeController,
      (snapshot) =>
        snapshot.threadSummaries[0]?.latestRun?.runId === started.productRunId &&
        snapshot.threadSummaries[0]?.latestRun?.status === "completed",
    );
  });

  it("continues the exact selected Thread with prior Message context", async () => {
    const provider = new RecordingCompleteProvider();
    const threadStore = new InMemoryHelarcThreadStore();
    const controller = new HelarcMainController({ provider, threadStore });
    controller.selectWorkspacePath("D:/projects/agent-anything");

    const first = await controller.startRun({
      taskText: "Inspect the current implementation",
      target: { kind: "new_thread" },
    });
    expect(first).toMatchObject({
      ok: true,
      taskId: "helarc-task-1",
      productRunId: "helarc-run-1",
      threadId: "helarc-thread-1",
    });
    if (!first.ok) {
      throw new Error("Expected the first Run to start.");
    }
    await waitForSnapshot(
      controller,
      (snapshot) =>
        snapshot.threadSummaries[0]?.latestRun?.runId === first.productRunId &&
        snapshot.threadSummaries[0]?.latestRun?.status === "completed",
    );
    await expect(controller.openThread(first.threadId)).resolves.toMatchObject({
      ok: true,
      snapshot: {
        status: "workspace_selected",
        acceptedTask: null,
        run: null,
      },
    });

    const second = await controller.startRun({
      taskText: "Summarize the next step",
      target: {
        kind: "continue_thread",
        threadId: first.threadId,
      },
    });
    expect(second).toMatchObject({
      ok: true,
      taskId: "helarc-task-2",
      productRunId: "helarc-run-2",
      threadId: "helarc-thread-1",
    });
    if (!second.ok) {
      throw new Error("Expected the continued Run to start.");
    }
    await waitForSnapshot(
      controller,
      (snapshot) =>
        snapshot.threadSummaries[0]?.latestRun?.runId === second.productRunId &&
        snapshot.threadSummaries[0]?.latestRun?.status === "completed",
    );

    const record = await threadStore.loadThread(first.threadId);
    expect(record).toMatchObject({
      thread: {
        id: "helarc-thread-1",
        latestRunId: "helarc-run-2",
      },
      runs: [
        { id: "helarc-run-1", threadId: "helarc-thread-1" },
        { id: "helarc-run-2", threadId: "helarc-thread-1" },
      ],
      messages: [
        {
          id: "helarc-message-1",
          role: "user",
          content: "Inspect the current implementation",
        },
        {
          id: "helarc-message-1-assistant",
          role: "assistant",
          content: "No changes needed.",
        },
        {
          id: "helarc-message-2",
          role: "user",
          content: "Summarize the next step",
        },
        {
          id: "helarc-message-2-assistant",
          role: "assistant",
          content: "No changes needed.",
        },
      ],
    });
    expect(controller.getSnapshot().threadSummaries).toHaveLength(1);

    expect(provider.requests).toHaveLength(2);
    const continuedPrompt = provider.requests[1]?.messages.find(
      (message) => message.role === "user",
    )?.content ?? "";
    expect(continuedPrompt).toContain("Inspect the current implementation");
    expect(continuedPrompt).toContain("No changes needed.");
    expect(continuedPrompt.match(/Summarize the next step/g)).toHaveLength(1);
  });

  it("rejects stale Thread continuation before persistence or execution", async () => {
    const provider = new RecordingCompleteProvider();
    const threadStore = new InMemoryHelarcThreadStore();
    const controller = new HelarcMainController({ provider, threadStore });
    controller.selectWorkspacePath("D:/projects/agent-anything");
    const first = await controller.startRun({
      taskText: "Inspect files",
      target: { kind: "new_thread" },
    });
    if (!first.ok) {
      throw new Error("Expected the first Run to start.");
    }
    await waitForSnapshot(
      controller,
      (snapshot) =>
        snapshot.threadSummaries[0]?.latestRun?.runId === first.productRunId &&
        snapshot.threadSummaries[0]?.latestRun?.status === "completed",
    );

    const stale = await controller.startRun({
      taskText: "Continue stale work",
      target: {
        kind: "continue_thread",
        threadId: "helarc-thread-stale",
      },
    });

    expect(stale).toMatchObject({
      ok: false,
      error: { code: "thread_selection_mismatch" },
    });
    expect(provider.requests).toHaveLength(1);
    await expect(threadStore.loadThread(first.threadId)).resolves.toMatchObject({
      runs: [{ id: first.productRunId }],
    });
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
    requestRetryScheduler: { kind: "harness" as const },
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

class CountingCompleteProvider extends CompleteProvider {
  callCount = 0;

  override async send(
    request: ProviderRequest,
    context: InvocationInterruptionContext,
  ): Promise<ProviderCallResult> {
    this.callCount += 1;
    return super.send(request, context);
  }
}

class RecordingCompleteProvider extends CompleteProvider {
  readonly requests: ProviderRequest[] = [];

  override async send(
    request: ProviderRequest,
    context: InvocationInterruptionContext,
  ): Promise<ProviderCallResult> {
    this.requests.push(request);
    return super.send(request, context);
  }
}

class DeferredCompleteProvider extends CompleteProvider {
  callCount = 0;
  private readonly result: Promise<ProviderCallResult>;
  private settle!: (result: ProviderCallResult) => void;

  constructor() {
    super();
    this.result = new Promise((resolve) => {
      this.settle = resolve;
    });
  }

  override async send(
    _request: ProviderRequest,
    _context: InvocationInterruptionContext,
  ): Promise<ProviderCallResult> {
    this.callCount += 1;
    return this.result;
  }

  complete(): void {
    this.settle({
      kind: "succeeded",
      response: {
        output: {
          action: "complete",
          summary: "No changes needed.",
        },
        usage: null,
        metadata: {},
      },
    });
  }
}

class SecretFailingProvider implements Provider {
  readonly descriptor = {
    id: "secret-failing-provider",
    name: "Secret failing Provider",
    capabilities: {
      supportsToolPlanning: true,
      supportsStructuredOutput: true,
      supportsStreaming: false,
    },
    requestRetryScheduler: { kind: "harness" as const },
    metadata: {},
  };

  constructor(private readonly secret: string) {}

  async send(
    _request: ProviderRequest,
    _context: InvocationInterruptionContext,
  ): Promise<ProviderCallResult> {
    return {
      kind: "failed",
      failure: {
        category: "provider",
        code: "provider_secret_failure",
        message: `Provider failed with ${this.secret}.`,
        metadata: { apiKey: this.secret, rawProvider: this.secret },
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
    requestRetryScheduler: { kind: "harness" as const },
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
  const pending = snapshot.run?.host.approval ?? null;
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
  const pending = snapshot.run?.host.approval ?? null;
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

function dispatchApprovalCommand(
  controller: HelarcMainController,
  submission: ApprovalDecisionSubmission,
  commandId = `host-approval-${submission.submissionId}`,
) {
  const { runId, ...payload } = submission;
  return controller.dispatchHostCommand({
    version: HOST_COMMAND_VERSION,
    commandId,
    runId,
    kind: "approval.submit",
    payload,
  }, "approval.submit");
}

function dispatchCancellationCommand(
  controller: HelarcMainController,
  runId: string,
  commandId = `host-cancel-${runId}`,
) {
  return controller.dispatchHostCommand({
    version: HOST_COMMAND_VERSION,
    commandId,
    runId,
    kind: "run.cancel",
    payload: {
      reason: "Cancelled from Helarc desktop test.",
    },
  }, "run.cancel");
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
    (snapshot) => snapshot.run?.host.approval?.review !== null &&
      snapshot.run?.host.approval?.review !== undefined,
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
  timeoutMs = 2_000,
): Promise<HelarcMainSnapshot> {
  const snapshot = controller.getSnapshot();
  if (predicate(snapshot)) {
    return Promise.resolve(snapshot);
  }

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      unsubscribe();
      reject(new Error("Timed out waiting for matching Helarc snapshot."));
    }, timeoutMs);

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
  status: NonNullable<NonNullable<HelarcMainSnapshot["run"]>["host"]["terminal"]>["status"],
): Promise<HelarcMainSnapshot> {
  const snapshot = controller.getSnapshot();
  if (snapshot.run?.host.terminal?.status === status) {
    return Promise.resolve(snapshot);
  }

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      unsubscribe();
      reject(new Error(`Timed out waiting for active run terminal ${status}.`));
    }, 2_000);

    const unsubscribe = controller.subscribeSnapshot((nextSnapshot) => {
      if (nextSnapshot.run?.host.terminal?.status === status) {
        clearTimeout(timeout);
        unsubscribe();
        resolve(nextSnapshot);
      }
    });
  });
}
