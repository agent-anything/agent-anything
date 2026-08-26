import type { RuntimeEvent, RuntimeEventPublisher } from "../events/index.js";
import { snapshotRunLineage } from "../events/snapshotRunLineage.js";
import type { RunLineage } from "@agent-anything/agent-core/run-tree";
import { RUN_TRACE_SCHEMA_VERSION, createControllerTurnTraceOperationId, type CommittedRunItemTraceProjection, type CompleteRunTraceInput, type ContextProjectionTraceRecord, type ContextTransitionTraceRecord, type CreateRunTraceAssemblerInput, type RunTrace, type TraceIssue, type TraceIssueCode, type TraceLink, type TraceSpan, type TraceSpanStatus } from "./RunTrace.js";

interface MutableSpan {
  spanId: string;
  sequence: number;
  parentSpanId: string | null;
  operationId: string;
  owner: TraceSpan["owner"];
  operation: TraceSpan["operation"];
  status: TraceSpanStatus;
  code: string | null;
  startedAt: string | null;
  completedAt: string | null;
  links: TraceLink[];
  attributes: Record<string, unknown>;
}

/** Builds one immutable, non-authoritative trace from safe Runtime projections. */
export class RunTraceAssembler implements RuntimeEventPublisher {
  private readonly spans = new Map<string, MutableSpan>();
  private readonly issues: TraceIssue[] = [];
  private readonly itemEvents = new Map<string, RuntimeEvent<"run.item.appended">>();
  private readonly observers;
  private readonly lineage: RunLineage;
  private nextSpanSequence = 1;
  private lastEventSequence = 0;
  private terminalEvent: RuntimeEvent<"run.completed" | "run.blocked" | "run.failed" | "run.cancelled"> | null = null;
  private completed = false;

  constructor(private readonly input: CreateRunTraceAssemblerInput) {
    token(input.traceId, "traceId");
    token(input.runId, "runId");
    token(input.taskId, "taskId");
    if (typeof input.createSpanId !== "function") throw new TypeError("RunTraceAssembler.createSpanId must be a function.");
    this.lineage = snapshotRunLineage(input.lineage, input.runId);
    this.observers = Object.freeze([...(input.observers ?? [])]);
    this.openSpan(input.runId, "runtime", "run", null, null, {
      activeAgentId: null,
      terminalCode: null,
      itemCount: null,
      evidenceCount: null,
      artifactCount: null,
      errorCodes: [],
      contextTransitions: [],
      contextProjections: [],
      validation: [],
    });
  }

  publish(event: RuntimeEvent): void {
    if (this.completed) return;
    if (event.runId !== this.input.runId) return this.issue("run_identity_mismatch", event.id, null);
    if (event.taskId !== this.input.taskId) return this.issue("task_identity_mismatch", event.id, null);
    if (!sameLineage(event.lineage, this.lineage)) return this.issue("run_lineage_mismatch", event.id, null);
    if (event.sequence <= this.lastEventSequence) return this.issue("event_sequence_regression", event.id, null);
    else if (event.sequence > this.lastEventSequence + 1) this.issue("event_sequence_gap", event.id, null);
    this.lastEventSequence = Math.max(this.lastEventSequence, event.sequence);

    switch (event.name) {
      case "run.started": {
        const span = this.spans.get(this.input.runId)!;
        if (span.startedAt !== null) this.issue("duplicate_operation_start", event.id, span.operationId);
        else {
          span.startedAt = event.occurredAt;
          span.attributes.activeAgentId = event.payload.activeAgentId;
          span.attributes.activeAgentRevision = event.payload.activeAgentRevision;
          span.attributes.instructionBindingId = event.payload.instructionBindingId;
          span.attributes.instructionBindingRevision = event.payload.instructionBindingRevision;
          span.links.push(link("runtime_event", event.id));
        }
        break;
      }
      case "run.item.appended":
        if (this.itemEvents.has(event.payload.itemId)) this.issue("run_item_mismatch", event.id, null);
        else this.itemEvents.set(event.payload.itemId, event);
        break;
      case "run.descendant.reserved":
      case "run.descendant.started":
      case "run.descendant.rejected":
      case "run.descendant.settled":
        this.spans.get(this.input.runId)!.links.push(link("runtime_event", event.id));
        break;
      case "context.transition.committed": {
        const root = this.spans.get(this.input.runId)!;
        const contextTransitions = root.attributes.contextTransitions as ContextTransitionTraceRecord[];
        root.attributes.contextTransitions = [
          ...contextTransitions,
          {
            transitionId: event.payload.transitionId,
            activeContextId: event.payload.activeContextId,
            baseVersion: event.payload.baseVersion,
            committedVersion: event.payload.committedVersion,
            proposerOwner: event.payload.proposerOwner,
            proposerKind: event.payload.proposerKind,
            causeKind: event.payload.causeKind,
            causeId: event.payload.causeId,
            correlationId: event.payload.correlationId,
            operationKinds: [...event.payload.operationKinds],
          },
        ];
        root.links.push(link("runtime_event", event.id));
        break;
      }
      case "context.projection.completed": {
        const root = this.spans.get(this.input.runId)!;
        const contextProjections = root.attributes.contextProjections as ContextProjectionTraceRecord[];
        root.attributes.contextProjections = [
          ...contextProjections,
          { ...event.payload },
        ];
        root.links.push(link("runtime_event", event.id));
        break;
      }
      case "controller.started": {
        const operationId = createControllerTurnTraceOperationId(event.payload.iteration);
        this.openSpan(operationId, "controller", "turn", this.rootSpanId(), event, {
          turnId: event.payload.turnId,
          iteration: event.payload.iteration,
          decisionKind: null,
          code: null,
          toolExposure: null,
        });
        break;
      }
      case "controller.tool_exposure.resolved": {
        const operationId = createControllerTurnTraceOperationId(event.payload.iteration);
        const span = this.spans.get(operationId);
        if (span === undefined) {
          this.issue("operation_start_missing", event.id, operationId);
        } else {
          span.attributes.toolExposure = Object.freeze({ ...event.payload });
          span.links.push(link("runtime_event", event.id));
        }
        break;
      }
      case "controller.finished": {
        const operationId = createControllerTurnTraceOperationId(event.payload.iteration);
        const attributes = {
          turnId: event.payload.turnId,
          iteration: event.payload.iteration,
          decisionKind: event.payload.decisionKind,
          code: event.payload.code,
          toolExposure: this.spans.get(operationId)?.attributes.toolExposure ?? null,
        };
        if (!this.spans.has(operationId)) {
          this.issue("operation_start_missing", event.id, operationId);
          this.openSpan(
            operationId,
            "controller",
            "turn",
            this.rootSpanId(),
            null,
            attributes,
          );
          const span = this.spans.get(operationId)!;
          span.status = "unknown";
          span.code = event.payload.code;
          span.completedAt = event.occurredAt;
          span.links.push(link("runtime_event", event.id));
        } else {
          this.closeSpan(operationId, event, event.payload.status === "decided" ? "succeeded" : event.payload.status === "interrupted" ? "cancelled" : "failed", event.payload.code, attributes);
        }
        break;
      }
      case "operation.started": {
        const parent = event.payload.parentInvocationId === null
          ? this.rootSpanId()
          : this.spans.get(event.payload.parentInvocationId)?.spanId ?? null;
        if (event.payload.parentInvocationId !== null && parent === null) this.issue("parent_operation_missing", event.id, event.payload.invocationId);
        this.openSpan(event.payload.invocationId, "operation", "operation", parent, event, {
          namespace: event.payload.operationNamespace,
          name: event.payload.operationName,
          revision: event.payload.operationRevision,
          semanticOwner: event.payload.semanticOwner,
          bindingKind: event.payload.bindingKind,
          correlationKind: event.payload.correlationKind,
          resultId: null,
          resultStatus: null,
          code: null,
        });
        break;
      }
      case "operation.finished":
        this.closeSpan(event.payload.invocationId, event, operationStatus(event.payload.status), event.payload.code, {
          resultId: event.payload.resultId,
          resultStatus: event.payload.status,
          code: event.payload.code,
        }, [link("operation_result", event.payload.resultId)]);
        break;
      case "interaction.opened": {
        const parent = event.payload.parentRunActionId === null ? this.rootSpanId() : this.rootSpanId();
        this.openSpan(event.payload.requestId, "interaction", "interaction", parent, event, {
          protocolOwner: event.payload.protocolOwner,
          protocolKind: event.payload.protocolKind,
          protocolRevision: event.payload.protocolRevision,
          subjectKind: event.payload.subjectKind,
          blockingScope: event.payload.blockingScope,
          pendingVersion: event.payload.pendingVersion,
          lifecycle: null,
          terminalRecordId: null,
          code: null,
        }, [link("interaction_request", event.payload.requestId)]);
        break;
      }
      case "interaction.settled":
        this.closeSpan(event.payload.requestId, event, interactionStatus(event.payload.lifecycle), event.payload.code, {
          lifecycle: event.payload.lifecycle,
          terminalRecordId: event.payload.terminalRecordId,
          code: event.payload.code,
        });
        break;
      case "validation.check.started":
        this.appendValidationTrace(event, {
          event: "check_started",
          snapshotRevision: event.payload.snapshotRevision,
          subjectId: event.payload.attemptId,
          status: "running",
          code: null,
          durationMs: null,
          coverageRatio: null,
        });
        break;
      case "validation.check.finished":
        this.appendValidationTrace(event, {
          event: "check_finished",
          snapshotRevision: event.payload.snapshotRevision,
          subjectId: event.payload.attemptId,
          status: event.payload.status,
          code: event.payload.code,
          durationMs: event.payload.durationMs,
          coverageRatio: event.payload.coverageRatio,
        });
        break;
      case "validation.assessment.committed":
        this.appendValidationTrace(event, {
          event: "assessment_committed",
          snapshotRevision: event.payload.snapshotRevision,
          subjectId: event.payload.assessmentId,
          status: event.payload.verdict,
          code: null,
          durationMs: null,
          coverageRatio: null,
        });
        break;
      case "validation.gate.evaluated":
        this.appendValidationTrace(event, {
          event: "gate_evaluated",
          snapshotRevision: event.payload.snapshotRevision,
          subjectId: event.payload.gateId,
          status: event.payload.status,
          code: event.payload.reasonCodes[0] ?? null,
          durationMs: null,
          coverageRatio: null,
        });
        break;
      case "run.completed":
      case "run.blocked":
      case "run.failed":
      case "run.cancelled":
        if (this.terminalEvent !== null) this.issue("duplicate_operation_settlement", event.id, this.input.runId);
        else this.terminalEvent = event;
        break;
    }
    this.notifyObservers(this.snapshot("active"));
  }

  getSnapshot(): RunTrace { return this.snapshot(this.completed ? this.finalStatus() : "active"); }

  private appendValidationTrace(
    event: RuntimeEvent,
    record: import("./RunTrace.js").ValidationTraceRecord,
  ): void {
    const root = this.spans.get(this.input.runId)!;
    root.attributes.validation = [
      ...(root.attributes.validation as import("./RunTrace.js").ValidationTraceRecord[]),
      Object.freeze(record),
    ];
    root.links.push(link("runtime_event", event.id));
  }

  complete(input: CompleteRunTraceInput): RunTrace {
    if (this.completed) return this.getSnapshot();
    this.verifyItems(input.items);
    if (input.result.runId !== this.input.runId) this.issue("run_identity_mismatch", null, this.input.runId);
    if (input.result.taskId !== this.input.taskId) this.issue("task_identity_mismatch", null, this.input.runId);
    if (this.terminalEvent === null) this.issue("terminal_event_missing", null, this.input.runId);
    else if (this.terminalEvent.payload.status !== input.result.status || this.terminalEvent.payload.code !== input.result.code) this.issue("terminal_result_mismatch", this.terminalEvent.id, this.input.runId);

    const completedAt = this.terminalEvent?.occurredAt ?? null;
    const root = this.spans.get(this.input.runId)!;
    root.status = rootStatus(input.result.status);
    root.code = input.result.code;
    root.completedAt = completedAt;
    root.attributes = {
      ...root.attributes,
      terminalCode: input.result.code,
      itemCount: input.result.itemCount,
      evidenceCount: input.result.evidenceCount,
      artifactCount: input.result.artifactCount,
      errorCodes: [...input.result.errorCodes],
    };
    root.links.push(link("run_result", this.input.runId));
    for (const span of this.spans.values()) {
      if (span.operationId !== this.input.runId && span.completedAt === null) {
        span.status = "unknown";
        this.issue("operation_settlement_missing", null, span.operationId);
      }
    }
    this.completed = true;
    const trace = this.snapshot(this.finalStatus());
    this.notifyObservers(trace);
    return trace;
  }

  private rootSpanId(): string { return this.spans.get(this.input.runId)!.spanId; }

  private openSpan(operationId: string, owner: TraceSpan["owner"], operation: TraceSpan["operation"], parentSpanId: string | null, event: RuntimeEvent | null, attributes: Record<string, unknown>, extraLinks: readonly TraceLink[] = []): void {
    const existing = this.spans.get(operationId);
    if (existing !== undefined) { this.issue("duplicate_operation_start", event?.id ?? null, operationId); return; }
    const sequence = this.nextSpanSequence++;
    const spanId = token(this.input.createSpanId({ runId: this.input.runId, sequence, owner, operation, operationId }), "spanId");
    this.spans.set(operationId, {
      spanId, sequence, parentSpanId, operationId, owner, operation,
      status: "running", code: null, startedAt: event?.occurredAt ?? null, completedAt: null,
      links: [...(event ? [link("runtime_event", event.id)] : []), ...extraLinks], attributes: { ...attributes },
    });
  }

  private closeSpan(operationId: string, event: RuntimeEvent, status: TraceSpanStatus, code: string | null, attributes: Record<string, unknown>, links: readonly TraceLink[] = []): void {
    const span = this.spans.get(operationId);
    if (span === undefined) { this.issue("operation_start_missing", event.id, operationId); return; }
    if (span.completedAt !== null) { this.issue("duplicate_operation_settlement", event.id, operationId); return; }
    span.status = status;
    span.code = code;
    span.completedAt = event.occurredAt;
    span.attributes = { ...span.attributes, ...attributes };
    span.links.push(link("runtime_event", event.id), ...links);
  }

  private verifyItems(items: readonly CommittedRunItemTraceProjection[]): void {
    const projected = new Set(items.map((item) => item.id));
    const root = this.spans.get(this.input.runId)!;
    for (const item of items) {
      const event = this.itemEvents.get(item.id);
      if (event === undefined) this.issue("run_item_event_missing", item.id, null);
      else if (event.payload.itemKind !== item.kind || event.payload.itemSequence !== item.sequence || item.runId !== this.input.runId) this.issue("run_item_mismatch", item.id, null);
      else if (!root.links.some((value) => value.kind === "run_item" && value.id === item.id)) root.links.push(link("run_item", item.id));
    }
    for (const [itemId] of this.itemEvents) if (!projected.has(itemId)) this.issue("run_item_projection_missing", itemId, null);
  }

  private notifyObservers(trace: RunTrace): void {
    for (const observer of this.observers) {
      try {
        void Promise.resolve(observer.observe(trace)).catch(() => undefined);
      } catch {
        // Trace observation is best-effort and never participates in execution.
      }
    }
  }

  private issue(code: TraceIssueCode, sourceId: string | null, operationId: string | null): void { this.issues.push(Object.freeze({ code, sourceId, operationId })); }
  private finalStatus(): "complete" | "incomplete" { return this.issues.length === 0 ? "complete" : "incomplete"; }

  private snapshot(status: RunTrace["status"]): RunTrace {
    const spans = [...this.spans.values()].sort((a, b) => a.sequence - b.sequence).map((span) => Object.freeze({
      ...span,
      links: Object.freeze(span.links.map((value) => Object.freeze({ ...value }))),
      attributes: deepFreeze({ ...span.attributes }),
    }) as unknown as TraceSpan);
    const root = this.spans.get(this.input.runId)!;
    return Object.freeze({
      schemaVersion: RUN_TRACE_SCHEMA_VERSION,
      traceId: this.input.traceId,
      runId: this.input.runId,
      taskId: this.input.taskId,
      lineage: this.lineage,
      status,
      rootSpanId: root.spanId,
      startedAt: root.startedAt,
      completedAt: root.completedAt,
      spans: Object.freeze(spans),
      issues: Object.freeze([...this.issues]),
    });
  }
}

function link(kind: TraceLink["kind"], id: string): TraceLink { return Object.freeze({ kind, id }); }
function operationStatus(status: string): TraceSpanStatus { return status === "succeeded" || status === "partial" ? "succeeded" : status === "cancelled" ? "cancelled" : status === "unknown_effect" ? "unknown" : "failed"; }
function interactionStatus(status: string): TraceSpanStatus { return status === "resolved" ? "succeeded" : status === "cancelled" ? "cancelled" : "failed"; }
function rootStatus(status: string): TraceSpanStatus { return status === "succeeded" ? "succeeded" : status === "blocked" ? "blocked" : status === "cancelled" ? "cancelled" : "failed"; }
function token(value: unknown, field: string): string { if (typeof value !== "string" || value.trim().length === 0) throw new TypeError(`${field} must be non-empty.`); return value; }
function sameLineage(left: RunLineage, right: RunLineage): boolean {
  if (left.kind !== right.kind || left.root.id !== right.root.id || left.depth !== right.depth) return false;
  if (left.kind === "root" || right.kind === "root") return true;
  return left.parent.id === right.parent.id &&
    left.relation.id === right.relation.id &&
    left.parentRunAction.id === right.parentRunAction.id &&
    left.parentRunAction.sequence === right.parentRunAction.sequence;
}
function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T { if (value === null || typeof value !== "object" || seen.has(value)) return value; seen.add(value); for (const child of Object.values(value)) deepFreeze(child, seen); return Object.freeze(value); }
