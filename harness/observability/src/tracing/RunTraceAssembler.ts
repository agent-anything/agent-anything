
import type {
  RuntimeEvent,
  RuntimeEventPublisher,
} from "../events/RuntimeEvent.js";
import type {
  RuntimeEventName,
  RuntimeEventPayloadMap,
  RuntimeRunItemKind,
  RuntimeTerminalStatus,
} from "../events/RuntimeEventPayload.js";
import {
  RUN_TRACE_SCHEMA_VERSION,
  createControllerTurnTraceOperationId,
  type CompleteRunTraceInput,
  type CreateRunTraceAssemblerInput,
  type RunTrace,
  type RunTraceObserver,
  type TraceIssue,
  type TraceIssueCode,
  type TraceLink,
  type TraceLinkKind,
  type TraceOperationFor,
  type TraceOwner,
  type TraceSpan,
  type RunTraceSpanIdentityInput,
  type TraceSpanStatus,
} from "./RunTrace.js";

type TerminalEventName =
  | "run.completed"
  | "run.blocked"
  | "run.failed"
  | "run.cancelled";

type TerminalRuntimeEvent = RuntimeEvent<TerminalEventName>;
type RunItemAppendedEvent = RuntimeEvent<"run.item.appended">;

interface MutableTraceSpan {
  readonly spanId: string;
  readonly sequence: number;
  parentSpanId: string | null;
  readonly operationId: string;
  readonly owner: TraceOwner;
  readonly operation: string;
  status: TraceSpanStatus;
  code: string | null;
  startedAt: string | null;
  completedAt: string | null;
  readonly links: TraceLink[];
  attributes: Record<string, unknown>;
}

export class RunTraceAssembler implements RuntimeEventPublisher {
  private readonly traceId: string;
  private readonly runId: string;
  private readonly taskId: string;
  private readonly createSpanId: CreateRunTraceAssemblerInput["createSpanId"];
  private readonly observers: readonly RunTraceObserver[];
  private readonly spans: MutableTraceSpan[] = [];
  private readonly spansByOperation = new Map<string, MutableTraceSpan>();
  private readonly issues: TraceIssue[] = [];
  private readonly eventIds = new Set<string>();
  private readonly itemEvents = new Map<string, RunItemAppendedEvent>();
  private readonly root: MutableTraceSpan;
  private terminalEvent: TerminalRuntimeEvent | null = null;
  private lastEventSequence = 0;
  private completed = false;
  private snapshot: RunTrace;

  constructor(input: CreateRunTraceAssemblerInput) {
    this.traceId = text(input.traceId, "RunTrace.traceId");
    this.runId = text(input.runId, "RunTrace.runId");
    this.taskId = text(input.taskId, "RunTrace.taskId");
    if (typeof input.createSpanId !== "function") {
      throw new TypeError("RunTraceAssembler.createSpanId must be a function.");
    }
    this.createSpanId = input.createSpanId;
    this.observers = Object.freeze(uniqueObservers(input.observers ?? []));
    this.root = this.createSpan(
      "runtime",
      "run",
      this.runId,
      null,
      {
        activeAgentId: null,
        terminalCode: null,
        itemCount: null,
        evidenceCount: null,
        artifactCount: null,
        errorCodes: [],
      },
    );
    this.snapshot = this.createSnapshot();
  }

  getSnapshot(): RunTrace {
    return this.snapshot;
  }

  publish(event: RuntimeEvent): void {
    if (this.completed) {
      throw new TypeError("A completed RunTrace cannot accept RuntimeEvents.");
    }
    this.assertEventEnvelope(event);

    if (event.runId !== this.runId) {
      this.rejectInput(
        "run_identity_mismatch",
        event.id,
        operationIdForEvent(event),
        `RuntimeEvent ${event.id} belongs to another Run.`,
      );
    }
    if (event.taskId !== this.taskId) {
      this.rejectInput(
        "task_identity_mismatch",
        event.id,
        operationIdForEvent(event),
        `RuntimeEvent ${event.id} belongs to another Task.`,
      );
    }
    if (event.sequence <= this.lastEventSequence || this.eventIds.has(event.id)) {
      this.rejectInput(
        "event_sequence_regression",
        event.id,
        operationIdForEvent(event),
        `RuntimeEvent ${event.id} regresses the trace event sequence.`,
      );
    }
    if (event.sequence !== this.lastEventSequence + 1) {
      this.addIssue("event_sequence_gap", event.id, operationIdForEvent(event));
    }

    this.lastEventSequence = event.sequence;
    this.eventIds.add(event.id);
    addLink(this.root, "runtime_event", event.id);
    this.applyEvent(event);
    this.publishSnapshot();
  }

  complete(input: CompleteRunTraceInput): RunTrace {
    if (this.completed) {
      throw new TypeError("RunTrace completion can occur only once.");
    }
    assertRecord(input, "CompleteRunTraceInput");
    const result = input.result;
    assertRecord(result, "TerminalRunResultTraceProjection");

    if (result.runId !== this.runId) {
      this.rejectInput(
        "run_identity_mismatch",
        this.runId,
        this.runId,
        "Terminal RunResult projection belongs to another Run.",
      );
    }
    if (result.taskId !== this.taskId) {
      this.rejectInput(
        "task_identity_mismatch",
        this.taskId,
        this.runId,
        "Terminal RunResult projection belongs to another Task.",
      );
    }
    validateTerminalResult(result);
    if (!Array.isArray(input.items)) {
      throw new TypeError("CompleteRunTraceInput.items must be an array.");
    }

    this.correlateCommittedItems(input.items);
    if (result.itemCount !== input.items.length) {
      this.addIssue("terminal_result_mismatch", this.runId, this.runId);
    }

    const terminalEventMatches = this.matchesTerminalEvent(result);
    if (this.terminalEvent === null) {
      this.addIssue("terminal_event_missing", this.runId, this.runId);
    } else if (!terminalEventMatches) {
      this.addIssue(
        "terminal_result_mismatch",
        this.terminalEvent.id,
        this.runId,
      );
    }
    if (this.root.startedAt === null) {
      this.addIssue("operation_start_missing", this.runId, this.runId);
    }

    for (const span of this.spans) {
      if (span === this.root) {
        continue;
      }
      if (span.completedAt === null) {
        span.status = "unknown";
        this.addIssue(
          "operation_settlement_missing",
          null,
          span.operationId,
        );
      }
    }

    this.root.status = result.status;
    this.root.code = result.code;
    this.root.completedAt = terminalEventMatches
      ? this.terminalEvent?.occurredAt ?? null
      : null;
    this.root.attributes = {
      ...this.root.attributes,
      terminalCode: result.code,
      itemCount: result.itemCount,
      evidenceCount: result.evidenceCount,
      artifactCount: result.artifactCount,
      errorCodes: [...result.errorCodes],
    };
    addLink(this.root, "run_result", this.runId);
    this.completed = true;
    this.publishSnapshot();
    return this.snapshot;
  }

  private applyEvent(event: RuntimeEvent): void {
    switch (event.name) {
      case "run.started":
        this.startRoot(event);
        return;
      case "run.item.appended":
        this.recordRunItemEvent(event);
        return;
      case "run.completed":
      case "run.blocked":
      case "run.failed":
      case "run.cancelled":
        this.recordTerminalEvent(event);
        return;
      case "controller.started":
        this.startControllerTurn(event);
        return;
      case "controller.finished":
        this.settleControllerTurn(event);
        return;
      case "action.prepared":
        this.startActionProcessing(event);
        return;
      case "action.assessed":
        this.updateActionAssessment(event);
        return;
      case "action.invalidated":
        this.updateInvalidatedAction(event);
        return;
      case "observation.created":
        this.settleActionProcessing(event);
        return;
      case "approval.requested":
        this.startApprovalReview(event);
        return;
      case "approval.resolved":
        this.settleApprovalReview(event);
        return;
      case "sandbox.attempt.started":
        this.startSandboxAttempt(event);
        return;
      case "sandbox.attempt.resolved":
        this.settleSandboxAttempt(event);
        return;
      case "tool.started":
        this.startToolExecution(event);
        return;
      case "tool.finished":
        this.settleToolExecution(event);
        return;
      case "retry.attempt.started":
        this.startRetryAttempt(event);
        return;
      case "retry.attempt.finished":
        this.settleRetryAttempt(event);
        return;
      case "retry.cancelled":
        this.settleCancelledRetryAttempt(event);
        return;
      default:
        return;
    }
  }

  private startRoot(event: RuntimeEvent<"run.started">): void {
    if (this.root.startedAt !== null) {
      this.addIssue("duplicate_operation_start", event.id, this.runId);
      return;
    }
    this.root.startedAt = event.occurredAt;
    this.root.status = "running";
    this.root.attributes = {
      ...this.root.attributes,
      activeAgentId: event.payload.activeAgentId,
    };
  }

  private recordRunItemEvent(event: RunItemAppendedEvent): void {
    const previous = this.itemEvents.get(event.payload.itemId);
    if (previous !== undefined) {
      this.addIssue("run_item_mismatch", event.id, null);
      return;
    }
    this.itemEvents.set(event.payload.itemId, event);
  }

  private recordTerminalEvent(event: TerminalRuntimeEvent): void {
    if (this.terminalEvent !== null) {
      this.addIssue("duplicate_operation_settlement", event.id, this.runId);
      return;
    }
    this.terminalEvent = event;
  }

  private startControllerTurn(
    event: RuntimeEvent<"controller.started">,
  ): void {
    const operationId = createControllerTurnTraceOperationId(
      event.payload.iteration,
    );
    this.startSpan(
      "controller",
      "turn",
      operationId,
      this.root.spanId,
      event,
      {
        iteration: event.payload.iteration,
        decisionKind: null,
        code: null,
      },
    );
  }

  private settleControllerTurn(
    event: RuntimeEvent<"controller.finished">,
  ): void {
    const operationId = createControllerTurnTraceOperationId(
      event.payload.iteration,
    );
    this.settleSpan(
      "controller",
      "turn",
      operationId,
      this.root.spanId,
      event,
      event.payload.status,
      event.payload.code,
      {
        iteration: event.payload.iteration,
        decisionKind: event.payload.decisionKind,
        code: event.payload.code,
      },
    );
  }

  private startActionProcessing(
    event: RuntimeEvent<"action.prepared">,
  ): void {
    const parentSpanId = this.toolParentSpanId(
      event.payload.actionId,
      event.id,
    );
    const span = this.startSpan(
      "action",
      "processing",
      event.payload.actionId,
      parentSpanId,
      event,
      {
        category: event.payload.category,
        effectCount: event.payload.effectCount,
        targetAssertionCount: event.payload.targetAssertionCount,
        assessmentStatus: null,
        assessmentOwner: null,
        outcomeStatus: null,
        code: null,
      },
    );
    addLink(span, "action", event.payload.actionId);
  }

  private updateActionAssessment(
    event: RuntimeEvent<"action.assessed">,
  ): void {
    const parentSpanId = this.toolParentSpanId(
      event.payload.actionId,
      event.id,
    );
    const span = this.updateSpan(
      "action",
      "processing",
      event.payload.actionId,
      parentSpanId,
      event,
      {
        assessmentStatus: event.payload.status,
        assessmentOwner: event.payload.owner,
        code: event.payload.code,
      },
    );
    addLink(span, "action", event.payload.actionId);
  }

  private updateInvalidatedAction(
    event: RuntimeEvent<"action.invalidated">,
  ): void {
    const parentSpanId = this.toolParentSpanId(
      event.payload.actionId,
      event.id,
    );
    const span = this.updateSpan(
      "action",
      "processing",
      event.payload.actionId,
      parentSpanId,
      event,
      {
        assessmentStatus: "invalidated",
        assessmentOwner: event.payload.owner,
        code: event.payload.code,
      },
    );
    addLink(span, "action", event.payload.actionId);
  }

  private settleActionProcessing(
    event: RuntimeEvent<"observation.created">,
  ): void {
    if (
      this.findSpan(
        "action",
        "processing",
        event.payload.actionId,
      ) === undefined
    ) {
      return;
    }
    const parentSpanId = this.toolParentSpanId(
      event.payload.actionId,
      event.id,
    );
    const span = this.settleSpan(
      "action",
      "processing",
      event.payload.actionId,
      parentSpanId,
      event,
      observationSpanStatus(event.payload.status),
      event.payload.code,
      {
        outcomeStatus: event.payload.status,
        code: event.payload.code,
      },
    );
    addLink(span, "action", event.payload.actionId);
  }

  private startApprovalReview(
    event: RuntimeEvent<"approval.requested">,
  ): void {
    const parentSpanId = this.actionParentSpanId(
      event.payload.actionId,
      event.id,
    );
    const span = this.startSpan(
      "approval",
      "review",
      event.payload.requestId,
      parentSpanId,
      event,
      {
        requestId: event.payload.requestId,
        actionId: event.payload.actionId,
        category: event.payload.category,
        reviewer: event.payload.reviewer,
        decisionKind: null,
        applicationKind: null,
        code: null,
      },
    );
    addLink(span, "approval_request", event.payload.requestId);
    addLink(span, "approval_review_operation", event.payload.reviewOperationId);
    addLink(span, "action", event.payload.actionId);
  }

  private settleApprovalReview(
    event: RuntimeEvent<"approval.resolved">,
  ): void {
    const parentSpanId = this.actionParentSpanId(
      event.payload.actionId,
      event.id,
    );
    const span = this.settleSpan(
      "approval",
      "review",
      event.payload.requestId,
      parentSpanId,
      event,
      approvalSpanStatus(event.payload),
      event.payload.code,
      {
        requestId: event.payload.requestId,
        actionId: event.payload.actionId,
        reviewer: event.payload.reviewer,
        decisionKind: event.payload.decisionKind,
        applicationKind: event.payload.applicationKind,
        code: event.payload.code,
      },
    );
    addLink(span, "approval_request", event.payload.requestId);
    addLink(span, "action", event.payload.actionId);
  }

  private startSandboxAttempt(
    event: RuntimeEvent<"sandbox.attempt.started">,
  ): void {
    const parentSpanId = this.actionParentSpanId(
      event.payload.actionId,
      event.id,
    );
    const span = this.startSpan(
      "sandbox",
      "attempt",
      event.payload.attemptId,
      parentSpanId,
      event,
      {
        actionId: event.payload.actionId,
        ordinal: event.payload.ordinal,
        enforcement: event.payload.enforcement,
        outcome: null,
        code: null,
      },
    );
    addLink(span, "sandbox_attempt", event.payload.attemptId);
    addLink(span, "action", event.payload.actionId);
  }

  private settleSandboxAttempt(
    event: RuntimeEvent<"sandbox.attempt.resolved">,
  ): void {
    const parentSpanId = this.actionParentSpanId(
      event.payload.actionId,
      event.id,
    );
    const span = this.settleSpan(
      "sandbox",
      "attempt",
      event.payload.attemptId,
      parentSpanId,
      event,
      sandboxSpanStatus(event.payload.outcome),
      event.payload.code,
      {
        actionId: event.payload.actionId,
        ordinal: event.payload.ordinal,
        enforcement: event.payload.enforcement,
        outcome: event.payload.outcome,
        code: event.payload.code,
      },
    );
    addLink(span, "sandbox_attempt", event.payload.attemptId);
    addLink(span, "action", event.payload.actionId);
  }

  private startToolExecution(event: RuntimeEvent<"tool.started">): void {
    const operationId = toolOperationId(
      event.payload.actionId,
      event.payload.toolName,
    );
    const span = this.startSpan(
      "tool",
      "execution",
      operationId,
      this.root.spanId,
      event,
      {
        actionId: event.payload.actionId,
        toolName: event.payload.toolName,
        resultStatus: null,
        reportedDurationMs: null,
        code: null,
      },
    );
    addLink(span, "action", event.payload.actionId);
  }

  private settleToolExecution(event: RuntimeEvent<"tool.finished">): void {
    const operationId = toolOperationId(
      event.payload.actionId,
      event.payload.toolName,
    );
    const span = this.settleSpan(
      "tool",
      "execution",
      operationId,
      this.root.spanId,
      event,
      event.payload.status,
      event.payload.code,
      {
        actionId: event.payload.actionId,
        toolName: event.payload.toolName,
        resultStatus: event.payload.toolResultStatus,
        reportedDurationMs: event.payload.durationMs,
        code: event.payload.code,
      },
    );
    addLink(span, "action", event.payload.actionId);
  }

  private startRetryAttempt(
    event: RuntimeEvent<"retry.attempt.started">,
  ): void {
    const span = this.startSpan(
      "retry",
      "attempt",
      event.payload.attemptId,
      this.root.spanId,
      event,
      {
        retryOperationId: event.payload.operationId,
        retryOwner: event.payload.owner,
        attemptNumber: event.payload.attemptNumber,
        budgetAttemptNumber: event.payload.budgetAttemptNumber,
        maxBudgetAttempts: event.payload.maxBudgetAttempts,
        outcome: null,
        reportedDurationMs: null,
        failureCategory: null,
        failureCode: null,
      },
    );
    addLink(span, "retry_operation", event.payload.operationId);
  }

  private settleRetryAttempt(
    event: RuntimeEvent<"retry.attempt.finished">,
  ): void {
    const span = this.settleSpan(
      "retry",
      "attempt",
      event.payload.attemptId,
      this.root.spanId,
      event,
      event.payload.outcome,
      event.payload.failureCode,
      {
        retryOperationId: event.payload.operationId,
        retryOwner: event.payload.owner,
        attemptNumber: event.payload.attemptNumber,
        budgetAttemptNumber: event.payload.budgetAttemptNumber,
        outcome: event.payload.outcome,
        reportedDurationMs: event.payload.durationMs,
        failureCategory: event.payload.failureCategory,
        failureCode: event.payload.failureCode,
      },
    );
    addLink(span, "retry_operation", event.payload.operationId);
  }

  private settleCancelledRetryAttempt(
    event: RuntimeEvent<"retry.cancelled">,
  ): void {
    if (event.payload.attemptId === null) {
      return;
    }
    const span = this.settleSpan(
      "retry",
      "attempt",
      event.payload.attemptId,
      this.root.spanId,
      event,
      "cancelled",
      null,
      {
        retryOperationId: event.payload.operationId,
        retryOwner: event.payload.owner,
        attemptNumber: event.payload.attemptNumber,
        outcome: "cancelled",
      },
    );
    addLink(span, "retry_operation", event.payload.operationId);
  }

  private startSpan<TOwner extends TraceOwner>(
    owner: TOwner,
    operation: TraceOperationFor<TOwner>,
    operationId: string,
    parentSpanId: string | null,
    event: RuntimeEvent,
    attributes: Record<string, unknown>,
  ): MutableTraceSpan {
    const existing = this.findSpan(owner, operation, operationId);
    if (existing !== undefined) {
      this.addIssue("duplicate_operation_start", event.id, operationId);
      return existing;
    }
    const span = this.createSpan(
      owner,
      operation,
      operationId,
      parentSpanId,
      attributes,
    );
    span.status = "running";
    span.startedAt = event.occurredAt;
    addLink(span, "runtime_event", event.id);
    return span;
  }

  private settleSpan<TOwner extends TraceOwner>(
    owner: TOwner,
    operation: TraceOperationFor<TOwner>,
    operationId: string,
    parentSpanId: string | null,
    event: RuntimeEvent,
    status: Exclude<TraceSpanStatus, "running" | "unknown">,
    code: string | null,
    attributes: Record<string, unknown>,
  ): MutableTraceSpan {
    let span = this.findSpan(owner, operation, operationId);
    if (span === undefined) {
      span = this.createSpan(
        owner,
        operation,
        operationId,
        parentSpanId,
        attributes,
      );
      span.status = "unknown";
      span.code = code;
      span.completedAt = event.occurredAt;
      addLink(span, "runtime_event", event.id);
      this.addIssue("operation_start_missing", event.id, operationId);
      return span;
    }
    if (span.completedAt !== null) {
      this.addIssue("duplicate_operation_settlement", event.id, operationId);
      return span;
    }
    span.status = status;
    span.code = code;
    span.completedAt = event.occurredAt;
    span.attributes = { ...span.attributes, ...attributes };
    addLink(span, "runtime_event", event.id);
    return span;
  }

  private updateSpan<TOwner extends TraceOwner>(
    owner: TOwner,
    operation: TraceOperationFor<TOwner>,
    operationId: string,
    parentSpanId: string | null,
    event: RuntimeEvent,
    attributes: Record<string, unknown>,
  ): MutableTraceSpan {
    let span = this.findSpan(owner, operation, operationId);
    if (span === undefined) {
      span = this.createSpan(
        owner,
        operation,
        operationId,
        parentSpanId,
        attributes,
      );
      span.status = "unknown";
      this.addIssue("operation_start_missing", event.id, operationId);
    } else if (span.completedAt !== null) {
      this.addIssue("duplicate_operation_settlement", event.id, operationId);
      return span;
    } else {
      span.attributes = { ...span.attributes, ...attributes };
    }
    addLink(span, "runtime_event", event.id);
    return span;
  }

  private toolParentSpanId(actionId: string, sourceId: string): string | null {
    const parent = this.spans.find(
      (span) =>
        span.owner === "tool" &&
        span.operation === "execution" &&
        span.attributes.actionId === actionId,
    );
    if (parent !== undefined) {
      return parent.spanId;
    }
    this.addIssue("parent_operation_missing", sourceId, actionId);
    return null;
  }

  private actionParentSpanId(actionId: string, sourceId: string): string | null {
    const parent = this.findSpan("action", "processing", actionId);
    if (parent !== undefined) {
      return parent.spanId;
    }
    this.addIssue("parent_operation_missing", sourceId, actionId);
    return null;
  }

  private createSpan<TOwner extends TraceOwner>(
    owner: TOwner,
    operation: TraceOperationFor<TOwner>,
    operationId: string,
    parentSpanId: string | null,
    attributes: Record<string, unknown>,
  ): MutableTraceSpan {
    const sequence = this.spans.length + 1;
    const spanId = text(this.createSpanId({
      runId: this.runId,
      sequence,
      owner,
      operation,
      operationId,
    } as RunTraceSpanIdentityInput), "TraceSpan.spanId");
    if (this.spans.some((span) => span.spanId === spanId)) {
      throw new TypeError(`TraceSpan identity '${spanId}' is duplicated.`);
    }
    const span: MutableTraceSpan = {
      spanId,
      sequence,
      parentSpanId,
      operationId: text(operationId, "TraceSpan.operationId"),
      owner,
      operation,
      status: "unknown",
      code: null,
      startedAt: null,
      completedAt: null,
      links: [],
      attributes: {
        ...defaultAttributes(owner, operation),
        ...attributes,
      },
    };
    this.spans.push(span);
    this.spansByOperation.set(operationKey(owner, operation, operationId), span);
    return span;
  }

  private findSpan<TOwner extends TraceOwner>(
    owner: TOwner,
    operation: TraceOperationFor<TOwner>,
    operationId: string,
  ): MutableTraceSpan | undefined {
    return this.spansByOperation.get(operationKey(owner, operation, operationId));
  }

  private correlateCommittedItems(
    items: CompleteRunTraceInput["items"],
  ): void {
    const projectedIds = new Set<string>();
    let previousSequence = 0;
    for (const item of items) {
      validateCommittedItem(item);
      if (
        item.runId !== this.runId ||
        item.sequence <= previousSequence ||
        projectedIds.has(item.id)
      ) {
        this.addIssue("run_item_mismatch", item.id, null);
      }
      previousSequence = item.sequence;
      projectedIds.add(item.id);
      addLink(this.root, "run_item", item.id);

      const event = this.itemEvents.get(item.id);
      if (event === undefined) {
        this.addIssue("run_item_event_missing", item.id, null);
        continue;
      }
      if (
        event.payload.itemKind !== item.kind ||
        event.payload.itemSequence !== item.sequence
      ) {
        this.addIssue("run_item_mismatch", item.id, null);
      }
    }
    for (const [itemId, event] of this.itemEvents) {
      if (!projectedIds.has(itemId)) {
        this.addIssue("run_item_projection_missing", event.id, null);
      }
    }
  }

  private matchesTerminalEvent(
    result: CompleteRunTraceInput["result"],
  ): boolean {
    const event = this.terminalEvent;
    if (event === null || terminalStatus(event.name) !== result.status) {
      return false;
    }
    return event.payload.code === result.code &&
      event.payload.itemCount === result.itemCount &&
      event.payload.evidenceCount === result.evidenceCount &&
      event.payload.artifactCount === result.artifactCount &&
      stringArraysEqual(event.payload.errorCodes, result.errorCodes);
  }

  private assertEventEnvelope(event: RuntimeEvent): void {
    assertRecord(event, "RuntimeEvent");
    text(event.id, "RuntimeEvent.id");
    text(event.runId, "RuntimeEvent.runId");
    text(event.taskId, "RuntimeEvent.taskId");
    dateTime(event.occurredAt, "RuntimeEvent.occurredAt");
    if (!Number.isSafeInteger(event.sequence) || event.sequence < 1) {
      throw new TypeError("RuntimeEvent.sequence must be a positive integer.");
    }
  }

  private rejectInput(
    code: TraceIssueCode,
    sourceId: string | null,
    operationId: string | null,
    message: string,
  ): never {
    this.addIssue(code, sourceId, operationId);
    this.publishSnapshot();
    throw new TypeError(message);
  }

  private addIssue(
    code: TraceIssueCode,
    sourceId: string | null,
    operationId: string | null,
  ): void {
    if (
      this.issues.some((issue) =>
        issue.code === code &&
        issue.sourceId === sourceId &&
        issue.operationId === operationId
      )
    ) {
      return;
    }
    this.issues.push({ code, sourceId, operationId });
  }

  private publishSnapshot(): void {
    this.snapshot = this.createSnapshot();
    for (const observer of this.observers) {
      const snapshot = this.snapshot;
      void Promise.resolve()
        .then(() => observer.observe(snapshot))
        .catch(() => undefined);
    }
  }

  private createSnapshot(): RunTrace {
    const spans = Object.freeze(this.spans.map(snapshotSpan));
    const issues = Object.freeze(this.issues.map((issue) => Object.freeze({
      code: issue.code,
      sourceId: issue.sourceId,
      operationId: issue.operationId,
    })));
    const status = this.completed
      ? issues.length === 0 ? "complete" : "incomplete"
      : issues.length === 0 ? "active" : "incomplete";
    return Object.freeze({
      schemaVersion: RUN_TRACE_SCHEMA_VERSION,
      traceId: this.traceId,
      runId: this.runId,
      taskId: this.taskId,
      status,
      rootSpanId: this.root.spanId,
      startedAt: this.root.startedAt,
      completedAt: this.completed ? this.root.completedAt : null,
      spans,
      issues,
    });
  }
}

function snapshotSpan(span: MutableTraceSpan): TraceSpan {
  return Object.freeze({
    spanId: span.spanId,
    sequence: span.sequence,
    parentSpanId: span.parentSpanId,
    operationId: span.operationId,
    owner: span.owner,
    operation: span.operation,
    status: span.status,
    code: span.code,
    startedAt: span.startedAt,
    completedAt: span.completedAt,
    links: Object.freeze(span.links.map((link) => Object.freeze({ ...link }))),
    attributes: snapshotObject(span.attributes),
  }) as unknown as TraceSpan;
}

function defaultAttributes<TOwner extends TraceOwner>(
  owner: TOwner,
  operation: TraceOperationFor<TOwner>,
): Record<string, unknown> {
  if (owner === "runtime" && operation === "run") {
    return {
      activeAgentId: null,
      terminalCode: null,
      itemCount: null,
      evidenceCount: null,
      artifactCount: null,
      errorCodes: [],
    };
  }
  if (owner === "controller" && operation === "turn") {
    return { decisionKind: null, code: null };
  }
  if (owner === "action" && operation === "processing") {
    return {
      category: null,
      effectCount: null,
      targetAssertionCount: null,
      assessmentStatus: null,
      assessmentOwner: null,
      outcomeStatus: null,
      code: null,
    };
  }
  if (owner === "approval" && operation === "review") {
    return {
      category: null,
      reviewer: null,
      decisionKind: null,
      applicationKind: null,
      code: null,
    };
  }
  if (owner === "sandbox" && operation === "attempt") {
    return { outcome: null, code: null };
  }
  if (owner === "tool" && operation === "execution") {
    return {
      resultStatus: null,
      reportedDurationMs: null,
      code: null,
    };
  }
  if (owner === "retry" && operation === "attempt") {
    return {
      attemptNumber: null,
      budgetAttemptNumber: null,
      maxBudgetAttempts: null,
      outcome: null,
      reportedDurationMs: null,
      failureCategory: null,
      failureCode: null,
    };
  }
  return {};
}

function snapshotObject(source: Record<string, unknown>): Readonly<Record<string, unknown>> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    result[key] = Array.isArray(value)
      ? Object.freeze([...value])
      : value;
  }
  return Object.freeze(result);
}

function addLink(
  span: MutableTraceSpan,
  kind: TraceLinkKind,
  id: string,
): void {
  text(id, "TraceLink.id");
  if (!span.links.some((link) => link.kind === kind && link.id === id)) {
    span.links.push({ kind, id });
  }
}

function operationKey(
  owner: TraceOwner,
  operation: string,
  operationId: string,
): string {
  return `${owner}\u0000${operation}\u0000${operationId}`;
}

function operationIdForEvent(event: RuntimeEvent): string | null {
  switch (event.name) {
    case "run.started":
    case "run.completed":
    case "run.blocked":
    case "run.failed":
    case "run.cancelled":
      return event.runId;
    case "controller.started":
    case "controller.finished":
      return Number.isSafeInteger(event.payload.iteration)
        ? `controller-turn:${event.payload.iteration}`
        : null;
    case "action.prepared":
    case "action.assessed":
    case "action.invalidated":
    case "approval.requested":
    case "approval.resolved":
    case "sandbox.attempt.started":
    case "sandbox.attempt.resolved":
    case "sandbox.escalation.proposed":
    case "tool.started":
    case "tool.finished":
    case "observation.created":
    case "evidence.created":
      return event.payload.actionId;
    case "retry.attempt.started":
    case "retry.attempt.finished":
      return event.payload.attemptId;
    case "retry.cancelled":
      return event.payload.attemptId;
    case "retry.scheduled":
    case "retry.fallback.selected":
    case "retry.exhausted":
      return event.payload.operationId;
    default:
      return null;
  }
}

function observationSpanStatus(
  status: RuntimeEventPayloadMap["observation.created"]["status"],
): Exclude<TraceSpanStatus, "running" | "unknown"> {
  switch (status) {
    case "succeeded":
    case "partial":
    case "granted":
    case "updated":
      return "succeeded";
    case "denied":
    case "rejected":
    case "declined":
    case "limit_reached":
      return "blocked";
    case "timeout":
    case "failed":
      return "failed";
  }
}

function approvalSpanStatus(
  payload: RuntimeEventPayloadMap["approval.resolved"],
): Exclude<TraceSpanStatus, "running" | "unknown"> {
  if (
    payload.resolutionKind === "review_failure" ||
    payload.resolutionKind === "request_failure"
  ) {
    return "failed";
  }
  if (
    payload.resolutionKind === "run_cancelled" ||
    payload.decisionKind === "cancel"
  ) {
    return "cancelled";
  }
  return payload.decisionKind === "decline" ? "blocked" : "succeeded";
}

function sandboxSpanStatus(
  outcome: RuntimeEventPayloadMap["sandbox.attempt.resolved"]["outcome"],
): Exclude<TraceSpanStatus, "running" | "unknown"> {
  switch (outcome) {
    case "executed":
      return "succeeded";
    case "sandbox_denied":
    case "sandbox_unavailable":
      return "blocked";
    case "interrupted":
      return "cancelled";
    case "failed":
      return "failed";
  }
}

function toolOperationId(actionId: string, toolName: string): string {
  return `tool-execution:${text(actionId, "Tool actionId")}:${text(toolName, "Tool name")}`;
}

function terminalStatus(name: TerminalEventName): RuntimeTerminalStatus {
  switch (name) {
    case "run.completed":
      return "succeeded";
    case "run.blocked":
      return "blocked";
    case "run.failed":
      return "failed";
    case "run.cancelled":
      return "cancelled";
  }
}

function validateCommittedItem(
  item: CompleteRunTraceInput["items"][number],
): void {
  assertRecord(item, "CommittedRunItemTraceProjection");
  text(item.id, "CommittedRunItemTraceProjection.id");
  text(item.runId, "CommittedRunItemTraceProjection.runId");
  dateTime(item.createdAt, "CommittedRunItemTraceProjection.createdAt");
  if (!Number.isSafeInteger(item.sequence) || item.sequence < 1) {
    throw new TypeError(
      "CommittedRunItemTraceProjection.sequence must be a positive integer.",
    );
  }
  if (!runtimeRunItemKinds.has(item.kind)) {
    throw new TypeError("CommittedRunItemTraceProjection.kind is invalid.");
  }
}

function validateTerminalResult(
  result: CompleteRunTraceInput["result"],
): void {
  text(result.runId, "TerminalRunResultTraceProjection.runId");
  text(result.taskId, "TerminalRunResultTraceProjection.taskId");
  if (!terminalStatuses.has(result.status)) {
    throw new TypeError("TerminalRunResultTraceProjection.status is invalid.");
  }
  if (
    result.status === "succeeded"
      ? result.code !== null
      : typeof result.code !== "string" || result.code.trim().length === 0
  ) {
    throw new TypeError(
      "TerminalRunResultTraceProjection.code contradicts its status.",
    );
  }
  for (const [field, value] of [
    ["itemCount", result.itemCount],
    ["evidenceCount", result.evidenceCount],
    ["artifactCount", result.artifactCount],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new TypeError(
        `TerminalRunResultTraceProjection.${field} must be a non-negative integer.`,
      );
    }
  }
  if (
    !Array.isArray(result.errorCodes) ||
    !result.errorCodes.every((code) =>
      typeof code === "string" && code.trim().length > 0
    )
  ) {
    throw new TypeError(
      "TerminalRunResultTraceProjection.errorCodes must contain non-empty strings.",
    );
  }
}

function uniqueObservers(
  candidates: readonly RunTraceObserver[],
): RunTraceObserver[] {
  const observers: RunTraceObserver[] = [];
  for (const candidate of candidates) {
    if (
      typeof candidate !== "object" ||
      candidate === null ||
      typeof candidate.observe !== "function"
    ) {
      throw new TypeError("RunTrace observer must implement observe(trace).");
    }
    if (!observers.includes(candidate)) {
      observers.push(candidate);
    }
  }
  return observers;
}

function stringArraysEqual(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return left.length === right.length &&
    left.every((value, index) => value === right[index]);
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${field} must be a non-empty string.`);
  }
  return value;
}

function dateTime(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw new TypeError(`${field} must be an ISO date-time string.`);
  }
  return value;
}

function assertRecord(
  value: unknown,
  field: string,
): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object.`);
  }
}

const terminalStatuses = new Set<RuntimeTerminalStatus>([
  "succeeded",
  "blocked",
  "failed",
  "cancelled",
]);

const runtimeRunItemKinds = new Set<RuntimeRunItemKind>([
  "model_output",
  "action",
  "observation",
  "plan_created",
  "plan_updated",
  "plan_completed",
  "plan_abandoned",
  "final_output",
  "stop",
  "run_cancellation_requested",
  "run_blocked",
  "run_failed",
  "run_cancelled",
  "approval_requested",
  "approval_resolved",
  "action_prepared",
  "action_assessed",
  "action_invalidated",
  "sandbox_attempt_started",
  "sandbox_attempt_resolved",
  "sandbox_escalation_proposed",
  "retry_attempt_started",
  "retry_attempt_finished",
  "retry_scheduled",
  "retry_fallback_selected",
  "retry_exhausted",
  "retry_cancelled",
]);
