import type { BrowserWindow } from "electron";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  HELARC_PRODUCT_COMMAND_VERSION,
} from "../shared/HelarcDesktopCommand.js";
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

  it("revalidates Product envelopes and replays an exact asynchronous start once", async () => {
    const current = mainSnapshot();
    const running = mainSnapshot("running");
    const startGate = deferred<void>();
    const startRun = vi.fn(async () => {
      await startGate.promise;
      return {
        ok: true as const,
        taskId: "task-1",
        runId: "run-1",
        threadId: "thread-1",
        snapshot: running,
        privateState: PRIVATE_RESULT,
      };
    });
    const controller = controllerDouble(current, { startRun });
    const window = windowDouble();

    registerHelarcIpc({ window, controller });
    const handler = requiredHandler(HELARC_IPC_CHANNELS.startRun);
    const command = {
      version: HELARC_PRODUCT_COMMAND_VERSION,
      commandId: "product-start-1",
      kind: "run.start",
      payload: {
        taskText: "Inspect files",
        target: { kind: "new_thread" },
      },
    };

    const first = handler({}, command) as Promise<unknown>;
    const duplicate = handler({}, command) as Promise<unknown>;
    await Promise.resolve();
    expect(startRun).toHaveBeenCalledOnce();
    startGate.resolve();
    const firstReceipt = await first;
    const duplicateReceipt = await duplicate;

    expect(duplicateReceipt).toBe(firstReceipt);
    expect(firstReceipt).toMatchObject({
      version: 1,
      commandId: "product-start-1",
      kind: "run.start",
      status: "handled",
      result: {
        ok: true,
        taskId: "task-1",
        runId: "run-1",
        threadId: "thread-1",
        snapshot: { status: "running" },
      },
    });
    expect(JSON.stringify(firstReceipt)).not.toContain(PRIVATE_RESULT);

    await expect(handler({}, {
      ...command,
      commandId: "product-start-invalid",
      payload: { taskText: 42 },
    })).resolves.toMatchObject({
      status: "rejected",
      code: "helarc_product_command_invalid",
    });
    expect(startRun).toHaveBeenCalledOnce();
  });

  it("keeps queries outside command ledgers and disconnect stops delivery only", async () => {
    const snapshot = mainSnapshot();
    const unsubscribe = vi.fn();
    let publish = (_value: HelarcMainSnapshot): void => {
      throw new Error("Snapshot subscriber was not registered.");
    };
    const subscribeSnapshot = vi.fn((listener: (value: HelarcMainSnapshot) => void) => {
      publish = listener;
      return unsubscribe;
    });
    const controller = controllerDouble(snapshot, {
      subscribeSnapshot,
      dispatchHostCommand: vi.fn(),
      startRun: vi.fn(),
    });
    const closedListeners: Array<() => void> = [];
    const window = windowDouble({
      once: vi.fn((_event: string, listener: () => void) => {
        closedListeners.push(listener);
      }),
    });

    registerHelarcIpc({ window, controller });
    const getSnapshot = requiredHandler(HELARC_IPC_CHANNELS.getSnapshot);

    expect(getSnapshot({})).toEqual(snapshot);
    expect(getSnapshot({})).toEqual(snapshot);
    publish(snapshot);
    expect(window.webContents.send).toHaveBeenCalledOnce();
    closedListeners[0]?.();
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(controller.dispatchHostCommand).not.toHaveBeenCalled();
    expect(controller.startRun).not.toHaveBeenCalled();
  });

  it("passes exact Host envelopes to the trusted dispatcher and returns only safe receipt fields", async () => {
    const snapshot = mainSnapshot("cancelling");
    const dispatchHostCommand = vi.fn((candidate: unknown, expectedKind: string) => {
      const command = candidate as Record<string, unknown>;
      expect(expectedKind).toBe("run.cancel");
      return {
        version: 1,
        commandId: command.commandId,
        runId: command.runId,
        kind: "run.cancel",
        status: "handled",
        result: {
          status: "accepted",
          cancellation: {
            requestId: "cancel-1",
            origin: "user",
            reasonCode: "user_requested",
            requestedAt: "2026-08-03T00:00:00.000Z",
          },
          privateAuthority: PRIVATE_RESULT,
        },
        projection: { privateProjection: PRIVATE_RESULT },
        privateControl: PRIVATE_RESULT,
      };
    });
    const controller = controllerDouble(snapshot, { dispatchHostCommand });
    registerHelarcIpc({ window: windowDouble(), controller });
    const handler = requiredHandler(HELARC_IPC_CHANNELS.cancelRun);
    const command = {
      version: 1,
      commandId: "host-cancel-1",
      runId: "run-1",
      kind: "run.cancel",
      payload: { reason: "Stop this Run." },
    };

    const response = await handler({}, command);

    expect(dispatchHostCommand).toHaveBeenCalledWith(command, "run.cancel");
    expect(response).toMatchObject({
      receipt: {
        commandId: "host-cancel-1",
        runId: "run-1",
        status: "handled",
        result: {
          status: "accepted",
          cancellation: {
            origin: "user",
            reasonCode: "user_requested",
          },
        },
      },
      snapshot: { status: "cancelling" },
    });
    expect(JSON.stringify(response)).not.toContain(PRIVATE_RESULT);
  });

  it("rejects malformed Thread commands instead of coercing them into navigation", async () => {
    const openThread = vi.fn();
    const controller = controllerDouble(mainSnapshot(), { openThread });
    registerHelarcIpc({ window: windowDouble(), controller });
    const handler = requiredHandler(HELARC_IPC_CHANNELS.openThread);

    await expect(handler({}, {
      version: 1,
      commandId: "thread-open-invalid",
      kind: "thread.open",
      payload: {
        threadId: 42,
        fallbackThreadId: "thread-1",
      },
    })).resolves.toMatchObject({
      status: "rejected",
      code: "helarc_product_command_invalid",
    });
    expect(openThread).not.toHaveBeenCalled();
  });
});

function requiredHandler(channel: string): (...args: unknown[]) => unknown {
  const handler = electron.handlers.get(channel);
  if (!handler) {
    throw new Error(`Missing IPC handler '${channel}'.`);
  }
  return handler;
}

function controllerDouble(
  snapshot: HelarcMainSnapshot,
  overrides: Record<string, unknown> = {},
): HelarcMainController {
  return {
    subscribeSnapshot: vi.fn(() => () => undefined),
    getSnapshot: vi.fn(() => snapshot),
    openThread: vi.fn(),
    selectWorkspacePath: vi.fn(),
    failWorkspaceSelection: vi.fn(),
    setWorkspaceProfiles: vi.fn(),
    selectWorkspaceProfile: vi.fn(),
    configureProvider: vi.fn(),
    startRun: vi.fn(),
    dispatchHostCommand: vi.fn(),
    resolvePatchReview: vi.fn(),
    ...overrides,
  } as unknown as HelarcMainController;
}

function windowDouble(
  overrides: Record<string, unknown> = {},
): BrowserWindow {
  return {
    isDestroyed: vi.fn(() => false),
    once: vi.fn(),
    webContents: { send: vi.fn() },
    ...overrides,
  } as unknown as BrowserWindow;
}

function mainSnapshot(
  status: HelarcMainSnapshot["status"] = "idle",
): HelarcMainSnapshot {
  return {
    status,
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

function deferred<TValue>() {
  let resolve!: (value: TValue) => void;
  const promise = new Promise<TValue>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}
