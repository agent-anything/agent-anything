import type { BrowserWindow } from "electron";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HelarcMainController } from "./HelarcMainController.js";

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
  beforeEach(() => {
    electron.handlers.clear();
    electron.handle.mockClear();
    electron.showOpenDialog.mockReset();
  });

  it("registers every renderer command and revalidates execution payloads in main", async () => {
    const startRun = vi.fn(async (input) => ({ ok: true as const, input }));
    const cancelRun = vi.fn(() => ({ ok: true as const }));
    const submitApprovalDecision = vi.fn((input) => ({ status: "accepted" as const, input }));
    const resolvePatchReview = vi.fn((input) => ({ ok: true as const, input }));
    const controller = {
      subscribeSnapshot: vi.fn(() => () => undefined),
      getSnapshot: vi.fn(() => ({ status: "idle" })),
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

    await electron.handlers.get(HELARC_IPC_CHANNELS.startRun)?.({}, { taskText: 42 });
    await electron.handlers.get(HELARC_IPC_CHANNELS.cancelRun)?.({});
    await electron.handlers.get(HELARC_IPC_CHANNELS.submitApprovalDecision)?.({}, {
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
    await electron.handlers.get(HELARC_IPC_CHANNELS.resolvePatchReview)?.({}, {
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
    const openThread = vi.fn(async (threadId: string) => ({
      ok: true as const,
      snapshot: { threadId },
    }));
    const controller = {
      subscribeSnapshot: vi.fn(() => () => undefined),
      getSnapshot: vi.fn(() => ({ status: "idle" })),
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

    await handler?.({}, { threadId: "helarc-thread-1" });
    await handler?.({}, { threadId: 42 });

    expect(openThread).toHaveBeenNthCalledWith(1, "helarc-thread-1");
    expect(openThread).toHaveBeenNthCalledWith(2, "");
  });
});
