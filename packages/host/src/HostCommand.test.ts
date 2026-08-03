import type {
  ApprovalDecisionSubmission,
  ApprovalSubmissionReceipt,
} from "@agent-anything/permission";
import { describe, expect, it, vi } from "vitest";
import {
  createHostCommandDispatcher,
  HOST_COMMAND_VERSION,
  snapshotHostCommand,
  type HostApprovalSubmissionCommand,
  type HostRunCancellationCommand,
} from "./HostCommand.js";
import type {
  HostActiveRun,
  HostRunCancellationInput,
  HostRunCancellationReceipt,
} from "./HostRuntime.js";
import {
  createHostRunProjection,
  type HostRunProjection,
} from "./HostRunProjection.js";

const occurredAt = "2026-08-03T00:00:00.000Z";

describe("Host command transport", () => {
  it("snapshots the exact versioned Host command shape", () => {
    const source = cancellationCommand();
    const snapshot = snapshotHostCommand(source);

    expect(snapshot).toEqual(source);
    expect(snapshot).not.toBe(source);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.payload)).toBe(true);
    expect(() => snapshotHostCommand({
      ...source,
      version: 2,
    })).toThrow("version is unsupported");
    expect(() => snapshotHostCommand({
      ...source,
      payload: {
        reason: null,
        origin: "host",
        reasonCode: "host_shutdown",
      },
    })).toThrow("unsupported fields");
    expect(() => snapshotHostCommand({
      ...source,
      trustedHandle: {},
    })).toThrow("unsupported fields");
    expect(() => snapshotHostCommand(approvalCommand({
      payload: {
        ...approvalCommand().payload,
        grantedPermissions: {
          fileSystem: {
            read: ["/workspace"],
            trustedRoot: true,
          },
        } as never,
      },
    }))).toThrow("unsupported fields");
  });

  it("derives trusted cancellation attribution and replays one exact receipt", () => {
    const active = fakeActiveRun("run-1");
    const dispatcher = createHostCommandDispatcher({
      resolveActiveRun: (runId) => runId === active.runId ? active : null,
      cancellationAttribution: {
        origin: "user",
        reasonCode: "user_requested",
      },
    });
    const command = cancellationCommand({
      payload: { reason: "Stop this Run." },
    });

    const first = dispatcher.dispatch(command, "run.cancel");
    const replay = dispatcher.dispatch(structuredClone(command), "run.cancel");

    expect(first).toMatchObject({
      version: HOST_COMMAND_VERSION,
      commandId: "command-cancel-1",
      runId: "run-1",
      kind: "run.cancel",
      status: "handled",
      result: { status: "accepted" },
    });
    expect(replay).toBe(first);
    expect(active.cancel).toHaveBeenCalledOnce();
    expect(active.cancel).toHaveBeenCalledWith({
      origin: "user",
      reasonCode: "user_requested",
      reason: "Stop this Run.",
    });

    const conflict = dispatcher.dispatch(cancellationCommand({
      payload: { reason: "Different intent." },
    }), "run.cancel");
    expect(conflict).toMatchObject({
      status: "rejected",
      code: "host_command_id_conflict",
    });
    expect(active.cancel).toHaveBeenCalledOnce();
  });

  it("rejects stale Run identity without touching the newer active handle", () => {
    const newer = fakeActiveRun("run-new");
    const dispatcher = createHostCommandDispatcher({
      resolveActiveRun: (runId) => runId === newer.runId ? newer : null,
      cancellationAttribution: {
        origin: "user",
        reasonCode: "user_requested",
      },
    });

    const receipt = dispatcher.dispatch(cancellationCommand({
      runId: "run-old",
    }), "run.cancel");

    expect(receipt).toEqual({
      version: HOST_COMMAND_VERSION,
      commandId: "command-cancel-1",
      runId: "run-old",
      kind: "run.cancel",
      status: "rejected",
      code: "host_command_run_not_active",
      projection: null,
    });
    expect(newer.cancel).not.toHaveBeenCalled();
  });

  it("submits exact approval correlation only on the expected route", () => {
    const active = fakeActiveRun("run-1");
    const dispatcher = createHostCommandDispatcher({
      resolveActiveRun: () => active,
      cancellationAttribution: {
        origin: "user",
        reasonCode: "user_requested",
      },
    });
    const command = approvalCommand();

    const wrongRoute = dispatcher.dispatch(command, "run.cancel");
    expect(wrongRoute).toMatchObject({
      status: "rejected",
      code: "host_command_kind_mismatch",
    });
    expect(active.submitApprovalDecision).not.toHaveBeenCalled();

    const nextDispatcher = createHostCommandDispatcher({
      resolveActiveRun: () => active,
      cancellationAttribution: {
        origin: "user",
        reasonCode: "user_requested",
      },
    });
    const handled = nextDispatcher.dispatch(command, "approval.submit");
    expect(handled).toMatchObject({
      status: "handled",
      result: {
        status: "accepted_for_resolution",
        submissionId: "submission-1",
        runId: "run-1",
        requestId: "request-1",
        pendingVersion: 2,
      },
    });
    expect(active.submitApprovalDecision).toHaveBeenCalledWith({
      submissionId: "submission-1",
      runId: "run-1",
      requestId: "request-1",
      pendingVersion: 2,
      optionId: "accept-action",
      grantedPermissions: null,
      reason: null,
    });
  });

  it("fails closed at ledger capacity without making an admitted command replayable", () => {
    const active = fakeActiveRun("run-1");
    const dispatcher = createHostCommandDispatcher({
      resolveActiveRun: () => active,
      cancellationAttribution: {
        origin: "user",
        reasonCode: "user_requested",
      },
      maxReceipts: 1,
    });
    const firstCommand = cancellationCommand();
    const first = dispatcher.dispatch(firstCommand, "run.cancel");
    const full = dispatcher.dispatch(approvalCommand({
      commandId: "command-approval-2",
    }), "approval.submit");

    expect(full).toMatchObject({
      status: "rejected",
      code: "host_command_ledger_full",
    });
    expect(dispatcher.dispatch(firstCommand, "run.cancel")).toBe(first);
    expect(active.cancel).toHaveBeenCalledOnce();
    expect(active.submitApprovalDecision).not.toHaveBeenCalled();
  });
});

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

function approvalCommand(
  overrides: Partial<HostApprovalSubmissionCommand> = {},
): HostApprovalSubmissionCommand {
  return {
    version: HOST_COMMAND_VERSION,
    commandId: "command-approval-1",
    runId: "run-1",
    kind: "approval.submit",
    payload: {
      submissionId: "submission-1",
      requestId: "request-1",
      pendingVersion: 2,
      optionId: "accept-action",
      grantedPermissions: null,
      reason: null,
    },
    ...overrides,
  };
}

function fakeActiveRun(runId: string) {
  const projection: HostRunProjection = createHostRunProjection({
    sessionId: "session-1",
    taskId: "task-1",
    runId,
    startedAt: occurredAt,
    enforcement: "disabled",
  });
  const cancellation = Object.freeze({
    requestId: `${runId}:cancellation`,
    origin: "user" as const,
    reasonCode: "user_requested" as const,
    requestedAt: occurredAt,
  });
  const cancel = vi.fn(
    (_input: HostRunCancellationInput): HostRunCancellationReceipt =>
      Object.freeze({
        status: "accepted",
        cancellation,
      }),
  );
  const submitApprovalDecision = vi.fn(
    (submission: ApprovalDecisionSubmission): ApprovalSubmissionReceipt =>
      Object.freeze({
        status: "accepted_for_resolution",
        submissionId: submission.submissionId,
        runId: submission.runId,
        requestId: submission.requestId,
        pendingVersion: submission.pendingVersion,
      }),
  );
  const active: HostActiveRun & {
    cancel: typeof cancel;
    submitApprovalDecision: typeof submitApprovalDecision;
  } = {
    sessionId: "session-1",
    runId,
    getProjection: () => projection,
    subscribe: () => () => undefined,
    submitApprovalDecision,
    cancel,
    result: new Promise(() => undefined),
  };
  return active;
}
