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
  };
});

vi.mock("electron", () => ({
  dialog: { showOpenDialog: vi.fn() },
  ipcMain: { handle: electron.handle },
}));

import { HELARC_IPC_CHANNELS, registerHelarcIpc } from "./ipc.js";

describe("Helarc IPC", () => {
  beforeEach(() => {
    electron.handlers.clear();
    electron.handle.mockClear();
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
