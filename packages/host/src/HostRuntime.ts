import type { ISODateTimeString } from "@agent-anything/shared";
import {
  snapshotApprovalDecisionSubmission,
  type ApprovalDecisionSubmission,
  type ApprovalSubmissionReceipt,
} from "@agent-anything/permission";
import type { Agent } from "@agent-anything/agent-core/agent";
import { RuntimeEventEmitter } from "@agent-anything/agent-core/events";
import {
  toRunCancellationSummary,
  type RunCancellationRequestInput,
  type RunInput,
  type RunResult,
} from "@agent-anything/agent-core/run";
import type {
  RunConfig,
  Runner,
} from "@agent-anything/agent-runtime";
import {
  createHostRunProjection,
  createHostTerminalRunProjection,
  type HostCancellationProjection,
  type HostRunProjection,
  type HostRunProjectionListener,
  type HostRunProjectionListenerFailure,
  type HostTerminalRunProjection,
} from "./HostRunProjection.js";
import { createHostRunProjectionStore } from "./HostRunProjectionReducer.js";
import type { UserApprovalReviewBridge } from "./UserApprovalReviewBridge.js";

export type HostSessionId = string;

export interface HostRunStartInput<TOutput = unknown> {
  readonly sessionId: HostSessionId;
  readonly agent: Agent<TOutput>;
  readonly runInput: RunInput;
  readonly runConfig: RunConfig;
  readonly userApprovalReviewBridge?: UserApprovalReviewBridge | null;
}

export interface HostRunResult<TOutput = unknown> {
  readonly kind: "run_result";
  readonly sessionId: HostSessionId;
  readonly taskId: string;
  readonly runId: string;
  readonly runResult: RunResult<TOutput>;
  readonly terminal: HostTerminalRunProjection;
}

export interface HostRunStartFailure {
  readonly kind: "start_failure";
  readonly sessionId: HostSessionId;
  readonly taskId: string;
  readonly runId: string;
  readonly code: "host_runner_start_failed";
  readonly occurredAt: ISODateTimeString;
}

export type HostRunOutcome<TOutput = unknown> =
  | HostRunResult<TOutput>
  | HostRunStartFailure;

export type HostRunCancellationInput = RunCancellationRequestInput;

export type HostRunCancellationReceipt =
  | {
      readonly status: "accepted";
      readonly cancellation: HostCancellationProjection;
    }
  | {
      readonly status: "already_requested";
      readonly cancellation: HostCancellationProjection;
    }
  | {
      readonly status: "run_settled";
      readonly cancellation: HostCancellationProjection | null;
    }
  | {
      readonly status: "start_failed";
      readonly cancellation: HostCancellationProjection | null;
    };

export interface HostActiveRun<TOutput = unknown> {
  readonly sessionId: HostSessionId;
  readonly runId: string;
  getProjection(): HostRunProjection;
  subscribe(listener: HostRunProjectionListener): () => void;
  submitApprovalDecision(input: ApprovalDecisionSubmission): ApprovalSubmissionReceipt;
  cancel(input: HostRunCancellationInput): HostRunCancellationReceipt;
  readonly result: Promise<HostRunOutcome<TOutput>>;
}

export interface HostRuntime {
  start<TOutput>(input: HostRunStartInput<TOutput>): HostActiveRun<TOutput>;
}

export interface CreateHostRuntimeInput {
  readonly runner: Runner;
  readonly now?: () => ISODateTimeString;
  readonly onProjectionListenerFailure?: (
    failure: HostRunProjectionListenerFailure,
  ) => void;
}

type HostInvocationState = "active" | "settled" | "start_failed";

export function createHostRuntime(input: CreateHostRuntimeInput): HostRuntime {
  if (!input.runner || typeof input.runner.run !== "function") {
    throw new TypeError("HostRuntime requires a Runner.");
  }
  const now = input.now ?? (() => new Date().toISOString());

  return Object.freeze({
    start<TOutput>(startInput: HostRunStartInput<TOutput>): HostActiveRun<TOutput> {
      return startHostRun(input.runner, now, startInput, input.onProjectionListenerFailure);
    },
  });
}

function startHostRun<TOutput>(
  runner: Runner,
  now: () => ISODateTimeString,
  input: HostRunStartInput<TOutput>,
  onListenerFailure: CreateHostRuntimeInput["onProjectionListenerFailure"],
): HostActiveRun<TOutput> {
  assertStartInput(input);
  const sessionId = input.sessionId;
  const runId = input.runInput.runId;
  const taskId = input.runInput.task.id;
  const startedAt = readNow(now);
  const store = createHostRunProjectionStore({
    initial: createHostRunProjection({
      sessionId,
      taskId,
      runId,
      startedAt,
      enforcement: input.runConfig.permissions.permissionProfile.enforcement,
    }),
    ...(onListenerFailure === undefined ? {} : { onListenerFailure }),
  });
  const runtimeEvents = new RuntimeEventEmitter();
  let hostSequence = 0;
  let invocationState: HostInvocationState = "active";

  const nextSequence = (): number => {
    hostSequence += 1;
    return hostSequence;
  };
  const unsubscribeRuntimeEvents = runtimeEvents.subscribe((event) => {
    store.apply({
      kind: "runtime_event",
      runId,
      sequence: nextSequence(),
      occurredAt: event.timestamp,
      event,
    });
  });
  const userApprovalReviewBridge = input.userApprovalReviewBridge ?? null;
  const unsubscribeApprovalReview = userApprovalReviewBridge?.subscribe((review) => {
    if (review === null || invocationState !== "active") return;
    const reduction = store.apply({
      kind: "approval_review_available",
      runId,
      sequence: nextSequence(),
      occurredAt: review.request.createdAt,
      review,
    });
    if (reduction.status === "rejected") {
      throw new Error(`Host approval review projection was rejected: ${reduction.code}.`);
    }
  }) ?? (() => undefined);

  let invocation: Promise<RunResult<TOutput>>;
  try {
    invocation = runner.run(
      input.agent,
      input.runInput,
      input.runConfig,
      { runtimeEventPublisher: runtimeEvents },
    );
  } catch {
    invocation = Promise.reject(new Error("Runner invocation failed to start."));
  }

  const result = invocation.then<HostRunOutcome<TOutput>, HostRunOutcome<TOutput>>(
    (runResult) => {
      assertRunResultIdentity(runResult, runId, taskId);
      const terminal = createHostTerminalRunProjection({
        runResult,
        completedAt: readNow(now),
      });
      const reduction = store.apply({
        kind: "terminal_result",
        runId,
        sequence: nextSequence(),
        occurredAt: terminal.completedAt,
        terminal,
      });
      if (reduction.status === "rejected") {
        throw new Error(`Host terminal projection was rejected: ${reduction.code}.`);
      }
      invocationState = "settled";
      unsubscribeRuntimeEvents();
      unsubscribeApprovalReview();
      return Object.freeze({
        kind: "run_result" as const,
        sessionId,
        taskId,
        runId,
        runResult,
        terminal,
      });
    },
    () => {
      invocationState = "start_failed";
      unsubscribeRuntimeEvents();
      unsubscribeApprovalReview();
      return Object.freeze({
        kind: "start_failure" as const,
        sessionId,
        taskId,
        runId,
        code: "host_runner_start_failed" as const,
        occurredAt: readNow(now),
      });
    },
  );

  return Object.freeze({
    sessionId,
    runId,
    getProjection: () => store.getProjection(),
    subscribe: (listener: HostRunProjectionListener) => store.subscribe(listener),
    submitApprovalDecision(
      candidate: ApprovalDecisionSubmission,
    ): ApprovalSubmissionReceipt {
      const submissionId = readSubmissionId(candidate);
      let submission: ApprovalDecisionSubmission;
      try {
        submission = snapshotApprovalDecisionSubmission(candidate);
      } catch {
        return rejectedApprovalSubmission(submissionId, "approval_submission_invalid");
      }
      if (userApprovalReviewBridge === null || invocationState !== "active") {
        return rejectedApprovalSubmission(submission.submissionId, "approval_not_pending");
      }
      const projection = store.getProjection();
      const approval = projection.approval;
      if (
        projection.status !== "waiting_for_approval" ||
        approval === null ||
        submission.runId !== runId ||
        submission.requestId !== approval.requestId
      ) {
        return rejectedApprovalSubmission(submission.submissionId, "approval_not_pending");
      }
      if (submission.pendingVersion !== approval.pendingVersion) {
        return rejectedApprovalSubmission(submission.submissionId, "approval_version_mismatch");
      }

      const receipt = userApprovalReviewBridge.submitDecision(submission);
      if (receipt.status !== "accepted_for_resolution") return receipt;
      if (approval.phase === "submitted_for_resolution") return receipt;
      const reduction = store.apply({
        kind: "approval_submission_accepted",
        runId,
        sequence: nextSequence(),
        occurredAt: readNow(now),
        receipt,
      });
      if (reduction.status === "rejected") {
        throw new Error(`Host approval submission projection was rejected: ${reduction.code}.`);
      }
      return receipt;
    },
    cancel(cancellationInput: HostRunCancellationInput): HostRunCancellationReceipt {
      const currentCancellation = store.getProjection().cancellation;
      if (invocationState === "settled") {
        return Object.freeze({
          status: "run_settled" as const,
          cancellation: currentCancellation,
        });
      }
      if (invocationState === "start_failed") {
        return Object.freeze({
          status: "start_failed" as const,
          cancellation: currentCancellation,
        });
      }

      const receipt = input.runConfig.cancellation.requestCancellation(cancellationInput);
      const cancellation = toRunCancellationSummary(receipt.request);
      if (!receipt.accepted) {
        return Object.freeze({
          status: "already_requested" as const,
          cancellation,
        });
      }
      const reduction = store.apply({
        kind: "cancellation_accepted",
        runId,
        sequence: nextSequence(),
        occurredAt: cancellation.requestedAt,
        cancellation,
      });
      if (reduction.status === "rejected") {
        throw new Error(`Host cancellation projection was rejected: ${reduction.code}.`);
      }
      return Object.freeze({
        status: "accepted" as const,
        cancellation,
      });
    },
    result,
  });
}

function assertStartInput<TOutput>(input: HostRunStartInput<TOutput>): void {
  if (input === null || typeof input !== "object") {
    throw new TypeError("HostRunStartInput must be an object.");
  }
  assertIdentity(input.sessionId, "sessionId");
  if (input.runInput === null || typeof input.runInput !== "object") {
    throw new TypeError("runInput must be an object.");
  }
  assertIdentity(input.runInput.runId, "runId");
  if (input.runInput.task === null || typeof input.runInput.task !== "object") {
    throw new TypeError("runInput.task must be an object.");
  }
  assertIdentity(input.runInput.task.id, "taskId");
  if (
    !input.runConfig ||
    !input.runConfig.cancellation ||
    input.runConfig.cancellation.context.runId !== input.runInput.runId
  ) {
    throw new TypeError("Run cancellation identity must match the Host Run identity.");
  }
  const enforcement = input.runConfig.permissions?.permissionProfile?.enforcement;
  if (enforcement !== "managed" && enforcement !== "external" && enforcement !== "disabled") {
    throw new TypeError("Run permission enforcement is invalid.");
  }
  assertUserApprovalBinding(input);
}

function assertUserApprovalBinding<TOutput>(input: HostRunStartInput<TOutput>): void {
  const reviewer = input.runConfig.permissions.reviewer;
  const bridge = input.userApprovalReviewBridge ?? null;
  if (reviewer?.kind === "user") {
    if (bridge === null) {
      throw new TypeError("Host user reviewer requires an explicit approval review bridge.");
    }
    if (bridge.runId !== input.runInput.runId) {
      throw new TypeError("Host approval review bridge Run identity does not match the Run.");
    }
    if (reviewer.reviewer !== bridge) {
      throw new TypeError("Host approval review bridge does not match the configured user reviewer.");
    }
    return;
  }
  if (bridge !== null) {
    throw new TypeError("Host Run without a user reviewer must not include an approval review bridge.");
  }
}

function assertRunResultIdentity<TOutput>(
  result: RunResult<TOutput>,
  runId: string,
  taskId: string,
): void {
  if (result.runId !== runId || result.taskId !== taskId) {
    throw new Error("Runner returned a result for a different Host Run.");
  }
}

function readNow(now: () => ISODateTimeString): ISODateTimeString {
  const value = now();
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new TypeError("HostRuntime clock must return a valid date-time string.");
  }
  return value;
}

function assertIdentity(value: string, field: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${field} must be a non-empty string.`);
  }
}

function readSubmissionId(value: unknown): string {
  return typeof value === "object" && value !== null &&
      typeof (value as { submissionId?: unknown }).submissionId === "string"
    ? (value as { submissionId: string }).submissionId
    : "";
}

function rejectedApprovalSubmission(
  submissionId: string,
  code: Extract<ApprovalSubmissionReceipt, { status: "rejected" }>["code"],
): ApprovalSubmissionReceipt {
  return Object.freeze({ status: "rejected", submissionId, code });
}
