import { HOST_COMMAND_VERSION } from "@agent-anything/host/transport";
import type {
  ApprovalDecisionKind,
  ApprovalDecisionSubmission,
} from "@agent-anything/permission";
import type {
  ModelJsonValue,
  Provider,
  ProviderCallResult,
  ProviderRequest,
} from "@agent-anything/model-interaction";
import {
  createModelCallRef,
  createModelTurnId,
  snapshotModelJsonValue,
  snapshotModelToolCall,
  snapshotProviderResponse,
} from "@agent-anything/model-interaction";
import type { InvocationInterruptionContext } from "@agent-anything/agent-core/control";
import { createUtf8ModelInputAccounting } from "@agent-anything/model-interaction/input";
import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { HelarcMainController, type HelarcMainSnapshot } from "./HelarcMainController.js";
import { FileHelarcThreadStore, InMemoryHelarcThreadStore } from "./thread/index.js";

type InteractionRequestRef = NonNullable<HelarcMainSnapshot["run"]>["host"]["pendingInteractions"][number]["request"];

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
      nativeToolInteraction: { supported: true },
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
    const originalProgress = threadStore.commitRunProjection.bind(threadStore);
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

    vi.spyOn(threadStore, "commitRunProjection").mockImplementation(async (commit) => {
      order.push(`projection:${commit.projectionSequence}:started`);
      if (shouldBlock) {
        shouldBlock = false;
        reportFirstProgress();
        await firstProgressGate;
      }
      const result = await originalProgress(commit);
      order.push(`projection:${commit.projectionSequence}:settled`);
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
      .map((entry, index) => entry.startsWith("projection:") && entry.endsWith(":settled") ? index : -1)
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
    expect(snapshot.run?.product.result?.runResult).toMatchObject({
      status: "failed",
      code: "controller_failed",
    });
    expect(snapshot.run?.product.result).not.toHaveProperty("items");
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
    expect(commitKinds.slice(1, -1).every((kind) => kind === "run_projection")).toBe(true);
  });

  it("correlates versioned approval submissions and preserves a decline", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "helarc-desktop-permission-"));
    const markerPath = join(workspaceRoot, "marker.txt");
    const controller = new HelarcMainController({
      provider: new ScriptedProvider([
        commandToolCall(markerPath),
        {
          kind: "stop",
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
        category: "commandExecution",
        reason: "Create a governed marker file.",
      },
    });
    expect(waitingSnapshot.run).toMatchObject({
      display: { status: "waiting_for_approval", statusSource: "host" },
      host: {
        status: "waiting",
        pendingInteractions: [{
          request: {
            id: pending.request.id,
            requestVersion: pending.pendingVersion,
          },
          phase: "pending",
        }],
      },
    });
    expect(controller.getSnapshot()).toMatchObject({
      status: "waiting_for_approval",
      run: { host: { pendingInteractions: [{ request: { id: pending.request.id } }] } },
    });

    const decline = approvalSubmission(waitingSnapshot, "decline", {
      submissionId: "desktop-decline-1",
    });
    expect(dispatchApprovalCommand(controller, {
      ...decline,
      interactionRequest: {
        ...decline.interactionRequest,
        id: "stale-request",
      },
    }, "host-stale-request")).toMatchObject({
      status: "handled",
      kind: "interaction.submit",
      result: {
        status: "rejected",
        code: "interaction_not_pending",
      },
    });
    expect(dispatchApprovalCommand(controller, {
      ...decline,
      submissionId: "desktop-stale-version-1",
      interactionRequest: {
        ...decline.interactionRequest,
        requestVersion: decline.interactionRequest.requestVersion + 1,
      },
    })).toMatchObject({
      status: "handled",
      result: {
        status: "rejected",
        code: "interaction_version_stale",
      },
    });

    const receipt = dispatchApprovalCommand(controller, decline);
    expect(receipt).toMatchObject({
      status: "handled",
      kind: "interaction.submit",
      result: {
        status: "accepted_for_resolution",
        receipt: {
          submissionId: "desktop-decline-1",
          request: {
            id: pending.request.id,
            requestVersion: pending.pendingVersion,
          },
        },
      },
    });
    expect(dispatchApprovalCommand(controller, decline)).toBe(receipt);
    expect(dispatchApprovalCommand(controller, {
      ...decline,
      optionId: approvalSubmission(waitingSnapshot, "accept").optionId,
    })).toMatchObject({
      status: "rejected",
      commandId: "host-approval-desktop-decline-1",
      code: "host_command_id_conflict",
    });
    expect(controller.getSnapshot()).toMatchObject({
      status: "waiting_for_approval",
      run: {
        display: { status: "waiting_for_approval" },
        host: { pendingInteractions: [{ phase: "submitted_for_resolution" }] },
      },
    });

    const blockedSnapshot = await blocked;
    expect(blockedSnapshot).toMatchObject({
      status: "blocked",
      run: {
        display: { status: "blocked", statusSource: "host" },
        host: { status: "blocked", terminal: { status: "blocked" } },
        product: {
          result: {
            output: {
              safeErrors: [{
                code: "approval_declined",
                message: "Approval could not be completed.",
              }],
            },
          },
        },
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
      provider: new ScriptedProvider([
        commandToolCall(markerPath),
        {
          kind: "completion",
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
      (snapshot) => snapshot.run?.host.pendingInteractions.some(
        (candidate) => candidate.phase === "submitted_for_resolution",
      ) === true,
    );
    expect(dispatchApprovalCommand(
      controller,
      approvalSubmission(waitingSnapshot, "accept"),
    )).toMatchObject({
      status: "handled",
      result: {
        status: "accepted_for_resolution",
        receipt: {
          request: {
            id: pendingApproval(waitingSnapshot).request.id,
            requestVersion: pendingApproval(waitingSnapshot).pendingVersion,
          },
        },
      },
    });
    expect(await submitted).toMatchObject({
      status: "waiting_for_approval",
      run: {
        display: { status: "waiting_for_approval" },
        host: { pendingInteractions: [{ phase: "submitted_for_resolution" }] },
      },
    });

    const completedSnapshot = await completed;
    expect(completedSnapshot).toMatchObject({
      status: "completed",
      run: {
        display: { status: "completed" },
        host: { status: "completed", terminal: { status: "completed" } },
        product: {
          result: {
            output: {
              agentSummary: "Permission was granted for this run.",
              safeErrors: [],
            },
          },
        },
      },
    });
    await expect(access(markerPath)).resolves.toBeUndefined();
  });

  it("cancels while an explicit approval request is pending", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "helarc-desktop-permission-cancel-"));
    const markerPath = join(workspaceRoot, "marker.txt");
    const controller = new HelarcMainController({
      provider: new ScriptedProvider([
        commandToolCall(markerPath),
      ]),
    });
    controller.selectWorkspacePath(workspaceRoot);

    const waiting = waitForPendingApproval(controller);
    controller.startRun({
      taskText: "Run command",
      target: { kind: "new_thread" },
    });
    const waitingSnapshot = await waiting;
    const lateSubmission = approvalSubmission(waitingSnapshot, "accept", {
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
        code: "interaction_not_pending",
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

  it("keeps owner-defined approval options separate from Run cancellation", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "helarc-desktop-approval-cancel-"));
    const markerPath = join(workspaceRoot, "marker.txt");
    const controller = new HelarcMainController({
      provider: new ScriptedProvider([commandToolCall(markerPath)]),
    });
    controller.selectWorkspacePath(workspaceRoot);

    const waiting = waitForPendingApproval(controller);
    const cancelled = waitForActiveRunTerminal(controller, "cancelled");
    controller.startRun({
      taskText: "Request then cancel",
      target: { kind: "new_thread" },
    });
    const waitingSnapshot = await waiting;
    expect(pendingApproval(waitingSnapshot).request.decisionOptions.map(({ kind }) => kind)).toEqual([
      "accept",
      "decline",
    ]);

    expect(dispatchCancellationCommand(
      controller,
      pendingApproval(waitingSnapshot).request.runId,
      "desktop-approval-cancel-1",
    )).toMatchObject({
      status: "handled",
      result: {
        status: "accepted",
      },
    });

    expect(await cancelled).toMatchObject({
      status: "cancelled",
      run: {
        display: { status: "cancelled" },
        host: {
          status: "cancelled",
          pendingInteractions: [],
          cancellation: {
            origin: "user",
            reasonCode: "user_requested",
          },
          terminal: { status: "cancelled" },
        },
      },
    });
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
      interactionRequest: {
        id: "unknown",
        protocol: { owner: "permission", kind: "approval", revision: "1" },
        requestVersion: 1,
        subject: {
          owner: "permission",
          kind: "approval",
          id: "action-unknown",
          revision: "fingerprint-unknown",
        },
      },
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
    const markerPath = join(workspaceRoot, "marker.txt");
    const controller = new HelarcMainController({
      provider: new ScriptedProvider([
        {
          kind: "completion",
          summary: "First Run completed.",
        },
        commandToolCall(markerPath, "Keep the second Run active."),
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
  }, 10_000);

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
    const continuedPrompt = provider.requests[1]?.messages
      .filter((message) => message.role === "user")
      .map(modelMessageText)
      .join("\n") ?? "";
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
  readonly inputAccounting = createDesktopTestInputAccounting("complete-provider");
  readonly descriptor = {
    id: "complete-provider",
    name: "Complete Provider",
    capabilities: {
      nativeToolInteraction: desktopNativeToolInteractionCapability(),
      structuredGeneration: { supported: false as const },
      streaming: { supported: false as const },
      modelInput: this.inputAccounting.capability,
      continuation: { supported: false as const },
      compaction: { supported: false as const },
    },
    requestRetryScheduler: { kind: "harness" as const },
    metadata: {},
  };

  async send(
    request: ProviderRequest,
    _context: InvocationInterruptionContext,
  ): Promise<ProviderCallResult> {
    return createDesktopNativeResult(
      request,
      { kind: "completion", summary: "No changes needed." },
      this.descriptor.id,
      1,
    );
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
  private request: ProviderRequest | null = null;

  constructor() {
    super();
    this.result = new Promise((resolve) => {
      this.settle = resolve;
    });
  }

  override async send(
    request: ProviderRequest,
    _context: InvocationInterruptionContext,
  ): Promise<ProviderCallResult> {
    this.callCount += 1;
    this.request = request;
    return this.result;
  }

  complete(): void {
    if (this.request === null) {
      throw new Error("Deferred Provider cannot complete before receiving a request.");
    }
    this.settle(createDesktopNativeResult(
      this.request,
      { kind: "completion", summary: "No changes needed." },
      this.descriptor.id,
      this.callCount,
    ));
  }
}

class SecretFailingProvider implements Provider {
  readonly inputAccounting = createDesktopTestInputAccounting("secret-failing-provider");
  readonly descriptor = {
    id: "secret-failing-provider",
    name: "Secret failing Provider",
    capabilities: {
      nativeToolInteraction: desktopNativeToolInteractionCapability(),
      structuredGeneration: { supported: false as const },
      streaming: { supported: false as const },
      modelInput: this.inputAccounting.capability,
      continuation: { supported: false as const },
      compaction: { supported: false as const },
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
  readonly inputAccounting = createDesktopTestInputAccounting("scripted-provider");
  readonly descriptor = {
    id: "scripted-provider",
    name: "Scripted Provider",
    capabilities: {
      nativeToolInteraction: desktopNativeToolInteractionCapability(),
      structuredGeneration: { supported: false as const },
      streaming: { supported: false as const },
      modelInput: this.inputAccounting.capability,
      continuation: { supported: false as const },
      compaction: { supported: false as const },
    },
    requestRetryScheduler: { kind: "harness" as const },
    metadata: {},
  };
  private responseSequence = 0;

  constructor(private readonly outputs: unknown[]) {}

  async send(
    request: ProviderRequest,
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

    this.responseSequence += 1;
    return createDesktopNativeResult(
      request,
      output,
      this.descriptor.id,
      this.responseSequence,
    );
  }
}

function desktopNativeToolInteractionCapability() {
  return Object.freeze({
    supported: true as const,
    callableDefinitions: true as const,
    modelCalls: true as const,
    resultMessages: true as const,
    multipleCalls: true,
    callCorrelation: "provider_supplied" as const,
  });
}

function createDesktopNativeResult(
  request: ProviderRequest,
  output: unknown,
  providerId: string,
  sequence: number,
): ProviderCallResult {
  if (request.interaction.kind !== "native_tool_turn") {
    return desktopProviderFailure("desktop_native_request_kind_invalid", "invalid_request");
  }
  if (!isDesktopRecord(output) || typeof output.kind !== "string") {
    return desktopProviderFailure("provider_response_malformed", "response");
  }
  const responseId = `${providerId}:response:${sequence}`;
  const turnId = createModelTurnId({ providerId, requestId: request.requestId, responseId });
  const content = output.kind === "completion"
    ? [Object.freeze({
        kind: "text" as const,
        text: typeof output.summary === "string" ? output.summary : "",
      })]
    : [Object.freeze({
        kind: "model_tool_call" as const,
        call: snapshotModelToolCall({
          modelCallRef: createModelCallRef({
            providerRequestId: request.requestId,
            controllerRequestId: request.correlation.controllerRequestId,
            turnId,
            contentBlockOrdinal: 0,
            branchId: request.correlation.branchId,
          }),
          providerCallRef: { providerId, id: `${responseId}:call:0` },
          name: desktopCallableName(request, output),
          input: desktopCallableInput(output),
          ordinal: 0,
        }),
      })];
  return Object.freeze({
    kind: "succeeded" as const,
    response: snapshotProviderResponse({
      kind: "native_tool_turn",
      turn: {
        turnId,
        assistant: { role: "assistant", content },
        finish: { kind: "normal" },
        usage: null,
        responseRef: { providerId, requestId: request.requestId, responseId },
      },
      continuation: null,
      metadata: {},
    }),
  });
}

function desktopCallableName(
  request: ProviderRequest,
  output: Readonly<Record<string, unknown>>,
): string {
  if (output.kind === "plan_update") return "update_plan";
  if (output.kind === "stop") return "stop";
  if (output.kind !== "tool_call" || typeof output.toolName !== "string") {
    return "unknown_scripted_callable";
  }
  const stem = output.toolName.replace(/[^A-Za-z0-9_-]/gu, "_").replace(/_+/gu, "_")
    .replace(/^_+|_+$/gu, "").slice(0, 42) || "tool";
  if (request.interaction.kind !== "native_tool_turn") {
    return `unknown_${stem}`;
  }
  return request.interaction.callables.find(({ name }) => name.startsWith(`${stem}_`))?.name ??
    `unknown_${stem}`;
}

function desktopCallableInput(
  output: Readonly<Record<string, unknown>>,
): { readonly [key: string]: ModelJsonValue } {
  if (output.kind === "plan_update") {
    return snapshotDesktopObject({
      ...(typeof output.explanation === "string" ? { explanation: output.explanation } : {}),
      plan: output.plan,
    });
  }
  if (output.kind === "stop") {
    return Object.freeze({ reason: String(output.reason) });
  }
  return snapshotDesktopObject(output.input);
}

function snapshotDesktopObject(value: unknown): { readonly [key: string]: ModelJsonValue } {
  const snapshot = snapshotModelJsonValue(value, "HelarcMainController.test.value");
  if (snapshot === null || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    throw new TypeError("Desktop native Provider output must contain a JSON object.");
  }
  return snapshot as { readonly [key: string]: ModelJsonValue };
}

function desktopProviderFailure(code: string, category: string): ProviderCallResult {
  return Object.freeze({
    kind: "failed" as const,
    failure: Object.freeze({
      category,
      code,
      message: "Desktop native Provider could not produce a Model Turn.",
      metadata: Object.freeze({}),
    }),
  });
}

function isDesktopRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function createDesktopTestInputAccounting(providerId: string) {
  return createUtf8ModelInputAccounting({
    providerId,
    model: "desktop-test-model",
    maximumInputBytes: 4 * 1_024 * 1_024,
    limitSource: "host_configured",
    estimator: { id: `${providerId}.utf8-content`, revision: "1" },
    framing: { id: `${providerId}.framing`, revision: "1" },
    renderRequest: (messages, interaction) => JSON.stringify({ messages, interaction }),
  });
}

function modelMessageText(message: ProviderRequest["messages"][number]): string {
  return message.content
    .map((block) => block.kind === "text" ? block.text : JSON.stringify(block))
    .join("");
}

function commandToolCall(
  markerPath: string,
  reason = "Create a governed marker file.",
) {
  return {
    kind: "tool_call",
    reason,
    toolName: process.platform === "win32" ? "PowerShell" : "Bash",
    input: {
      command: process.platform === "win32"
        ? `[System.IO.File]::WriteAllText('${markerPath.replaceAll("'", "''")}', 'ran')`
        : `printf 'ran' > '${markerPath.replaceAll("'", "'\\''")}'`,
      timeout_ms: 5_000,
      description: reason,
    },
  };
}

function pendingApproval(snapshot: HelarcMainSnapshot) {
  const pending = snapshot.run?.host.pendingInteractions.find(
    (candidate) => candidate.request.protocol.owner === "permission" &&
      candidate.request.protocol.kind === "approval" &&
      candidate.request.protocol.revision === "1",
  );
  if (pending === undefined) {
    throw new Error("Expected a pending approval.");
  }
  return {
    request: pending.presentation as import("@agent-anything/permission").ApprovalReviewRequest,
    interactionRequest: pending.request,
    pendingVersion: pending.request.requestVersion,
    phase: pending.phase === "pending" ? "reviewing" as const : pending.phase,
  };
}

type ApprovalInteractionSubmission = ApprovalDecisionSubmission & {
  readonly interactionRequest: InteractionRequestRef;
};

function approvalSubmission(
  snapshot: HelarcMainSnapshot,
  kind: ApprovalDecisionKind,
  overrides: Partial<ApprovalDecisionSubmission> = {},
): ApprovalInteractionSubmission {
  const pending = pendingApproval(snapshot);
  const option = pending.request.decisionOptions.find((candidate) => candidate.kind === kind);
  if (option === undefined) {
    throw new Error(`Expected approval option ${kind}.`);
  }
  const grantedPermissions = kind === "grantPermissions" &&
      pending.request.category === "permissions"
    ? pending.request.payload.permissions
    : null;
  return {
    submissionId: "desktop-submission-1",
    runId: pending.request.runId,
    requestId: pending.request.id,
    pendingVersion: pending.pendingVersion,
    optionId: option.id,
    grantedPermissions,
    reason: kind === "decline" ? "Declined in test." : null,
    interactionRequest: pending.interactionRequest,
    ...overrides,
  };
}

function dispatchApprovalCommand(
  controller: HelarcMainController,
  submission: ApprovalInteractionSubmission,
  commandId = `host-approval-${submission.submissionId}`,
) {
  const { interactionRequest, ...payload } = submission;
  const { runId } = submission;
  return controller.dispatchHostCommand({
    version: HOST_COMMAND_VERSION,
    commandId,
    runId,
    kind: "interaction.submit",
    payload: {
      request: interactionRequest,
      submissionId: submission.submissionId,
      payload,
    },
  }, "interaction.submit");
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

function waitForPendingApproval(
  controller: HelarcMainController,
): Promise<HelarcMainSnapshot> {
  return waitForSnapshot(
    controller,
    (snapshot) => snapshot.run?.host.pendingInteractions.some(
      (candidate) => candidate.request.protocol.kind === "approval",
    ) === true,
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
    }, SNAPSHOT_WAIT_TIMEOUT_MS);

    const unsubscribe = controller.subscribeSnapshot((nextSnapshot) => {
      if (nextSnapshot.status === status) {
        clearTimeout(timeout);
        unsubscribe();
        resolve(nextSnapshot);
      }
    });
  });
}

const SNAPSHOT_WAIT_TIMEOUT_MS = 10_000;

function waitForSnapshot(
  controller: HelarcMainController,
  predicate: (snapshot: HelarcMainSnapshot) => boolean,
  timeoutMs = SNAPSHOT_WAIT_TIMEOUT_MS,
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
    }, SNAPSHOT_WAIT_TIMEOUT_MS);

    const unsubscribe = controller.subscribeSnapshot((nextSnapshot) => {
      if (nextSnapshot.run?.host.terminal?.status === status) {
        clearTimeout(timeout);
        unsubscribe();
        resolve(nextSnapshot);
      }
    });
  });
}
