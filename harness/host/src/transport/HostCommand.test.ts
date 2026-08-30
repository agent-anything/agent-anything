import { describe, expect, it, vi } from "vitest";
import type { InteractionRequestRef } from "@agent-anything/interaction/protocol";
import type {
  HostActiveRun,
  HostRunCancellationInput,
  HostRunCancellationReceipt,
} from "../run/HostRunManager.js";
import {
  createHostRunProjection,
  type HostRunProjection,
} from "../projection/HostRunProjection.js";
import {
  createHostCommandDispatcher,
  HOST_COMMAND_VERSION,
  snapshotHostCommand,
  type HostInteractionSubmissionCommand,
  type HostRunCancellationCommand,
  type HostRunSteeringCommand,
} from "./HostCommand.js";
import { createTestRootRunTreeSnapshot } from "../testing/RunTreeTestSnapshot.js";

describe("Host command transport", () => {
  it("snapshots only the exact versioned cancellation and Interaction shapes", () => {
    const payload = { choice: "approve" };
    const interaction = snapshotHostCommand(interactionCommand({
      payload: { request: REQUEST, submissionId: "submission-1", payload },
    }));
    payload.choice = "mutated";

    expect(snapshotHostCommand(cancellationCommand())).toEqual(cancellationCommand());
    expect(snapshotHostCommand(steeringCommand())).toEqual(steeringCommand());
    expect(interaction).toMatchObject({
      kind: "interaction.submit",
      payload: {
        request: REQUEST,
        submissionId: "submission-1",
        payload: { choice: "approve" },
      },
    });
    expect(Object.isFrozen(interaction)).toBe(true);
    expect(Object.isFrozen(interaction.payload)).toBe(true);
    expect(() => snapshotHostCommand({
      ...cancellationCommand(),
      legacyApproval: true,
    })).toThrow("unsupported fields");
  });

  it("routes steering as an acknowledged Run command without claiming application", () => {
    const active = fakeActiveRun();
    const dispatcher = createDispatcher(active);

    const receipt = dispatcher.dispatch(steeringCommand(), "run.steer");

    expect(receipt).toMatchObject({
      status: "handled",
      kind: "run.steer",
      result: { status: "accepted_for_application" },
    });
    expect(active.steer).toHaveBeenCalledWith({
      commandId: "command-steer-1",
      expectedRunRevision: 0,
      instruction: "Inspect the tests before continuing.",
      attribution: { origin: "user", actorId: "user-1" },
    });
  });

  it("replays one identical command and rejects conflicting command identity", () => {
    const active = fakeActiveRun();
    const dispatcher = createDispatcher(active);
    const command = cancellationCommand({ payload: { reason: "Stop this Run." } });

    const first = dispatcher.dispatch(command, "run.cancel");
    const replay = dispatcher.dispatch(command, "run.cancel");
    const conflict = dispatcher.dispatch(cancellationCommand({
      payload: { reason: "Different intent." },
    }), "run.cancel");

    expect(first).toMatchObject({ status: "handled", kind: "run.cancel" });
    expect(replay).toBe(first);
    expect(conflict).toMatchObject({
      status: "rejected",
      code: "host_command_id_conflict",
    });
    expect(active.cancel).toHaveBeenCalledOnce();
  });

  it("routes one exact generic Interaction submission and rejects a wrong route", () => {
    const active = fakeActiveRun();
    const command = interactionCommand();
    const wrongRoute = createDispatcher(active).dispatch(command, "run.cancel");
    expect(wrongRoute).toMatchObject({
      status: "rejected",
      code: "host_command_kind_mismatch",
    });
    expect(active.submitInteraction).not.toHaveBeenCalled();

    const handled = createDispatcher(active).dispatch(command, "interaction.submit");
    expect(handled).toMatchObject({
      status: "handled",
      kind: "interaction.submit",
      result: { status: "accepted_for_resolution" },
    });
    expect(active.submitInteraction).toHaveBeenCalledWith({
      request: REQUEST,
      submissionId: "submission-1",
      payload: { choice: "approve" },
    });
  });

  it("rejects a stale Run identity without touching another active handle", () => {
    const active = fakeActiveRun("run-new");
    const dispatcher = createHostCommandDispatcher({
      resolveActiveRun: (runId) => runId === active.runId ? active : null,
      cancellationAttribution: { origin: "user", reasonCode: "user_requested" },
      steeringAttribution: { origin: "user", actorId: "user-1" },
    });

    const receipt = dispatcher.dispatch(cancellationCommand({ runId: "run-old" }), "run.cancel");

    expect(receipt).toMatchObject({
      status: "rejected",
      code: "host_command_run_not_active",
      projection: null,
    });
    expect(active.cancel).not.toHaveBeenCalled();
  });

  it("fails closed at receipt capacity while retaining admitted replay", () => {
    const active = fakeActiveRun();
    const dispatcher = createHostCommandDispatcher({
      resolveActiveRun: () => active,
      cancellationAttribution: { origin: "user", reasonCode: "user_requested" },
      steeringAttribution: { origin: "user", actorId: "user-1" },
      maxReceipts: 1,
    });
    const firstCommand = cancellationCommand();
    const first = dispatcher.dispatch(firstCommand, "run.cancel");

    const full = dispatcher.dispatch(interactionCommand({
      commandId: "command-interaction-2",
    }), "interaction.submit");

    expect(full).toMatchObject({
      status: "rejected",
      code: "host_command_ledger_full",
    });
    expect(dispatcher.dispatch(firstCommand, "run.cancel")).toBe(first);
    expect(active.cancel).toHaveBeenCalledOnce();
    expect(active.submitInteraction).not.toHaveBeenCalled();
  });
});

function createDispatcher(active: ReturnType<typeof fakeActiveRun>) {
  return createHostCommandDispatcher({
    resolveActiveRun: () => active,
    cancellationAttribution: { origin: "user", reasonCode: "user_requested" },
    steeringAttribution: { origin: "user", actorId: "user-1" },
  });
}

function cancellationCommand(
  overrides: Partial<HostRunCancellationCommand> = {},
): HostRunCancellationCommand {
  return {
    version: HOST_COMMAND_VERSION,
    commandId: "command-cancel-1",
    runId: "run-1",
    kind: "run.cancel",
    payload: { reason: null },
    ...overrides,
  };
}

function interactionCommand(
  overrides: Partial<HostInteractionSubmissionCommand> = {},
): HostInteractionSubmissionCommand {
  return {
    version: HOST_COMMAND_VERSION,
    commandId: "command-interaction-1",
    runId: "run-1",
    kind: "interaction.submit",
    payload: {
      request: REQUEST,
      submissionId: "submission-1",
      payload: { choice: "approve" },
    },
    ...overrides,
  };
}

function steeringCommand(
  overrides: Partial<HostRunSteeringCommand> = {},
): HostRunSteeringCommand {
  return {
    version: HOST_COMMAND_VERSION,
    commandId: "command-steer-1",
    runId: "run-1",
    kind: "run.steer",
    payload: {
      expectedRunRevision: 0,
      instruction: "Inspect the tests before continuing.",
    },
    ...overrides,
  };
}

function fakeActiveRun(runId = "run-1") {
  const projection: HostRunProjection = createHostRunProjection({
    sessionId: "session-1",
    taskId: "task-1",
    runId,
    startedAt: NOW,
    enforcement: "disabled",
    runTree: rootTree(runId),
  });
  const cancel = vi.fn(
    (_input: HostRunCancellationInput): HostRunCancellationReceipt => ({
      status: "accepted",
      cancellation: {
        requestId: `${runId}:cancellation-1`,
        origin: "user",
        reasonCode: "user_requested",
        requestedAt: NOW,
      },
    }),
  );
  const submitInteraction = vi.fn(() => ({
    status: "accepted_for_resolution" as const,
    receipt: {
      receiptId: "interaction-receipt-1",
      request: REQUEST,
      submissionId: "submission-1",
      status: "accepted_for_resolution" as const,
      recordedAt: NOW,
    },
  }));
  const steer = vi.fn((input: Parameters<HostActiveRun["steer"]>[0]) => ({
    status: "accepted_for_application" as const,
    command: {
      ...input,
      submittedAt: NOW,
      ref: { run: { id: runId }, commandId: input.commandId },
      acceptedRunRevision: input.expectedRunRevision,
    },
  }));
  const active: HostActiveRun & {
    cancel: typeof cancel;
    steer: typeof steer;
    submitInteraction: typeof submitInteraction;
  } = {
    sessionId: "session-1",
    runId,
    getProjection: () => projection,
    getStatus: () => projection,
    subscribe: () => () => undefined,
    submitInteraction,
    steer,
    cancel,
    wait: () => new Promise(() => undefined),
    getResult: () => null,
  };
  return active;
}

function rootTree(runId: string) {
  return createTestRootRunTreeSnapshot(runId, NOW);
}

const REQUEST: InteractionRequestRef = Object.freeze({
  id: "interaction-1",
  protocol: Object.freeze({ owner: "permission", kind: "approval", revision: "1" }),
  requestVersion: 1,
  subject: Object.freeze({
    owner: "canonical-action",
    kind: "action-subject",
    id: "action-1",
    revision: "1",
  }),
});
const NOW = "2026-08-13T00:00:00.000Z";
