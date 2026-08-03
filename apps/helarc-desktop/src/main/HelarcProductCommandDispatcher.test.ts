import { describe, expect, it, vi } from "vitest";
import {
  HELARC_PRODUCT_COMMAND_VERSION,
  type HelarcProductCommandEnvelope,
  type HelarcProductCommandKind,
} from "../shared/HelarcDesktopCommand.js";
import type {
  HelarcMainSnapshot,
  HelarcProductCommandResultMap,
} from "../shared/HelarcDesktopApi.js";
import {
  createHelarcProductCommandDispatcher,
  type HelarcProductCommandHandlers,
} from "./HelarcProductCommandDispatcher.js";

describe("Helarc Product command dispatcher", () => {
  it("validates exact envelopes and route kinds before invoking an owner", async () => {
    const handlers = createHandlers();
    const dispatcher = createHelarcProductCommandDispatcher({ handlers });

    await expect(dispatcher.dispatch({
      ...command("run.start", "command-version", { taskText: "Inspect files" }),
      version: 2,
    }, "run.start")).resolves.toMatchObject({
      status: "rejected",
      code: "helarc_product_command_version_unsupported",
    });
    await expect(dispatcher.dispatch({
      ...command("run.start", "command-extra", { taskText: "Inspect files" }),
      privateControl: true,
    }, "run.start")).resolves.toMatchObject({
      status: "rejected",
      code: "helarc_product_command_invalid",
    });
    await expect(dispatcher.dispatch(
      command("run.start", "command-route", { taskText: "Inspect files" }),
      "thread.open",
    )).resolves.toMatchObject({
      status: "rejected",
      code: "helarc_product_command_kind_mismatch",
    });
    expect(handlers["run.start"]).not.toHaveBeenCalled();
  });

  it("reserves an asynchronous start before awaiting and replays one immutable receipt", async () => {
    const pending = deferred<HelarcProductCommandResultMap["run.start"]>();
    const handlers = createHandlers({
      "run.start": vi.fn(() => pending.promise),
    });
    const dispatcher = createHelarcProductCommandDispatcher({ handlers });
    const start = command("run.start", "command-start", {
      taskText: "Inspect files",
    });

    const first = dispatcher.dispatch(start, "run.start");
    const duplicate = dispatcher.dispatch(start, "run.start");
    await Promise.resolve();
    expect(handlers["run.start"]).toHaveBeenCalledOnce();

    pending.resolve({
      ok: true,
      taskId: "task-1",
      snapshot: snapshot("running"),
    });
    const firstReceipt = await first;
    const duplicateReceipt = await duplicate;

    expect(duplicateReceipt).toBe(firstReceipt);
    expect(firstReceipt).toMatchObject({
      status: "handled",
      commandId: "command-start",
      result: { ok: true, taskId: "task-1" },
    });
    expect(Object.isFrozen(firstReceipt)).toBe(true);
    expect(
      firstReceipt.status === "handled" && Object.isFrozen(firstReceipt.result),
    ).toBe(true);
  });

  it("rejects conflicting reuse and fails closed at capacity without evicting replay", async () => {
    const handlers = createHandlers();
    const dispatcher = createHelarcProductCommandDispatcher({
      handlers,
      maxReceipts: 1,
    });
    const firstCommand = command("run.start", "command-1", {
      taskText: "Inspect files",
    });
    const first = await dispatcher.dispatch(firstCommand, "run.start");

    await expect(dispatcher.dispatch(
      command("run.start", "command-1", { taskText: "Change files" }),
      "run.start",
    )).resolves.toMatchObject({
      status: "rejected",
      code: "helarc_product_command_id_conflict",
    });
    await expect(dispatcher.dispatch(
      command("thread.open", "command-2", { threadId: "thread-1" }),
      "thread.open",
    )).resolves.toMatchObject({
      status: "rejected",
      code: "helarc_product_command_ledger_full",
    });
    await expect(dispatcher.dispatch(firstCommand, "run.start")).resolves.toBe(first);
    expect(handlers["run.start"]).toHaveBeenCalledOnce();
    expect(handlers["thread.open"]).not.toHaveBeenCalled();
  });

  it("does not retain or return a Provider credential in a handled receipt", async () => {
    const secret = "secret-provider-key";
    const handlers = createHandlers();
    const dispatcher = createHelarcProductCommandDispatcher({ handlers });

    const receipt = await dispatcher.dispatch(
      command("provider.save", "command-provider", {
        providerKind: "openai-compatible",
        displayName: "Provider",
        baseUrl: "https://provider.example/v1",
        model: "model",
        timeoutMs: 30_000,
        apiKeyUpdate: "set",
        apiKey: secret,
      }),
      "provider.save",
    );

    expect(handlers["provider.save"]).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: secret }),
    );
    expect(JSON.stringify(receipt)).not.toContain(secret);
  });
});

function createHandlers(
  overrides: Partial<HelarcProductCommandHandlers> = {},
): HelarcProductCommandHandlers {
  return {
    "workspace.choose": vi.fn(() => snapshot()),
    "workspace.select": vi.fn(() => snapshot()),
    "provider.save": vi.fn(() => snapshot()),
    "run.start": vi.fn(() => ({
      ok: true as const,
      taskId: "task-1",
      snapshot: snapshot("running"),
    })),
    "patch_review.submit": vi.fn(() => ({
      ok: true as const,
      snapshot: snapshot(),
    })),
    "thread.open": vi.fn(() => ({
      ok: true as const,
      snapshot: snapshot(),
    })),
    ...overrides,
  };
}

function command<TKind extends HelarcProductCommandKind>(
  kind: TKind,
  commandId: string,
  payload: HelarcProductCommandEnvelope<TKind>["payload"],
): HelarcProductCommandEnvelope<TKind> {
  return {
    version: HELARC_PRODUCT_COMMAND_VERSION,
    commandId,
    kind,
    payload,
  };
}

function snapshot(
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
