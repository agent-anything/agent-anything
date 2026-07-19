import type { BrowserWindow } from "electron";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  HelarcMainController,
  HelarcMainSnapshot,
} from "./HelarcMainController.js";

const electron = vi.hoisted(() => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  return {
    handlers,
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler);
    }),
    showOpenDialog: vi.fn(),
  };
});

vi.mock("electron", () => ({
  dialog: { showOpenDialog: electron.showOpenDialog },
  ipcMain: { handle: electron.handle },
}));

import { HELARC_IPC_CHANNELS, registerHelarcIpc } from "./ipc.js";

describe("Helarc IPC", () => {
  const PRIVATE_RESULT = "private-main-command-result";

  beforeEach(() => {
    electron.handlers.clear();
    electron.handle.mockClear();
    electron.showOpenDialog.mockReset();
  });

  it("registers every renderer command and revalidates execution payloads in main", async () => {
    const snapshot = mainSnapshot();
    const startRun = vi.fn(async () => ({
      ok: true as const,
      taskId: "task-1",
      snapshot,
      privateState: PRIVATE_RESULT,
    }));
    const cancelRun = vi.fn(() => ({
      ok: true as const,
      snapshot,
      privateState: PRIVATE_RESULT,
    }));
    const submitApprovalDecision = vi.fn(() => ({
      status: "accepted_for_resolution" as const,
      submissionId: "submission-1",
      runId: "run-1",
      requestId: "request-1",
      pendingVersion: 2,
      privateAuthority: PRIVATE_RESULT,
    }));
    const resolvePatchReview = vi.fn(() => ({
      ok: true as const,
      snapshot,
      privateState: PRIVATE_RESULT,
    }));
    const controller = {
      subscribeSnapshot: vi.fn(() => () => undefined),
      getSnapshot: vi.fn(() => snapshot),
      openThread: vi.fn(),
      selectWorkspacePath: vi.fn(),
      failWorkspaceSelection: vi.fn(),
      setWorkspaceProfiles: vi.fn(),
      selectWorkspaceProfile: vi.fn(),
      configureProvider: vi.fn(),
      startRun,
      cancelRun,
      submitApprovalDecision,
      resolvePatchReview,
    } as unknown as HelarcMainController;
    const window = {
      isDestroyed: vi.fn(() => false),
      once: vi.fn(),
      webContents: { send: vi.fn() },
    } as unknown as BrowserWindow;

    registerHelarcIpc({ window, controller });

    const commandChannels = Object.values(HELARC_IPC_CHANNELS).filter(
      (channel) => channel !== HELARC_IPC_CHANNELS.snapshotUpdated,
    );
    expect([...electron.handlers.keys()].sort()).toEqual([...commandChannels].sort());

    const startResult = await electron.handlers.get(HELARC_IPC_CHANNELS.startRun)?.(
      {},
      { taskText: 42 },
    );
    const cancelResult = await electron.handlers.get(HELARC_IPC_CHANNELS.cancelRun)?.({});
    const approvalResult = await electron.handlers.get(
      HELARC_IPC_CHANNELS.submitApprovalDecision,
    )?.({}, {
      submissionId: "submission-1",
      runId: "run-1",
      requestId: "request-1",
      pendingVersion: "2",
      optionId: "grant",
      grantedPermissions: {
        fileSystem: { read: ["src", 42], write: ["dist"] },
        network: { enabled: true, domains: ["example.com", false] },
      },
      reason: 42,
      trustedReviewer: { secret: true },
    });
    const patchResult = await electron.handlers.get(
      HELARC_IPC_CHANNELS.resolvePatchReview,
    )?.({}, {
      submissionId: "patch-1",
      runId: "run-1",
      proposalId: "proposal-1",
      reviewId: "review-1",
      pendingVersion: "2",
      decision: "unexpected",
      reason: 42,
      canonicalAction: { secret: true },
    });

    expect(startRun).toHaveBeenCalledWith({ taskText: "" });
    expect(cancelRun).toHaveBeenCalledOnce();
    expect(submitApprovalDecision).toHaveBeenCalledWith({
      submissionId: "submission-1",
      runId: "run-1",
      requestId: "request-1",
      pendingVersion: 2,
      optionId: "grant",
      grantedPermissions: {
        fileSystem: { read: ["src"], write: ["dist"] },
        network: { enabled: true, domains: ["example.com"] },
      },
      reason: null,
    });
    expect(JSON.stringify([startResult, cancelResult, approvalResult, patchResult]))
      .not.toContain(PRIVATE_RESULT);
    expect(resolvePatchReview).toHaveBeenCalledWith({
      submissionId: "patch-1",
      runId: "run-1",
      proposalId: "proposal-1",
      reviewId: "review-1",
      pendingVersion: 0,
      decision: "rejected",
      reason: null,
    });
  });

  it("registers safe Thread opening and validates its payload in main", async () => {
    const snapshot = mainSnapshot();
    const openThread = vi.fn(async () => ({
      ok: true as const,
      snapshot,
      privateState: PRIVATE_RESULT,
    }));
    const controller = {
      subscribeSnapshot: vi.fn(() => () => undefined),
      getSnapshot: vi.fn(() => snapshot),
      openThread,
    } as unknown as HelarcMainController;
    const window = {
      isDestroyed: vi.fn(() => false),
      once: vi.fn(),
      webContents: { send: vi.fn() },
    } as unknown as BrowserWindow;

    registerHelarcIpc({ window, controller });
    const handler = electron.handlers.get(HELARC_IPC_CHANNELS.openThread);
    expect(handler).toBeTypeOf("function");

    const result = await handler?.({}, { threadId: "helarc-thread-1" });
    await handler?.({}, { threadId: 42 });

    expect(openThread).toHaveBeenNthCalledWith(1, "helarc-thread-1");
    expect(openThread).toHaveBeenNthCalledWith(2, "");
    expect(JSON.stringify(result)).not.toContain(PRIVATE_RESULT);
  });
});

function mainSnapshot(): HelarcMainSnapshot {
  return {
    status: "idle",
    workspace: null,
    workspaceProfiles: [],
    taskTemplates: [],
    provider: {
      configured: false,
      activeProfile: null,
      profiles: [],
      error: {
        code: "provider_config_missing",
        message: "Provider configuration is missing.",
      },
    },
    acceptedTask: null,
    activeThread: null,
    threadSummaries: [],
    run: null,
    error: null,
  };
}
