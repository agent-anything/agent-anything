import { createHash } from "node:crypto";
import type { Agent } from "@agent-anything/agent-core/agent";
import type { RunInput } from "@agent-anything/agent-core/input";
import type {
  InteractionSubmissionOutcome,
} from "@agent-anything/interaction/coordination";
import {
  snapshotInteractionRequestRef,
  type InteractionRequestRef,
} from "@agent-anything/interaction/protocol";
import type { ActionExecutionObserver } from "@agent-anything/action-execution/enforcement";
import type { RuntimeEvent, RuntimeEventPublisher } from "@agent-anything/observability/events";
import {
  toRunCancellationSummary,
  type RunCancellationRequestInput,
  type RunResult,
} from "@agent-anything/agent-runtime/run";
import type {
  RootRunConfig,
  RunHandle,
  Runner,
} from "@agent-anything/agent-runtime/runner";
import type {
  RunSteeringAttribution,
  RunSteeringSubmissionReceipt,
} from "@agent-anything/agent-runtime/run";
import {
  createHostRunProjection,
  createHostTerminalRunProjection,
  type HostCancellationProjection,
  type HostRunProjection,
  type HostRunProjectionListener,
  type HostRunProjectionListenerFailure,
  type HostTerminalRunProjection,
} from "../projection/HostRunProjection.js";
import { createHostRunProjectionStore } from "../projection/HostRunProjectionReducer.js";

export type HostSessionId = string;

export interface HostRunStartInput<TOutput = unknown> {
  readonly sessionId: HostSessionId;
  readonly agent: Agent<TOutput>;
  readonly runInput: RunInput;
  readonly runConfig: RootRunConfig;
}

export interface HostRunResult<TOutput = unknown> {
  readonly kind: "run_result";
  readonly sessionId: HostSessionId;
  readonly taskId: string;
  readonly runId: string;
  readonly runResult: RunResult<TOutput>;
  readonly terminal: HostTerminalRunProjection;
}

export type HostRunCancellationInput = RunCancellationRequestInput;

export interface HostRunSteeringInput {
  readonly commandId: string;
  readonly expectedRunRevision: number;
  readonly instruction: string;
  readonly attribution: RunSteeringAttribution;
}

export type HostRunSteeringReceipt = RunSteeringSubmissionReceipt;
export type HostRunStatusProjection = HostRunProjection;

export interface HostInteractionSubmission {
  readonly request: InteractionRequestRef;
  readonly submissionId: string;
  readonly payload: unknown;
}

export type HostRunCancellationReceipt =
  | { readonly status: "accepted"; readonly cancellation: HostCancellationProjection }
  | { readonly status: "already_requested"; readonly cancellation: HostCancellationProjection }
  | { readonly status: "run_settled"; readonly cancellation: HostCancellationProjection | null };

export interface HostActiveRun<TOutput = unknown> {
  readonly sessionId: HostSessionId;
  readonly runId: string;
  getProjection(): HostRunProjection;
  subscribe(listener: HostRunProjectionListener): () => void;
  submitInteraction(input: HostInteractionSubmission): InteractionSubmissionOutcome;
  steer(input: HostRunSteeringInput): HostRunSteeringReceipt;
  cancel(input: HostRunCancellationInput): HostRunCancellationReceipt;
  getStatus(): HostRunStatusProjection;
  wait(): Promise<HostRunResult<TOutput>>;
  getResult(): HostRunResult<TOutput> | null;
}

export interface HostRunManager {
  start<TOutput>(input: HostRunStartInput<TOutput>): HostActiveRun<TOutput>;
  getRun(runId: string): HostActiveRun | null;
  listRuns(): readonly HostRunRegistryEntry[];
  releaseRun(runId: string): HostRunReleaseReceipt;
}

export interface HostRunRegistryEntry {
  readonly runId: string;
  readonly sessionId: HostSessionId;
  readonly lifecycle: "active" | "settled";
}

export type HostRunReleaseReceipt =
  | { readonly status: "released"; readonly runId: string }
  | { readonly status: "run_active"; readonly runId: string }
  | { readonly status: "not_found"; readonly runId: string };

interface HostRunRegistration<TOutput> {
  readonly activeRun: HostActiveRun<TOutput>;
  release(): void;
}

export interface CreateHostRunManagerInput {
  readonly runner: Runner;
  readonly terminalRetentionLimit?: number;
  readonly now?: () => string;
  readonly onProjectionListenerFailure?: (
    failure: HostRunProjectionListenerFailure,
  ) => void;
}

type HostInvocationState = "active" | "settled";

export function createHostRunManager(input: CreateHostRunManagerInput): HostRunManager {
  if (!input.runner || typeof input.runner.start !== "function") {
    throw new TypeError("HostRunManager requires a Runner.");
  }
  const terminalRetentionLimit = input.terminalRetentionLimit ?? 32;
  if (!Number.isSafeInteger(terminalRetentionLimit) || terminalRetentionLimit < 0) {
    throw new TypeError("HostRunManager terminalRetentionLimit must be a non-negative integer.");
  }
  const now = input.now ?? (() => new Date().toISOString());
  const registry = new HostRunRegistry(terminalRetentionLimit);
  return Object.freeze({
    start<TOutput>(startInput: HostRunStartInput<TOutput>): HostActiveRun<TOutput> {
      const registration = startHostRun(
        input.runner,
        now,
        startInput,
        input.onProjectionListenerFailure,
      );
      registry.admit(registration);
      return registration.activeRun;
    },
    getRun: (runId: string) => registry.get(runId),
    listRuns: () => registry.list(),
    releaseRun: (runId: string) => registry.release(runId),
  });
}

function startHostRun<TOutput>(
  runner: Runner,
  now: () => string,
  input: HostRunStartInput<TOutput>,
  onListenerFailure: CreateHostRunManagerInput["onProjectionListenerFailure"],
): HostRunRegistration<TOutput> {
  assertStartInput(input);
  const sessionId = input.sessionId;
  const taskId = input.runInput.task.id;
  const startedAt = readNow(now);
  let hostSequence = 0;
  let invocationState: HostInvocationState = "active";
  let runId = "";
  let store: ReturnType<typeof createHostRunProjectionStore>;

  const nextSequence = (): number => ++hostSequence;
  const runtimeEventPublisher: RuntimeEventPublisher = Object.freeze({
    publish(event: RuntimeEvent) {
      if (invocationState !== "active") return;
      applyRequired(store, {
        kind: "runtime_event",
        runId,
        sequence: nextSequence(),
        occurredAt: event.occurredAt,
        event,
      }, "RuntimeEvent");
    },
  });
  const actionExecutionObserver: ActionExecutionObserver = Object.freeze({
    observe(
      notification: Parameters<ActionExecutionObserver["observe"]>[0],
    ) {
      if (invocationState !== "active") return;
      applyRequired(store, {
        kind: "action_execution",
        runId,
        sequence: nextSequence(),
        occurredAt: notification.occurredAt,
        notification,
      }, "Action execution");
    },
  });
  const handle: RunHandle<TOutput> = runner.start(
    input.agent,
    input.runInput,
    input.runConfig,
    { runtimeEventPublisher, actionExecutionObserver },
  );
  runId = handle.runId;
  store = createHostRunProjectionStore({
    initial: createHostRunProjection({
      sessionId,
      taskId,
      runId,
      startedAt,
      enforcement: input.runConfig.permissions.permissionProfile.enforcement,
    }),
    ...(onListenerFailure === undefined ? {} : { onListenerFailure }),
  });
  const unsubscribeHandle = handle.subscribe((snapshot) => {
    if (invocationState !== "active") return;
    applyRequired(store, {
      kind: "run_operation",
      runId,
      sequence: nextSequence(),
      occurredAt: readNow(now),
      snapshot,
    }, "Run operation");
  });

  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    unsubscribeHandle();
  };
  let terminalResult: HostRunResult<TOutput> | null = null;
  const waitForResult = handle.wait().then<HostRunResult<TOutput>>((runResult) => {
    assertRunResultIdentity(runResult, runId, taskId);
    const terminal = createHostTerminalRunProjection({
      runResult,
      completedAt: readNow(now),
    });
    applyRequired(store, {
      kind: "terminal_result",
      runId,
      sequence: nextSequence(),
      occurredAt: terminal.completedAt,
      terminal,
    }, "terminal");
    terminalResult = Object.freeze({
      kind: "run_result" as const,
      sessionId,
      taskId,
      runId,
      runResult,
      terminal,
    });
    return terminalResult;
  }).finally(() => {
    invocationState = "settled";
    release();
  });

  const activeRun: HostActiveRun<TOutput> = Object.freeze({
    sessionId,
    runId,
    getProjection: () => store.getProjection(),
    subscribe: (listener: HostRunProjectionListener) => store.subscribe(listener),
    getStatus: () => store.getProjection(),
    submitInteraction(candidate: HostInteractionSubmission): InteractionSubmissionOutcome {
      if (invocationState !== "active") {
        return Object.freeze({ status: "rejected", code: "run_settled", receipt: null });
      }
      let submission: Parameters<RunHandle["submitInteraction"]>[0];
      try {
        const request = snapshotInteractionRequestRef(candidate.request);
        const submissionId = identity(candidate.submissionId, "Interaction submissionId");
        const payload = snapshotUnknown(candidate.payload);
        submission = Object.freeze({
          request,
          submissionId,
          contentDigest: canonicalDigest(payload),
          payload,
          receivedAt: readNow(now),
        });
      } catch {
        return Object.freeze({
          status: "rejected",
          code: "interaction_submission_invalid",
          receipt: null,
        });
      }
      const outcome = handle.submitInteraction(submission);
      if (outcome.status === "accepted_for_resolution" || outcome.status === "duplicate_identical") {
        applyRequired(store, {
          kind: "interaction_submission_accepted",
          runId,
          sequence: nextSequence(),
          occurredAt: outcome.receipt.recordedAt,
          receipt: outcome.receipt,
        }, "Interaction submission");
      }
      return outcome;
    },
    steer(candidate: HostRunSteeringInput): HostRunSteeringReceipt {
      const projection = store.getProjection();
      if (invocationState !== "active") {
        return Object.freeze({
          status: "rejected" as const,
          code: "run_settled" as const,
          run: Object.freeze({ id: runId }),
          commandId: typeof candidate?.commandId === "string" ? candidate.commandId : "",
          currentRunRevision: projection.runRevision,
        });
      }
      try {
        return handle.steer({
          commandId: identity(candidate.commandId, "Steering commandId"),
          expectedRunRevision: candidate.expectedRunRevision,
          instruction: candidate.instruction,
          attribution: candidate.attribution,
          submittedAt: readNow(now),
        });
      } catch {
        return Object.freeze({
          status: "rejected" as const,
          code: "steering_invalid" as const,
          run: Object.freeze({ id: runId }),
          commandId: typeof candidate?.commandId === "string" ? candidate.commandId : "",
          currentRunRevision: projection.runRevision,
        });
      }
    },
    cancel(cancellationInput: HostRunCancellationInput): HostRunCancellationReceipt {
      const currentCancellation = store.getProjection().cancellation;
      if (invocationState === "settled") {
        return Object.freeze({ status: "run_settled", cancellation: currentCancellation });
      }
      const receipt = handle.cancel(cancellationInput);
      const cancellation = toRunCancellationSummary(receipt.request);
      if (receipt.status === "run_settled") {
        return Object.freeze({ status: "run_settled", cancellation: currentCancellation });
      }
      if (receipt.status === "already_requested") {
        return Object.freeze({ status: "already_requested", cancellation });
      }
      applyRequired(store, {
        kind: "cancellation_accepted",
        runId,
        sequence: nextSequence(),
        occurredAt: cancellation.requestedAt,
        cancellation,
      }, "cancellation");
      return Object.freeze({ status: "accepted", cancellation });
    },
    wait: () => waitForResult,
    getResult: () => terminalResult,
  });
  return Object.freeze({ activeRun, release });
}

interface HostRunRegistryRecord {
  readonly activeRun: HostActiveRun;
  readonly release: () => void;
  lifecycle: "active" | "settled";
}

class HostRunRegistry {
  private readonly records = new Map<string, HostRunRegistryRecord>();
  private readonly terminalOrder: string[] = [];
  constructor(private readonly terminalRetentionLimit: number) {}

  admit<TOutput>(registration: HostRunRegistration<TOutput>): void {
    const activeRun = registration.activeRun;
    if (this.records.has(activeRun.runId)) {
      activeRun.cancel({ origin: "host", reasonCode: "host_requested", reason: "Duplicate Host Run identity." });
      registration.release();
      throw new Error(`Host Run '${activeRun.runId}' is already registered.`);
    }
    this.records.set(activeRun.runId, {
      activeRun,
      release: registration.release,
      lifecycle: "active",
    });
    void activeRun.wait().then(
      () => this.markSettled(activeRun.runId),
      () => this.markSettled(activeRun.runId),
    );
  }

  get(runId: string): HostActiveRun | null {
    assertIdentity(runId, "runId");
    return this.records.get(runId)?.activeRun ?? null;
  }

  list(): readonly HostRunRegistryEntry[] {
    return Object.freeze([...this.records.values()].map((record) => Object.freeze({
      runId: record.activeRun.runId,
      sessionId: record.activeRun.sessionId,
      lifecycle: record.lifecycle,
    })));
  }

  release(runId: string): HostRunReleaseReceipt {
    assertIdentity(runId, "runId");
    const record = this.records.get(runId);
    if (record === undefined) return Object.freeze({ status: "not_found", runId });
    if (record.lifecycle === "active") return Object.freeze({ status: "run_active", runId });
    this.evict(runId, record);
    return Object.freeze({ status: "released", runId });
  }

  private markSettled(runId: string): void {
    const record = this.records.get(runId);
    if (record === undefined || record.lifecycle === "settled") return;
    record.lifecycle = "settled";
    this.terminalOrder.push(runId);
    while (this.terminalOrder.length > this.terminalRetentionLimit) {
      const evictedId = this.terminalOrder.shift();
      if (evictedId === undefined) break;
      const evicted = this.records.get(evictedId);
      if (evicted !== undefined && evicted.lifecycle === "settled") this.evict(evictedId, evicted);
    }
  }

  private evict(runId: string, record: HostRunRegistryRecord): void {
    this.records.delete(runId);
    const index = this.terminalOrder.indexOf(runId);
    if (index >= 0) this.terminalOrder.splice(index, 1);
    record.release();
  }
}

function applyRequired(
  store: ReturnType<typeof createHostRunProjectionStore>,
  update: Parameters<ReturnType<typeof createHostRunProjectionStore>["apply"]>[0],
  source: string,
): void {
  const reduction = store.apply(update);
  if (reduction.status === "rejected") {
    throw new Error(`${source} Host projection was rejected: ${reduction.code}.`);
  }
}

function assertStartInput<TOutput>(input: HostRunStartInput<TOutput>): void {
  if (input === null || typeof input !== "object") throw new TypeError("HostRunStartInput must be an object.");
  assertIdentity(input.sessionId, "sessionId");
  if (input.runInput === null || typeof input.runInput !== "object") throw new TypeError("runInput must be an object.");
  assertIdentity(input.runInput.task?.id, "taskId");
  if (!input.runConfig || typeof input.runConfig !== "object") throw new TypeError("runConfig must be an object.");
}

function assertRunResultIdentity<TOutput>(result: RunResult<TOutput>, runId: string, taskId: string): void {
  if (result.runId !== runId || result.taskId !== taskId) {
    throw new Error("Runner returned a result for a different Host Run.");
  }
}

function readNow(now: () => string): string {
  const value = now();
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new TypeError("HostRunManager clock must return a valid date-time string.");
  }
  return value;
}

function assertIdentity(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${field} must be a non-empty string.`);
  }
}

function identity(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0 || /\s/.test(value)) {
    throw new TypeError(`${field} must be a non-empty identity.`);
  }
  return value;
}

function snapshotUnknown<T>(value: T): T {
  return deepFreeze(structuredClone(value));
}

function canonicalDigest(value: unknown): string {
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(canonicalValue(value)), "utf8")
    .digest("hex")}`;
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalValue(child)]),
    );
  }
  if (
    value === null || typeof value === "string" || typeof value === "boolean" ||
    typeof value === "number" && Number.isFinite(value)
  ) return value;
  throw new TypeError("Interaction payload is not canonical data.");
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}
