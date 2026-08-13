import type { Agent } from "@agent-anything/agent-core/agent";
import { toAgentRevisionRef } from "@agent-anything/agent-core/agent";
import type { ControllerTurnRef, InvocationInterruptionContext } from "@agent-anything/agent-core/control";
import type { RunInput } from "@agent-anything/agent-core/input";
import type { RunActionProvenance, RunActionRef } from "@agent-anything/agent-core/run-action";
import {
  applyContextUpdate,
  createInitialContext,
  ContextProjectionError,
  type Context,
  type ContextProjection,
} from "@agent-anything/context/context";
import {
  RuntimeEventStream,
  type ObservabilityRecordContext,
  type RunTraceAssembler,
  type RunTraceObserver,
  type RuntimeEventName,
  type RuntimeEventPayloadMap,
  type RuntimeEventPublisher,
} from "@agent-anything/observability";
import {
  findRegisteredOperation,
  type OperationRequestOrigin,
  type RegisteredOperation,
} from "@agent-anything/operation-catalog/catalog";
import type {
  ResolvedOperationBinding,
} from "@agent-anything/operation-catalog/binding";
import type {
  OperationCorrelation,
  OperationInvocationContext,
  OperationInvocationRef,
  OperationRevisionRef,
} from "@agent-anything/operation-catalog/identity";
import {
  createOperationResult,
  type OperationFailure,
  type OperationResult,
} from "@agent-anything/operation-catalog/result";
import { CompositeExecution } from "@agent-anything/operation-composition/execution";
import type { CompositeResult } from "@agent-anything/operation-composition/result";
import {
  ActionExecutionCoordinator,
  type ActionApprovalResolutionPort,
  type ActionExecutionObserver,
  type ActionExecutionResult,
} from "@agent-anything/action-execution/enforcement";
import { createActionPermissionAssessmentPort } from "@agent-anything/permission/authority";
import {
  APPROVAL_INTERACTION_PROTOCOL,
  createApprovalInteractionPresentation,
  createApprovalInteractionProtocol,
  createApprovalRequest,
  validateApprovalDecision,
  type ApprovalApplicationOutcome,
  type ApprovalInteractionResolution,
  type ApprovalInteractionSubject,
  type ApprovalReviewInput,
  type ValidatedApprovalDecision,
} from "@agent-anything/permission/approval";
import type {
  CapturedInteractionProtocol,
  InteractionSubmissionInput,
  InteractionSubmissionOutcome,
  PendingInteractionRef,
} from "@agent-anything/interaction/coordination";
import type { InteractionTerminalRecord } from "@agent-anything/interaction/records";
import {
  adaptToolSemanticResult,
  type ToolResult,
} from "@agent-anything/tools/result";
import { materializeToolCall, type ToolCall } from "@agent-anything/tools/invocation";
import { createControllerToolExposureProof } from "@agent-anything/tools/selection";
import {
  ControllerError,
  validateControllerDecision,
  type ControllerDecision,
  type InteractionRequestCandidate,
  type OperationRequestCandidate,
  type ProgressionCandidate,
  type SameRunHandoffRequest,
} from "../controller/index.js";
import {
  abandonPlan,
  applyPlanUpdate,
  projectPlan,
} from "../plan/index.js";
import { snapshotRetryEvent, type RetryEventSink } from "../retry/index.js";
import {
  createBlockedRunResult,
  createCancelledRunResult,
  createFailedRunResult,
  createRunFailureCause,
  createRunObservation,
  createSucceededRunResult,
  deriveActiveRunStatus,
  toRunCancellationSummary,
  type PendingRunSubject,
  type RunFailureCause,
  type RunFailureCode,
  type RunItemPayload,
  type RunObservation,
  type RunResult,
  type RunState,
  type RuntimeRunAction,
} from "../run/index.js";
import type { RunExecutionUpdate } from "./RunHandle.js";
import type { ResolvedRunConfig } from "./RunConfig.js";
import type {
  ResolvedRunnerDependencies,
} from "./RunnerDependencies.js";
import {
  executeControllerOperation,
  prepareControllerOperation,
  type PreparedControllerOperation,
} from "./ControllerOperation.js";
import {
  applyCommittedPolicyAmendment,
  applyCommittedSessionAuthority,
  applyImmediateApprovalAuthority,
  consumeActionApprovalCoverage,
} from "./RunApprovalAuthority.js";
import {
  deriveApprovalReviewDeadline,
  deriveAuthorityCommitDeadline,
} from "../run/index.js";
import {
  executeAuthorityCommit,
  isDurableAuthorityDecision,
} from "./AuthorityCommitExecution.js";
import { executeApprovalReviewer } from "./ApprovalReviewerExecution.js";
import { createInitialRunState } from "./RunInitialization.js";
import { createRunFinalizationContext } from "./RunFinalization.js";
import {
  OperationSettlementTimeoutError,
  RunInterruptionCoordinator,
} from "./RunInterruptionCoordinator.js";
import { RunInteractionCoordinator, type RuntimeInteractionSettlement } from "./RunInteractionCoordinator.js";
import { evaluateRunLoopLimits } from "./RunLoopLimits.js";
import { recordRunnerLifecycle } from "./RunnerObservability.js";
import { completeRunnerTrace, createRunnerTraceAssembler } from "./RunnerTracing.js";
import { RunStateWriter } from "./RunStateWriter.js";

type TerminalCandidate<TOutput> =
  | { readonly status: "succeeded"; readonly output: TOutput }
  | { readonly status: "blocked"; readonly code: "runtime_no_safe_path" }
  | {
      readonly status: "failed";
      readonly code: RunFailureCode;
      readonly failure: RunFailureCause;
      readonly relatedFailures?: readonly RunFailureCause[];
    }
  | { readonly status: "cancelled" };

interface CandidateBasis<TOutput> {
  readonly turn: ControllerTurnRef;
  readonly runRevision: number;
  readonly activeAgent: Agent<TOutput>;
  readonly projection: ContextProjection<RunObservation>;
  readonly exposure: ReturnType<typeof createControllerToolExposureProof>;
}

interface OperationExecutionOutcome {
  readonly result: OperationResult;
  readonly toolResult: ToolResult | null;
}

interface QueuedInteractionSettlement {
  readonly pending: PendingInteractionRef;
  readonly terminal: InteractionTerminalRecord;
  readonly settlement: RuntimeInteractionSettlement;
  readonly action: RuntimeRunAction | null;
}

export class RunExecution<TOutput> {
  private readonly startedAt: string;
  private readonly startedAtMs: number;
  private readonly writer: RunStateWriter<TOutput>;
  private readonly interactions: RunInteractionCoordinator;
  private readonly eventStream: RuntimeEventStream;
  private readonly traceAssembler: RunTraceAssembler | null;
  private readonly interruptionCoordinator: RunInterruptionCoordinator;
  private readonly actionExecution: ActionExecutionCoordinator | null;
  private activeAgent: Agent<TOutput>;
  private terminalResult: RunResult<TOutput> | null = null;
  private emittedItemCount = 0;
  private descendantCount = 0;
  private nextInteractionRequest = 1;
  private readonly identitySequences = new Map<
    Parameters<ResolvedRunnerDependencies["createId"]>[0]["kind"],
    number
  >();
  private readonly childHandles = new Set<import("./RunHandle.js").RunHandle>();
  private readonly interactionActions = new Map<string, RuntimeRunAction>();
  private readonly interactionSettlements: QueuedInteractionSettlement[] = [];
  private retryProjection: import("./RunHandle.js").RunRetryProjection | null = null;

  constructor(
    private readonly runId: string,
    private readonly dependencies: ResolvedRunnerDependencies,
    agent: Agent<TOutput>,
    private readonly input: RunInput,
    private readonly config: ResolvedRunConfig,
    runtimeEventPublishers: readonly RuntimeEventPublisher[],
    runTraceObservers: readonly RunTraceObserver[],
    actionExecutionObserver: ActionExecutionObserver | undefined,
    private readonly onUpdate: (update: RunExecutionUpdate<TOutput>) => void,
  ) {
    this.startedAt = this.now();
    this.startedAtMs = Date.parse(this.startedAt);
    this.activeAgent = agent;
    this.traceAssembler = createRunnerTraceAssembler({
      runId,
      taskId: input.task.id,
      observers: runTraceObservers,
      createId: dependencies.createId,
    });
    this.eventStream = new RuntimeEventStream({
      runId,
      taskId: input.task.id,
      now: dependencies.now,
      createEventId: ({ sequence }) => dependencies.createId({
        kind: "runtime_event",
        runId,
        sequence,
      }),
      publishers: Object.freeze([
        ...runtimeEventPublishers,
        ...(this.traceAssembler === null ? [] : [this.traceAssembler]),
      ]),
    });
    const initial = createInitialRunState({
      runId,
      agent,
      input,
      config,
      startedAt: this.startedAt,
    });
    this.writer = new RunStateWriter(
      initial,
      dependencies.now,
      dependencies.createId,
      (state) => this.onStateCommitted(state),
    );

    const approvalProtocol = createApprovalInteractionProtocol({
      validateDecision: (subject, submission, request) =>
        this.validateApprovalDecision(subject, submission, request.id),
      applyDecision: (subject, resolution, request) =>
        this.applyApprovalDecision(subject, resolution, request.id),
    }) as unknown as CapturedInteractionProtocol;
    this.interactions = new RunInteractionCoordinator({
      runId,
      registry: dependencies.interactions,
      localProtocols: Object.freeze([approvalProtocol]),
      now: dependencies.now,
      createId: (kind, sequence) => dependencies.createId({ kind, runId, sequence }),
      onOpened: (pending) => this.openPendingInteraction(pending),
      onSettled: (pending, terminal, settlement) =>
        this.queueInteractionSettlement(pending, terminal, settlement),
    });

    this.interruptionCoordinator = new RunInterruptionCoordinator({
      cancellation: config.cancellation.context,
      operationSettlementTimeoutMs: config.cancellationLimits.operationSettlementTimeoutMs,
      now: dependencies.now,
      onCancellationObserved: (request) => this.enterCancelling(request),
    });

    const actionComposition = dependencies.operations.actionExecution;
    this.actionExecution = actionComposition === undefined
      ? null
      : new ActionExecutionCoordinator({
          ...actionComposition,
          permission: createActionPermissionAssessmentPort({
            now: dependencies.now,
            consumeCoverage: (coverageId) => this.consumeApprovalCoverage(coverageId),
          }),
          approval: this.createActionApprovalPort(),
          observer: composeActionExecutionObservers(
            actionComposition.observer,
            actionExecutionObserver,
          ),
          now: dependencies.now,
          createId: (kind) => `${this.id("action")}:${kind}`,
        });
  }

  submitInteraction(input: InteractionSubmissionInput): InteractionSubmissionOutcome {
    const local = this.interactions.submit(input);
    if (local.status !== "rejected" || local.code !== "interaction_not_pending") {
      return local;
    }
    for (const child of this.childHandles) {
      const outcome = child.submitInteraction(input);
      if (outcome.status !== "rejected" || outcome.code !== "interaction_not_pending") {
        return outcome;
      }
    }
    return local;
  }

  async run(): Promise<RunResult<TOutput>> {
    this.interruptionCoordinator.start();
    try {
      this.writer.commitState(() => Object.freeze({ status: "running" as const }));
      this.emit("run.started", {
        status: "running",
        activeAgentId: this.activeAgent.id,
      }, this.startedAt);
      const startFailures = await this.recordLifecycle("started");
      if (startFailures.length > 0) {
        return await this.settle({
          status: "failed",
          code: "required_finalization_failed",
          failure: startFailures[0]!,
          relatedFailures: startFailures.slice(1),
        });
      }

      while (this.terminalResult === null) {
        this.drainInteractionSettlements();
        if (this.config.cancellation.context.request !== null) {
          return await this.settle({ status: "cancelled" });
        }
        const state = this.writer.getSnapshot();
        const violation = evaluateRunLoopLimits({
          counters: state.counters,
          limits: this.config.limits,
          deadlineAt: state.deadlineAt,
          now: this.now(),
          cancellationRequested: false,
        });
        if (violation !== null) {
          return await this.settle({
            status: "failed",
            code: violation.code,
            failure: runtimeFailure(violation.code, violation.message, violation.metadata),
          });
        }

        const decision = await this.nextDecision();
        const settlementsAfterDecision = this.drainInteractionSettlements();
        if (this.config.cancellation.context.request !== null) {
          return await this.settle({ status: "cancelled" });
        }
        if (settlementsAfterDecision > 0) {
          continue;
        }
        if (decision.decision.kind === "propose_completion") {
          return await this.settle({
            status: "succeeded",
            output: decision.decision.output,
          });
        }
        if (decision.decision.kind === "propose_stop") {
          return await this.settle({
            status: "blocked",
            code: "runtime_no_safe_path",
          });
        }

        const basis: CandidateBasis<TOutput> = {
          turn: decision.turn,
          runRevision: decision.basisRevision,
          activeAgent: decision.agent,
          projection: decision.prepared.context,
          exposure: decision.prepared.input.toolExposure,
        };
        for (let index = 0; index < decision.decision.candidates.length; index += 1) {
          if (this.config.cancellation.context.request !== null) break;
          if (this.drainInteractionSettlements() > 0) break;
          const invalidatesRemainder = await this.processCandidate(
            decision.decision.candidates[index]!,
            index,
            basis,
          );
          if (this.terminalResult !== null) return this.terminalResult;
          if (invalidatesRemainder) break;
        }
      }
      return this.terminalResult;
    } catch (error) {
      if (this.terminalResult !== null) return this.terminalResult;
      if (this.config.cancellation.context.request !== null &&
          !(error instanceof OperationSettlementTimeoutError)) {
        return await this.settle({ status: "cancelled" });
      }
      return await this.settle(this.failureFromError(error));
    } finally {
      this.interactions.close();
      this.interruptionCoordinator.dispose();
    }
  }

  private async nextDecision(): Promise<{
    readonly decision: ControllerDecision<TOutput>;
    readonly turn: ControllerTurnRef;
    readonly basisRevision: number;
    readonly agent: Agent<TOutput>;
    readonly prepared: PreparedControllerOperation<TOutput>;
  }> {
    const state = this.writer.getSnapshot();
    const iteration = state.counters.controllerTurns + 1;
    const turn: ControllerTurnRef = Object.freeze({
      run: state.run,
      id: this.id("controller_turn", iteration),
      sequence: iteration,
    });
    const exposure = createControllerToolExposureProof(
      this.config.tools,
      turn.id,
    );
    const prepared = prepareControllerOperation({
      agent: this.activeAgent,
      runInput: this.input,
      config: this.config,
      state,
      iteration,
      exposure,
      contextProjection: this.dependencies.contextProjection,
    });
    this.emit("controller.started", { turnId: turn.id, iteration });
    try {
      const candidate = await this.interruptionCoordinator.execute(
        "controller",
        () => executeControllerOperation({
          dependencies: this.dependencies,
          prepared,
          config: this.config,
          retryEvents: this.retryEvents(),
        }),
        state.deadlineAt,
      );
      const decision = validateControllerDecision(candidate, prepared.input);
      this.writer.commit({
        kind: "controller_turn",
        turn,
        status: "decided",
        decisionKind: decision.kind,
        modelItems: decision.modelItems,
        failure: null,
      }, (current) => Object.freeze({
        counters: Object.freeze({
          ...current.counters,
          controllerTurns: iteration,
        }),
      }));
      this.emit("controller.finished", {
        turnId: turn.id,
        iteration,
        status: "decided",
        code: null,
        decisionKind: decision.kind,
      });
      return Object.freeze({
        decision,
        turn,
        basisRevision: state.revision,
        agent: this.activeAgent,
        prepared,
      });
    } catch (error) {
      if (this.config.cancellation.context.request !== null) throw error;
      const terminal = this.failureFromError(error);
      this.writer.commit({
        kind: "controller_turn",
        turn,
        status: "failed",
        decisionKind: null,
        modelItems: Object.freeze([]),
        failure: terminal.failure,
      }, (current) => Object.freeze({
        counters: Object.freeze({
          ...current.counters,
          controllerTurns: iteration,
        }),
      }));
      this.emit("controller.finished", {
        turnId: turn.id,
        iteration,
        status: "failed",
        code: terminal.failure.failure.code,
        decisionKind: null,
      });
      throw error;
    }
  }

  private async processCandidate(
    candidate: ProgressionCandidate,
    index: number,
    basis: CandidateBasis<TOutput>,
  ): Promise<boolean> {
    const state = this.writer.getSnapshot();
    if (state.counters.runActions >= this.config.limits.maxActions) {
      await this.settle({
        status: "failed",
        code: "runtime_limit_exceeded",
        failure: runtimeFailure(
          "runtime_limit_exceeded",
          "Run exceeded maxActions.",
          { maxActions: this.config.limits.maxActions },
        ),
      });
      return true;
    }
    const reservedId = candidate.kind === "operation_request"
      ? this.id("operation_invocation")
      : candidate.kind === "interaction_request"
        ? this.id("interaction_request", this.nextInteractionRequest++)
        : null;
    const action = this.materializeControllerRunAction(
      candidate,
      index,
      basis,
      reservedId,
    );

    switch (candidate.kind) {
      case "state_transition":
        return candidate.transition === "plan_update"
          ? (await this.applyPlanCandidate(action, candidate.input), false)
          : this.applyHandoffCandidate(action, candidate.input, basis);
      case "interaction_request":
        return this.applyInteractionCandidate(action, candidate, reservedId!);
      case "operation_request": {
        const outcome = await this.executeOperationCandidate(
          action,
          candidate,
          reservedId!,
          basis.exposure,
        );
        if (outcome !== null) {
          this.commitOperationObservation(action, outcome);
          if (outcome.result.status === "unknown_effect") {
            await this.settle({
              status: "failed",
              code: "unknown_effect",
              failure: createRunFailureCause("operation", outcome.result.failure),
            });
            return true;
          }
        }
        return false;
      }
    }
  }

  private materializeControllerRunAction(
    candidate: ProgressionCandidate,
    candidateIndex: number,
    basis: CandidateBasis<TOutput>,
    reservedId: string | null,
  ): RuntimeRunAction {
    const state = this.writer.getSnapshot();
    const sequence = state.counters.runActions + 1;
    const ref = Object.freeze({
      run: state.run,
      id: this.id("run_action", sequence),
      sequence,
    });
    const subject = candidate.kind === "state_transition"
      ? Object.freeze({
          kind: "state_transition" as const,
          transition: candidate.transition,
        })
      : candidate.kind === "operation_request"
        ? Object.freeze({
            kind: "operation" as const,
            invocationId: reservedId,
            requestOrigin: candidate.origin,
          })
        : Object.freeze({
            kind: "interaction" as const,
            request: Object.freeze({
              id: reservedId!,
              protocol: candidate.protocol,
              requestVersion: candidate.requestVersion,
              subject: candidate.subjectRef,
            }),
          });
    const action: RuntimeRunAction = Object.freeze({
      ref,
      provenance: Object.freeze({
        kind: "controller" as const,
        turn: basis.turn,
        candidateIndex,
      }),
      subject,
      basis: Object.freeze({
        runRevision: basis.runRevision,
        activeAgentId: basis.activeAgent.id,
        controllerProjectionRevision: String(basis.runRevision),
      }),
      materializedAt: this.now(),
    });
    this.writer.commit({ kind: "run_action", action }, (current) => Object.freeze({
      counters: Object.freeze({
        ...current.counters,
        runActions: sequence,
      }),
    }));
    return action;
  }

  private materializeWorkflowRunAction(input: {
    readonly operation: OperationRevisionRef;
    readonly invocationId: string;
    readonly compositeId: string;
    readonly nodeId: string;
  }): RuntimeRunAction {
    const state = this.writer.getSnapshot();
    const sequence = state.counters.runActions + 1;
    const ref = Object.freeze({
      run: state.run,
      id: this.id("run_action", sequence),
      sequence,
    });
    const provenance: RunActionProvenance = Object.freeze({
      kind: "trusted_workflow",
      workflow: Object.freeze({ owner: "operation-composition", invocationId: input.compositeId }),
      nodeRef: input.nodeId,
    });
    const action: RuntimeRunAction = Object.freeze({
      ref,
      provenance,
      subject: Object.freeze({
        kind: "operation",
        invocationId: input.invocationId,
        requestOrigin: "composite",
      }),
      basis: Object.freeze({
        runRevision: state.revision,
        activeAgentId: state.activeAgent.id,
        controllerProjectionRevision: null,
      }),
      materializedAt: this.now(),
    });
    this.writer.commit({ kind: "run_action", action }, (current) => Object.freeze({
      counters: Object.freeze({ ...current.counters, runActions: sequence }),
    }));
    return action;
  }

  private async applyPlanCandidate(action: RuntimeRunAction, candidate: unknown): Promise<void> {
    const state = this.writer.getSnapshot();
    const result = state.plan === null
      ? applyPlanUpdate({
          currentPlan: null,
          newPlanId: this.id("plan"),
          candidate,
          limits: this.config.limits.plan,
          now: this.now(),
        })
      : applyPlanUpdate({
          currentPlan: state.plan,
          candidate,
          limits: this.config.limits.plan,
          now: this.now(),
        });
    if (result.status === "applied") {
      this.writer.commit({
        kind: "state_transition",
        transition: "plan",
        previousRevision: state.plan?.version ?? null,
        plan: projectPlan(result.plan),
      }, () => Object.freeze({ plan: result.plan }));
    }
    this.commitObservation(action, {
      kind: "plan_update",
      result: result.observation,
    }, [], "runtime");
  }

  private async applyHandoffCandidate(
    action: RuntimeRunAction,
    request: SameRunHandoffRequest,
    basis: CandidateBasis<TOutput>,
  ): Promise<boolean> {
    const state = this.writer.getSnapshot();
    const rejected = (code: string): boolean => {
      this.commitObservation(action, {
        kind: "handoff",
        status: "rejected",
        code,
      }, [], "agent-runtime");
      return true;
    };
    if (
      request.expectedRunRevision !== basis.runRevision ||
      !sameAgentRef(request.currentAgent, basis.activeAgent) ||
      !sameAgentRef(request.currentAgent, state.activeAgent)
    ) return rejected("handoff_basis_stale");
    if (sameAgentRef(request.currentAgent, request.targetAgent)) {
      return rejected("handoff_target_unchanged");
    }
    if (this.dependencies.agents === undefined) {
      return rejected("handoff_agent_resolver_unavailable");
    }
    const resolution = await this.dependencies.agents.resolve(request.targetAgent);
    if (
      resolution.status !== "admitted" ||
      resolution.agent === null ||
      resolution.admissionEvidenceRef !== request.admissionEvidenceRef ||
      !sameAgentRef(resolution.agent, request.targetAgent)
    ) return rejected(resolution.code ?? "handoff_agent_not_admitted");

    const previous = state.activeAgent;
    const nextAgent = resolution.agent as Agent<TOutput>;
    const nextContext = handoffContext(
      request.transferPolicy,
      state.context,
      basis.projection,
      this.input,
    );
    this.activeAgent = nextAgent;
    this.writer.commit({
      kind: "state_transition",
      transition: "active_agent",
      previousAgent: previous,
      activeAgent: toAgentRevisionRef(nextAgent),
      reason: request.reason,
    }, () => Object.freeze({
      activeAgent: toAgentRevisionRef(nextAgent),
      context: nextContext,
    }));
    this.commitObservation(action, {
      kind: "handoff",
      status: "applied",
      code: null,
    }, [{
      owner: "agent-runtime",
      kind: "agent_admission_evidence",
      id: request.admissionEvidenceRef,
      revision: request.targetAgent.revision,
    }], "agent-runtime");
    return true;
  }

  private async applyInteractionCandidate(
    action: RuntimeRunAction,
    candidate: InteractionRequestCandidate,
    requestId: string,
  ): Promise<boolean> {
    const opened = this.interactions.open({
      requestId,
      protocol: candidate.protocol,
      subject: candidate.subject,
      subjectRef: candidate.subjectRef,
      correlation: this.runActionCorrelation(action),
      parentRunAction: action.ref,
      presentation: candidate.presentation,
      requestVersion: candidate.requestVersion,
      expiresAt: candidate.expiresAt,
      blockingScope: candidate.blockingScope,
      createdAt: this.now(),
    });
    if (opened.status !== "opened") {
      this.commitObservation(action, {
        kind: "interaction",
        owner: opened.owner,
        status: "failed",
        value: Object.freeze({ code: opened.code }),
      }, [], opened.owner);
      return candidate.blockingScope !== "none";
    }
    this.interactionActions.set(interactionRequestKey(opened.pending.request), action);
    if (candidate.blockingScope === "none") return false;
    const settlement = await opened.completion;
    this.drainInteractionSettlements();
    if (this.interactionActions.delete(interactionRequestKey(opened.pending.request))) {
      this.commitInteractionObservation(action, settlement);
    }
    return true;
  }

  private async executeOperationCandidate(
    action: RuntimeRunAction,
    candidate: OperationRequestCandidate,
    invocationId: string,
    exposure: ReturnType<typeof createControllerToolExposureProof>,
  ): Promise<OperationExecutionOutcome | null> {
    let operation = candidate.origin === "controller_protocol"
      ? candidate.operation
      : null;
    let request = candidate.origin === "controller_protocol"
      ? candidate.request
      : null;
    let toolCall: ToolCall | null = null;
    if (candidate.origin === "tool_request") {
      const materialized = materializeToolCall({
        candidate: candidate.tool,
        selection: this.config.tools,
        exposure,
        parentRunAction: action.ref,
        toolCallId: this.id("tool_call"),
        createdAt: this.now(),
        validateInput: this.dependencies.operations.validateToolInput,
      });
      if (materialized.status === "rejected") {
        this.commitRejectedOperation(action, "tools", materialized.code, materialized.message);
        return null;
      }
      toolCall = materialized.call;
      operation = toolCall.operationRevision;
      request = toolCall.input;
    }
    const executed = await this.executeOperation({
      action,
      operation: operation!,
      request,
      requestOrigin: candidate.origin === "tool_request" ? "tool_request" : "controller_protocol",
      invocationId,
      parentInvocation: null,
      basis: toolCall ?? candidate,
    });
    if (executed === null) return null;
    const toolResult = toolCall === null
      ? null
      : adaptToolResult(toolCall, executed);
    return Object.freeze({ result: executed, toolResult });
  }

  private async executeOperation(input: {
    readonly action: RuntimeRunAction;
    readonly operation: OperationRevisionRef;
    readonly request: unknown;
    readonly requestOrigin: OperationRequestOrigin;
    readonly invocationId: string;
    readonly parentInvocation: OperationInvocationRef | null;
    readonly basis: unknown;
  }): Promise<OperationResult | null> {
    const registration = findRegisteredOperation(
      this.dependencies.operations.catalog,
      input.operation,
    );
    if (registration === undefined) {
      this.commitRejectedOperation(
        input.action,
        "operation-catalog",
        "operation_not_registered",
        "The requested Operation revision is not registered.",
      );
      return null;
    }
    if (registration.retirement !== null) {
      this.commitRejectedOperation(
        input.action,
        "operation-catalog",
        "operation_retired",
        "The requested Operation revision is retired.",
      );
      return null;
    }
    if (!registration.allowedRequestOrigins.includes(input.requestOrigin)) {
      this.commitRejectedOperation(
        input.action,
        "operation-catalog",
        "operation_request_origin_denied",
        "The requested origin is not admitted for this Operation revision.",
      );
      return null;
    }
    const invocation: OperationInvocationRef = Object.freeze({
      id: input.invocationId,
      operation: registration.operation.ref,
    });
    const context: OperationInvocationContext = Object.freeze({
      invocation,
      correlation: this.runActionCorrelation(input.action),
      parentInvocation: input.parentInvocation,
      interruption: this.invocationInterruption(),
    });
    const resolution = await this.dependencies.operations.bindings.resolve({
      operation: registration,
      context,
      request: input.request,
      basis: input.basis,
    });
    if (resolution.status !== "resolved") {
      const result = this.operationFailureResult(
        registration,
        invocation,
        "unavailable",
        "operation-catalog",
        resolution.code,
        this.now(),
        this.now(),
      );
      this.emitOperation(registration, resolutionBindingKind(registration), context, result);
      return result;
    }
    const binding = resolution.binding;
    if (!bindingMatchesResolution(registration, context, binding)) {
      const result = this.operationFailureResult(
        registration,
        invocation,
        "invalid",
        "operation-catalog",
        "operation_binding_mismatch",
        this.now(),
        this.now(),
      );
      this.emitOperation(registration, binding.kind, context, result);
      return result;
    }

    const startedAt = this.now();
    this.emit("operation.started", {
      invocationId: invocation.id,
      operationNamespace: invocation.operation.operation.namespace,
      operationName: invocation.operation.operation.name,
      operationRevision: invocation.operation.revision,
      semanticOwner: registration.operation.semanticOwner,
      bindingKind: binding.kind,
      correlationKind: context.correlation.kind,
      parentInvocationId: context.parentInvocation?.id ?? null,
      parentRunActionId: input.action.ref.id,
    }, startedAt);
    let result: OperationResult;
    try {
      const execute = () => this.executeResolvedBinding(
        registration,
        input.action,
        binding,
        context,
        startedAt,
      );
      result = input.parentInvocation === null
        ? await this.interruptionCoordinator.execute(
            "tool",
            execute,
            this.writer.getSnapshot().deadlineAt,
          )
        : await execute();
    } catch (error) {
      if (error instanceof OperationSettlementTimeoutError) throw error;
      result = this.operationFailureResult(
        registration,
        invocation,
        this.config.cancellation.context.request === null ? "failed" : "cancelled",
        "agent-runtime",
        this.config.cancellation.context.request === null
          ? "operation_execution_failed"
          : "operation_cancelled",
        startedAt,
        this.now(),
      );
    }
    this.emit("operation.finished", {
      invocationId: invocation.id,
      status: result.status,
      code: result.failure?.code ?? null,
      resultId: result.ref.id,
      lowerResultRefs: Object.freeze(result.lowerRefs.map((reference) => reference.id)),
    }, result.finishedAt);
    return result;
  }

  private async executeResolvedBinding(
    registration: RegisteredOperation,
    action: RuntimeRunAction,
    binding: ResolvedOperationBinding,
    context: OperationInvocationContext,
    startedAt: string,
  ): Promise<OperationResult> {
    switch (binding.kind) {
      case "internal": {
        const handler = this.dependencies.operations.internalHandlers.find(
          (candidate) => candidate.id === binding.handlerId,
        );
        if (handler === undefined) {
          return this.operationFailureResult(
            registration,
            binding.invocation,
            "unavailable",
            "agent-runtime",
            "internal_operation_handler_unavailable",
            startedAt,
            this.now(),
          );
        }
        const result = await handler.execute({
          runId: this.runId,
          parentRunAction: action.ref,
          binding,
          deadlineAt: this.writer.getSnapshot().deadlineAt,
          interruption: context.interruption,
        });
        if (
          result.ref.invocation.id !== binding.invocation.id ||
          result.binding.revision !== binding.binding.revision ||
          result.semanticOwner !== registration.operation.semanticOwner
        ) {
          return this.operationFailureResult(
            registration,
            binding.invocation,
            "invalid",
            "agent-runtime",
            "internal_operation_result_mismatch",
            startedAt,
            this.now(),
          );
        }
        return result;
      }
      case "direct":
      case "hosted":
        return this.executeCanonicalAction(registration, action, binding, context, startedAt);
      case "composite":
        return this.executeComposite(registration, action, binding, context, startedAt);
      case "descendant_agent":
        return this.executeDescendant(registration, action, binding, context, startedAt);
    }
  }

  private async executeCanonicalAction(
    registration: RegisteredOperation,
    action: RuntimeRunAction,
    binding: Extract<ResolvedOperationBinding, { readonly kind: "direct" | "hosted" }>,
    context: OperationInvocationContext,
    startedAt: string,
  ): Promise<OperationResult> {
    if (this.actionExecution === null || this.config.actionExecution === null) {
      return this.operationFailureResult(
        registration,
        binding.invocation,
        "unavailable",
        "action-execution",
        "action_execution_unavailable",
        startedAt,
        this.now(),
      );
    }
    const outcome = await this.actionExecution.execute({
      action: Object.freeze({ id: this.id("action") }),
      parentRunAction: action.ref,
      runId: this.runId,
      binding,
      securityContext: this.config.actionExecution.securityContext,
      policyContext: Object.freeze({
        policySnapshotId: this.config.actionExecution.policySnapshotId,
        workspaceTrustState: this.config.actionExecution.securityContext.workspace?.trustState ?? null,
        identityId: this.config.identity.id,
        environmentId: this.config.actionExecution.securityContext.environment.environmentId,
        metadata: this.config.actionExecution.metadata,
      }),
      permissionContext: () => this.actionPermissionContext(),
      enforcement: this.config.actionExecution.enforcement,
      interruption: context.interruption,
      deadlineAt: this.writer.getSnapshot().deadlineAt,
      maxAttempts: this.config.retry.action.maxAttempts,
    });
    if (outcome.status === "pending_interaction") {
      return this.operationFailureResult(
        registration,
        binding.invocation,
        "failed",
        "action-execution",
        "action_approval_not_coordinated",
        startedAt,
        this.now(),
      );
    }
    return operationResultFromAction(
      registration,
      binding,
      outcome,
      startedAt,
      this.now(),
      this.id("operation_result"),
    );
  }

  private async executeComposite(
    registration: RegisteredOperation,
    action: RuntimeRunAction,
    binding: Extract<ResolvedOperationBinding, { readonly kind: "composite" }>,
    context: OperationInvocationContext,
    startedAt: string,
  ): Promise<OperationResult> {
    const resolved = this.dependencies.operations.composite?.resolve(
      binding.compositeDefinitionRef,
    ) ?? null;
    if (resolved === null || resolved.definition.retiredAt !== null) {
      return this.operationFailureResult(
        registration,
        binding.invocation,
        "unavailable",
        "operation-composition",
        "composite_definition_unavailable",
        startedAt,
        this.now(),
      );
    }
    const compositeId = this.id("composite");
    const pending: PendingRunSubject = Object.freeze({
      kind: "composite",
      compositeId,
      nodeId: "aggregate",
      branchId: action.ref.id,
      required: true,
      openedInRunRevision: this.writer.getSnapshot().revision,
    });
    this.addPending(pending);
    try {
      const execution = new CompositeExecution(
        compositeId,
        resolved.definition,
        {
          ...resolved.execution,
          now: this.dependencies.now,
          children: {
            start: async (child) => {
              const invocationId = this.id("operation_invocation");
              const childAction = this.materializeWorkflowRunAction({
                operation: child.node.operation,
                invocationId,
                compositeId,
                nodeId: child.node.id,
              });
              const result = await this.executeOperation({
                action: childAction,
                operation: child.node.operation,
                request: child.request,
                requestOrigin: "trusted_workflow",
                invocationId,
                parentInvocation: binding.invocation,
                basis: child,
              });
              if (result === null) {
                throw new Error("Composite child Operation was rejected before materialization.");
              }
              this.commitOperationObservation(childAction, { result, toolResult: null });
              return Object.freeze({ runAction: childAction.ref, result });
            },
          },
        },
      );
      const result = await execution.run(binding.request, context.interruption);
      return operationResultFromComposite(
        registration,
        binding,
        result,
        startedAt,
        this.now(),
        this.id("operation_result"),
      );
    } finally {
      this.removePending(pending, "resolved", null);
    }
  }

  private async executeDescendant(
    registration: RegisteredOperation,
    action: RuntimeRunAction,
    binding: Extract<ResolvedOperationBinding, { readonly kind: "descendant_agent" }>,
    context: OperationInvocationContext,
    startedAt: string,
  ): Promise<OperationResult> {
    if (
      this.dependencies.operations.descendants === undefined ||
      this.descendantCount >= this.config.limits.maxDescendantRuns ||
      this.config.descendantDepth >= this.config.limits.maxDescendantDepth
    ) {
      return this.operationFailureResult(
        registration,
        binding.invocation,
        "unavailable",
        "agent-runtime",
        "descendant_run_unavailable",
        startedAt,
        this.now(),
      );
    }
    const prepared = await this.dependencies.operations.descendants.prepare({
      parentRunId: this.runId,
      parentRunAction: action.ref,
      targetAgent: binding.agentRef,
      delegatedInput: binding.request,
      parentConfig: this.config,
    });
    if (!sameAgentRef(prepared.agent, binding.agentRef)) {
      return this.operationFailureResult(
        registration,
        binding.invocation,
        "invalid",
        "agent-runtime",
        "descendant_agent_mismatch",
        startedAt,
        this.now(),
      );
    }
    this.descendantCount += 1;
    const relationId = this.id("descendant_relation");
    const childRunner = new (await import("./Runner.js")).Runner({
      ...this.dependencies,
      createRunId: () => `${relationId}:run`,
    });
    const child = childRunner.start(prepared.agent, prepared.input, {
      ...prepared.config,
      descendantDepth: this.config.descendantDepth + 1,
    });
    this.childHandles.add(child);
    const pending: PendingRunSubject = Object.freeze({
      kind: "descendant_run",
      relationId,
      childRunId: child.runId,
      branchId: action.ref.id,
      required: true,
      openedInRunRevision: this.writer.getSnapshot().revision,
    });
    this.addPending(pending);
    const cancelChild = (): void => {
      const request = this.config.cancellation.context.request;
      if (request !== null) {
        child.cancel({
          origin: "parent_run",
          reasonCode: "parent_run_cancelled",
          parentRunId: this.runId,
        });
      }
    };
    this.config.cancellation.context.signal.addEventListener("abort", cancelChild, { once: true });
    const unsubscribe = child.subscribe(() => this.publishCurrentState());
    try {
      const childResult = await child.wait();
      const mapped = prepared.mapResult(childResult);
      return createOperationResult({
        ref: Object.freeze({ invocation: binding.invocation, id: this.id("operation_result") }),
        binding: binding.binding,
        semanticOwner: registration.operation.semanticOwner,
        status: mapped.status,
        output: mapped.output,
        failure: mapped.failure,
        startedAt,
        finishedAt: this.now(),
        lowerRefs: Object.freeze([{
          owner: "agent-runtime",
          kind: "descendant_run_result",
          id: childResult.runId,
          revision: String(childResult.items.at(-1)?.committedInRevision ?? 0),
        }]),
        metadata: Object.freeze({
          relationId,
          contextManifestRef: prepared.contextManifestRef,
          visibility: prepared.visibility,
        }),
      } as OperationResult);
    } finally {
      unsubscribe();
      this.childHandles.delete(child);
      this.config.cancellation.context.signal.removeEventListener("abort", cancelChild);
      this.removePending(pending, "resolved", null);
    }
  }

  private commitOperationObservation(
    action: RuntimeRunAction,
    outcome: OperationExecutionOutcome,
  ): void {
    const lowerRefs = [
      {
        owner: outcome.result.semanticOwner,
        kind: "operation_result",
        id: outcome.result.ref.id,
        revision: outcome.result.binding.revision,
      },
      ...(outcome.toolResult === null
        ? []
        : [{
            owner: "tools",
            kind: "tool_result",
            id: outcome.toolResult.toolCall.toolCallId,
            revision: outcome.toolResult.toolCall.toolRevision.revision,
          }]),
    ];
    this.commitObservation(action, {
      kind: "operation",
      result: outcome.result,
      toolResult: outcome.toolResult,
    }, lowerRefs, outcome.result.semanticOwner);
  }

  private commitRejectedOperation(
    action: RuntimeRunAction,
    owner: string,
    code: string,
    message: string,
  ): void {
    this.commitObservation(action, {
      kind: "operation_rejected",
      owner,
      code,
      message,
    }, [], owner);
  }

  private commitInteractionObservation(
    action: RuntimeRunAction,
    settlement: RuntimeInteractionSettlement,
  ): void {
    if (settlement.status === "resolved") {
      this.commitObservation(action, {
        kind: "interaction",
        owner: settlement.outcome.request.protocol.owner,
        status: "resolved",
        value: settlement.applicationValue,
      }, [{
        owner: settlement.outcome.request.protocol.owner,
        kind: "interaction_resolution",
        id: settlement.outcome.resolution.resolutionId,
        revision: settlement.outcome.resolution.resolutionRevision,
      }], settlement.outcome.request.protocol.owner);
      return;
    }
    this.commitObservation(action, {
      kind: "interaction",
      owner: settlement.owner,
      status: settlement.status,
      value: Object.freeze({ code: settlement.code }),
    }, [], settlement.owner);
  }

  private commitObservation(
    action: RuntimeRunAction,
    payload: RunObservation["payload"],
    lowerRefs: RunObservation["lowerRefs"],
    owner: string,
  ): void {
    const state = this.writer.getSnapshot();
    const sequence = state.counters.observations + 1;
    const observation = createRunObservation({
      id: this.id("observation", sequence),
      runId: this.runId,
      actionId: action.ref.id,
      kind: payload.kind,
      createdAt: this.now(),
      metadata: Object.freeze({}),
      owner,
      runAction: action.ref,
      lowerRefs: Object.freeze([...lowerRefs]),
      payload,
    });
    const failed = observationFailed(observation);
    this.writer.commit({ kind: "observation", observation }, (current) => Object.freeze({
      context: applyContextUpdate(current.context, {
        observations: Object.freeze([observation]),
      }),
      counters: Object.freeze({
        ...current.counters,
        observations: sequence,
        consecutiveActionFailures: failed
          ? current.counters.consecutiveActionFailures + 1
          : 0,
      }),
    }));
  }

  private openPendingInteraction(pending: PendingInteractionRef): void {
    const value: PendingRunSubject = Object.freeze({
      kind: "interaction",
      interaction: pending,
      branchId: pending.request.id,
      required: pending.blockingScope !== "none",
      openedInRunRevision: this.writer.getSnapshot().revision,
    });
    this.writer.commit({
      kind: "pending_transition",
      transition: "opened",
      pending: value,
      recordRef: pending.request.id,
    }, (current) => {
      const nextPending = Object.freeze([...current.pending, value]);
      return Object.freeze({
        pending: nextPending,
        status: deriveActiveStatus(current.status, nextPending),
      });
    });
    this.emit("interaction.opened", {
      requestId: pending.request.id,
      protocolOwner: pending.request.protocol.owner,
      protocolKind: pending.request.protocol.kind,
      protocolRevision: pending.request.protocol.revision,
      subjectOwner: pending.request.subject.owner,
      subjectKind: pending.request.subject.kind,
      subjectId: pending.request.subject.id,
      subjectRevision: pending.request.subject.revision,
      blockingScope: pending.blockingScope,
      pendingVersion: pending.request.requestVersion,
      parentRunActionId: findParentRunActionId(this.writer.getSnapshot(), pending.request.id),
    });
  }

  private settlePendingInteraction(
    pending: PendingInteractionRef,
    terminal: InteractionTerminalRecord,
    settlement: RuntimeInteractionSettlement,
  ): void {
    const state = this.writer.getSnapshot();
    const current = state.pending.find((candidate) =>
      candidate.kind === "interaction" && sameInteractionRequest(
        candidate.interaction.request,
        pending.request,
      )
    );
    if (current === undefined) return;
    const transition = terminal.kind;
    const recordRef = terminalRecordRef(terminal);
    this.writer.commit({
      kind: "pending_transition",
      transition,
      pending: current,
      recordRef,
    }, (snapshot) => {
      const nextPending = Object.freeze(snapshot.pending.filter((candidate) => candidate !== current));
      return Object.freeze({
        pending: nextPending,
        status: deriveActiveStatus(snapshot.status, nextPending),
      });
    });
    this.emit("interaction.settled", {
      requestId: pending.request.id,
      pendingVersion: pending.request.requestVersion,
      lifecycle: settlement.status,
      code: settlement.status === "resolved" ? null : settlement.code,
      terminalRecordId: recordRef,
    });
  }

  private queueInteractionSettlement(
    pending: PendingInteractionRef,
    terminal: InteractionTerminalRecord,
    settlement: RuntimeInteractionSettlement,
  ): void {
    const key = interactionRequestKey(pending.request);
    this.interactionSettlements.push(Object.freeze({
      pending,
      terminal,
      settlement,
      action: this.interactionActions.get(key) ?? null,
    }));
    this.interactionActions.delete(key);
  }

  private drainInteractionSettlements(): number {
    let count = 0;
    while (this.interactionSettlements.length > 0) {
      const queued = this.interactionSettlements.shift()!;
      this.settlePendingInteraction(queued.pending, queued.terminal, queued.settlement);
      if (queued.action !== null) {
        this.commitInteractionObservation(queued.action, queued.settlement);
      }
      count += 1;
    }
    return count;
  }

  private addPending(pending: PendingRunSubject): void {
    this.writer.commit({
      kind: "pending_transition",
      transition: "opened",
      pending,
      recordRef: null,
    }, (current) => {
      const next = Object.freeze([...current.pending, pending]);
      return Object.freeze({ pending: next, status: deriveActiveStatus(current.status, next) });
    });
  }

  private removePending(
    pending: PendingRunSubject,
    transition: "resolved" | "cancelled" | "failed" | "invalidated" | "expired",
    recordRef: string | null,
  ): void {
    const current = this.writer.getSnapshot();
    if (!current.pending.includes(pending)) return;
    this.writer.commit({
      kind: "pending_transition",
      transition,
      pending,
      recordRef,
    }, (state) => {
      const next = Object.freeze(state.pending.filter((candidate) => candidate !== pending));
      return Object.freeze({ pending: next, status: deriveActiveStatus(state.status, next) });
    });
  }

  private createActionApprovalPort(): ActionApprovalResolutionPort {
    return Object.freeze({
      resolve: async (
        input: Parameters<ActionApprovalResolutionPort["resolve"]>[0],
      ) => {
        const reviewer = this.config.permissions.reviewer;
        if (reviewer === null) {
          return Object.freeze({
            status: "failed" as const,
            code: "approval_reviewer_unavailable",
          });
        }
        const activity = this.writer.getSnapshot().permission.approvalActivity;
        const fingerprint = input.assessment.requirement.subject.actionFingerprint;
        const byFingerprint = activity.requestsByActionFingerprint[fingerprint] ?? 0;
        const limits = this.config.permissions.approvalLimits;
        if (
          activity.requestCount >= limits.maxRequestsPerRun ||
          byFingerprint >= limits.maxRequestsPerActionFingerprint ||
          activity.consecutiveDeclines >= limits.maxConsecutiveDeclines ||
          activity.consecutiveReviewFailures >= limits.maxConsecutiveReviewFailures
        ) {
          return Object.freeze({ status: "denied" as const, code: "approval_limit_reached" });
        }
        if (input.parentRunAction === null) {
          return Object.freeze({ status: "failed" as const, code: "approval_parent_action_missing" });
        }
        const requestId = this.id("interaction_request", this.nextInteractionRequest++);
        const pendingVersion = 1;
        const createdAt = this.now();
        this.updateApprovalActivity((current) => ({
          ...current,
          requestCount: current.requestCount + 1,
          requestsByActionFingerprint: Object.freeze({
            ...current.requestsByActionFingerprint,
            [fingerprint]: byFingerprint + 1,
          }),
        }));
        const opened = this.interactions.open({
          requestId,
          protocol: APPROVAL_INTERACTION_PROTOCOL,
          subject: Object.freeze({
            requirement: input.assessment.requirement,
            pendingVersion,
            createdAt,
          } satisfies ApprovalInteractionSubject),
          subjectRef: Object.freeze({
            owner: "permission",
            kind: "approval",
            id: input.action.id,
            revision: fingerprint,
          }),
          correlation: this.runActionCorrelationByRef(input.parentRunAction),
          parentRunAction: input.parentRunAction,
          presentation: createApprovalInteractionPresentation({
            requestId,
            requirement: input.assessment.requirement,
            createdAt,
          }),
          requestVersion: pendingVersion,
          expiresAt: input.assessment.requirement.deadlineAt,
          blockingScope: "run",
          createdAt,
        });
        if (opened.status !== "opened") {
          this.updateApprovalActivity((current) => ({
            ...current,
            consecutiveReviewFailures: current.consecutiveReviewFailures + 1,
          }));
          return Object.freeze({ status: "failed" as const, code: opened.code });
        }

        if (reviewer.kind === "auto_review") {
          const review: ApprovalReviewInput = Object.freeze({
            request: opened.envelope.presentation as ApprovalReviewInput["request"],
            pendingVersion,
            context: Object.freeze({
              workspaceTrustState: this.config.workspace?.primary.trustState ?? null,
              ruleOutcome: "none",
              currentAuthority: Object.freeze({
                fileSystemRead: this.writer.getSnapshot().permission.runPermissionGrants.length > 0,
                fileSystemWrite: this.writer.getSnapshot().permission.runPermissionGrants.length > 0,
                network: this.writer.getSnapshot().permission.runPermissionGrants.length > 0,
              }),
              annotations: Object.freeze({}),
            }),
          });
          const reviewStartedAt = this.now();
          const reviewResult = await executeApprovalReviewer({
            reviewer,
            review,
            operationId: `${requestId}:review`,
            startedAt: reviewStartedAt,
            deadlineAt: deriveApprovalReviewDeadline({
              runDeadlineAt: this.writer.getSnapshot().deadlineAt,
              reviewStartedAt,
              reviewTimeoutMs: reviewer.reviewTimeoutMs,
            }),
            retryPolicy: this.config.retry.providerRequest,
            retryExecutor: this.dependencies.retryExecutor,
            cancellation: this.config.cancellation.context,
            events: this.retryEvents(),
            now: this.dependencies.now,
          });
          if (reviewResult.kind === "failed") {
            this.interactions.fail(opened.pending.request, "permission", reviewResult.failure.code);
            this.updateApprovalActivity((current) => ({
              ...current,
              consecutiveReviewFailures: current.consecutiveReviewFailures + 1,
            }));
          } else if (reviewResult.kind === "cancelled") {
            this.interactions.invalidate(opened.pending.request, "approval_review_cancelled");
          } else {
            this.interactions.submit({
              request: opened.pending.request,
              submissionId: reviewResult.outcome.submission.submissionId,
              contentDigest: approvalSubmissionDigest(reviewResult.outcome.submission),
              payload: reviewResult.outcome.submission,
              receivedAt: this.now(),
            });
          }
        }
        const settlement = await opened.completion;
        this.drainInteractionSettlements();
        if (settlement.status !== "resolved") {
          return Object.freeze({
            status: settlement.status === "expired" || settlement.status === "invalidated" || settlement.status === "cancelled"
              ? settlement.status
              : "failed",
            code: settlement.code,
          }) as Awaited<ReturnType<ActionApprovalResolutionPort["resolve"]>>;
        }
        const resolution = settlement.resolutionValue as ApprovalInteractionResolution;
        if (resolution.decision.kind === "decline") {
          this.updateApprovalActivity((current) => ({
            ...current,
            consecutiveDeclines: current.consecutiveDeclines + 1,
            consecutiveReviewFailures: 0,
          }));
          return Object.freeze({ status: "denied" as const, code: "approval_declined" });
        }
        if (resolution.decision.kind === "cancel") {
          this.config.cancellation.requestCancellation({
            origin: "approval",
            reasonCode: "approval_cancelled",
            approvalRequestId: requestId,
          });
          return Object.freeze({ status: "cancelled" as const, code: "approval_cancelled" });
        }
        const application = settlement.applicationValue as ApprovalApplicationOutcome;
        if (application.kind !== "applied") {
          return Object.freeze({
            status: application.kind === "interrupted" ? "interrupted" :
              application.kind === "outcome_unknown" ? "unknown_effect" : "failed",
            code: "code" in application ? application.code : "approval_authority_not_applied",
          });
        }
        this.updateApprovalActivity((current) => ({
          ...current,
          consecutiveDeclines: 0,
          consecutiveReviewFailures: 0,
        }));
        return Object.freeze({
          status: "applied" as const,
          approvalRecordId: settlement.outcome.resolution.resolutionId,
          authoritySnapshotId: `run-permission:${this.writer.getSnapshot().revision}`,
        });
      },
    });
  }

  private validateApprovalDecision(
    subject: ApprovalInteractionSubject,
    submission: import("@agent-anything/permission/approval").ApprovalDecisionSubmission,
    requestId: string,
  ): ValidatedApprovalDecision {
    const request = createApprovalRequest({
      id: requestId,
      requirement: subject.requirement,
      createdAt: subject.createdAt,
    });
    const profile = this.config.permissions.permissionProfile;
    const cwd = profile.workspaceRoots[0]?.canonicalPath ??
      (profile.platform === "win32" ? "C:/" : "/");
    const result = validateApprovalDecision({
      request: request as import("@agent-anything/permission/approval").ApprovalRequest,
      pendingVersion: subject.pendingVersion,
      submission,
      cwd,
      environment: Object.freeze({
        environmentId: profile.environmentId,
        platform: profile.platform,
        workspaceRoots: Object.freeze(profile.workspaceRoots.map((root) => Object.freeze({
          rootId: root.rootId,
          path: root.canonicalPath,
        }))),
      }),
      managedConstraints: this.config.permissions.managedConstraints,
      identities: Object.freeze({
        actionAuthorityId: this.id("authority_record"),
        runPermissionGrantId: this.id("authority_record"),
        sessionAuthorityRecordId: this.id("authority_record"),
      }),
      validatedAt: this.now(),
    });
    if (result.status !== "valid") throw new TypeError(result.message);
    return result.decision;
  }

  private async applyApprovalDecision(
    subject: ApprovalInteractionSubject,
    resolution: ApprovalInteractionResolution,
    requestId: string,
  ): Promise<ApprovalApplicationOutcome> {
    const immediate = applyImmediateApprovalAuthority({
      permission: this.writer.getSnapshot().permission,
      decision: resolution.decision,
    });
    if (immediate.status === "applied") {
      this.writer.commitState(() => Object.freeze({ permission: immediate.permission }));
      return immediate.application;
    }
    if (immediate.status === "not_applicable") return immediate.application;
    if (!isDurableAuthorityDecision(resolution.decision)) {
      return Object.freeze({ kind: "not_applied", code: "approval_authority_invalid" });
    }
    const startedAt = this.now();
    const result = await executeAuthorityCommit({
      decision: resolution.decision,
      pending: Object.freeze({
        requestId,
        actionFingerprint: subject.requirement.subject.actionFingerprint,
        authorityOperationId: resolution.resolutionId,
      }),
      config: this.config.permissions,
      cancellation: this.config.cancellation.context,
      startedAt,
      deadlineAt: deriveAuthorityCommitDeadline({
        runDeadlineAt: this.writer.getSnapshot().deadlineAt,
        commitStartedAt: startedAt,
        commitTimeoutMs: this.config.permissions.authorityApplicationLimits.commitTimeoutMs,
      }),
      policyAmendmentRecordId: this.id("authority_record"),
      now: this.dependencies.now,
    });
    if (result.kind === "applied") {
      const permission = result.owner === "permission"
        ? applyCommittedSessionAuthority({
            permission: this.writer.getSnapshot().permission,
            record: result.record as import("@agent-anything/permission").SessionAuthorityRecord,
          })
        : applyCommittedPolicyAmendment({
            permission: this.writer.getSnapshot().permission,
            record: result.record as import("@agent-anything/governance").AppliedPolicyAmendmentRecord,
          });
      this.writer.commitState(() => Object.freeze({ permission }));
    }
    return result.application;
  }

  private consumeApprovalCoverage(coverageId: string): boolean {
    const current = this.writer.getSnapshot().permission;
    const coverage = current.actionCoverage.find((candidate) => candidate.id === coverageId);
    if (coverage === undefined) return false;
    const result = consumeActionApprovalCoverage({
      permission: current,
      coverageId,
      runId: coverage.runId,
      actionId: coverage.actionId,
      actionFingerprint: coverage.actionFingerprint,
    });
    if (result.status !== "consumed") return false;
    this.writer.commitState(() => Object.freeze({ permission: result.permission }));
    return true;
  }

  private actionPermissionContext() {
    const state = this.writer.getSnapshot();
    return Object.freeze({
      authoritySnapshotId: `run-permission:${state.revision}`,
      profile: this.config.permissions.permissionProfile,
      approvalPolicy: this.config.permissions.approvalPolicy,
      actionCoverage: state.permission.actionCoverage,
      runGrants: state.permission.runPermissionGrants,
      sessionAuthority: state.permission.sessionAuthorityRecords,
      sessionAuthorityContext: this.config.permissions.sessionAuthority?.context ?? null,
    });
  }

  private updateApprovalActivity(
    update: (current: RunState["permission"]["approvalActivity"]) =>
      RunState["permission"]["approvalActivity"],
  ): void {
    this.writer.commitState((state) => Object.freeze({
      permission: Object.freeze({
        ...state.permission,
        approvalActivity: Object.freeze(update(state.permission.approvalActivity)),
      }),
    }));
  }

  private enterCancelling(request: import("../run/index.js").RunCancellationRequest): void {
    const state = this.writer.getSnapshot();
    if (!isActiveStatus(state.status)) return;
    const summary = toRunCancellationSummary(request);
    this.writer.commit({
      kind: "cancellation_transition",
      transition: "requested",
      cancellation: summary,
    }, () => Object.freeze({
      status: "cancelling" as const,
      cancellationRequest: request,
    }));
    this.interactions.cancelAll(request.id);
  }

  private async settle(candidate: TerminalCandidate<TOutput>): Promise<RunResult<TOutput>> {
    if (this.terminalResult !== null) return this.terminalResult;
    this.interactions.close();
    this.drainInteractionSettlements();
    let terminal = candidate;
    const stateBeforeFinalization = this.writer.getSnapshot();
    if (stateBeforeFinalization.plan?.status === "active") {
      const abandoned = abandonPlan({
        plan: stateBeforeFinalization.plan,
        terminalStatus: terminal.status,
        reasonCode: terminal.status === "failed" || terminal.status === "blocked"
          ? terminal.code
          : terminal.status === "cancelled"
            ? "runtime_cancelled"
            : null,
        now: this.now(),
      });
      if (abandoned.status === "abandoned") {
        this.writer.commit({
          kind: "state_transition",
          transition: "plan",
          previousRevision: stateBeforeFinalization.plan.version,
          plan: projectPlan(abandoned.plan),
        }, () => Object.freeze({ plan: abandoned.plan }));
      }
    }

    const finalization = createRunFinalizationContext({
      runId: this.runId,
      cancellation: this.config.cancellation.context.request === null
        ? null
        : toRunCancellationSummary(this.config.cancellation.context.request),
      timeoutMs: this.config.cancellationLimits.finalizationTimeoutMs,
      startedAt: this.now(),
    });
    try {
      const failures = await this.recordLifecycle(
        terminal.status,
        new Set(),
        finalizationObservabilityContext(finalization.context),
      );
      if (failures.length > 0) {
        terminal = {
          status: "failed",
          code: "required_finalization_failed",
          failure: failures[0]!,
          relatedFailures: failures.slice(1),
        };
      }
    } finally {
      finalization.dispose();
    }

    const completedAt = this.now();
    const cancellationRequest = this.config.cancellation.context.request;
    const payload: RunItemPayload<TOutput> = terminal.status === "succeeded"
      ? {
          kind: "terminal_transition",
          status: "succeeded",
          code: null,
          output: terminal.output,
          failure: null,
        }
      : terminal.status === "blocked"
        ? {
            kind: "terminal_transition",
            status: "blocked",
            code: terminal.code,
            output: null,
            failure: null,
          }
        : terminal.status === "cancelled"
          ? {
              kind: "terminal_transition",
              status: "cancelled",
              code: "runtime_cancelled",
              output: null,
              failure: null,
            }
          : {
              kind: "terminal_transition",
              status: "failed",
              code: terminal.code,
              output: null,
              failure: terminal.failure,
            };
    this.writer.commit(payload, () => terminalStatePatch(
      terminal,
      cancellationRequest,
      completedAt,
    ));
    const state = this.writer.getSnapshot();
    const base = {
      runId: this.runId,
      taskId: state.taskId,
      startingAgent: state.startingAgent,
      finalActiveAgent: state.activeAgent,
      startedAt: state.startedAt,
      completedAt,
      items: state.items,
      evidenceRefs: state.evidenceRefs,
      artifactRefs: state.artifactRefs,
      metadata: state.metadata,
    };
    const result = terminal.status === "succeeded"
      ? createSucceededRunResult(base, terminal.output)
      : terminal.status === "blocked"
        ? createBlockedRunResult<TOutput>(base, terminal.code)
        : terminal.status === "cancelled"
          ? createCancelledRunResult<TOutput>(
              base,
              toRunCancellationSummary(requireCancellation(cancellationRequest)),
            )
          : createFailedRunResult<TOutput>(
              base,
              terminal.code,
              terminal.failure,
              terminal.relatedFailures ?? [],
              cancellationRequest === null ? null : toRunCancellationSummary(cancellationRequest),
            );
    this.terminalResult = result;
    this.emitTerminal(result);
    completeRunnerTrace(this.traceAssembler, result);
    this.publishCurrentState();
    return result;
  }

  private failureFromError(error: unknown): Extract<TerminalCandidate<TOutput>, { readonly status: "failed" }> {
    if (error instanceof ContextProjectionError) {
      return {
        status: "failed",
        code: "context_projection_failed",
        failure: createRunFailureCause("context", error.failure),
      };
    }
    if (error instanceof ControllerError) {
      return {
        status: "failed",
        code: "controller_failed",
        failure: createRunFailureCause(error.failure.kind, error.failure.failure),
      } as Extract<TerminalCandidate<TOutput>, { readonly status: "failed" }>;
    }
    if (error instanceof OperationSettlementTimeoutError) {
      return {
        status: "failed",
        code: "unknown_effect",
        failure: runtimeFailure(
          "runtime_operation_settlement_unconfirmed",
          error.message,
          { operation: error.operation, interruptionKind: error.interruptionKind },
        ),
      };
    }
    return {
      status: "failed",
      code: "runtime_execution_failed",
      failure: runtimeFailure(
        "runtime_execution_failed",
        error instanceof Error ? error.message : "Agent Runtime execution failed.",
        error instanceof Error ? { causeName: error.name } : {},
      ),
    };
  }

  private operationFailureResult(
    registration: RegisteredOperation,
    invocation: OperationInvocationRef,
    status: Exclude<OperationResult["status"], "succeeded" | "partial">,
    owner: string,
    code: string,
    startedAt: string,
    finishedAt: string,
  ): OperationResult {
    return createOperationResult({
      ref: Object.freeze({ invocation, id: this.id("operation_result") }),
      binding: registration.binding.ref,
      semanticOwner: registration.operation.semanticOwner,
      status,
      output: null,
      failure: operationFailure(owner, code),
      startedAt,
      finishedAt,
      lowerRefs: Object.freeze([]),
      metadata: Object.freeze({}),
    });
  }

  private emitOperation(
    registration: RegisteredOperation,
    bindingKind: ResolvedOperationBinding["kind"],
    context: OperationInvocationContext,
    result: OperationResult,
  ): void {
    this.emit("operation.started", {
      invocationId: context.invocation.id,
      operationNamespace: context.invocation.operation.operation.namespace,
      operationName: context.invocation.operation.operation.name,
      operationRevision: context.invocation.operation.revision,
      semanticOwner: registration.operation.semanticOwner,
      bindingKind,
      correlationKind: context.correlation.kind,
      parentInvocationId: context.parentInvocation?.id ?? null,
      parentRunActionId: context.correlation.kind === "run_action"
        ? context.correlation.runAction.id
        : null,
    }, result.startedAt);
    this.emit("operation.finished", {
      invocationId: context.invocation.id,
      status: result.status,
      code: result.failure?.code ?? null,
      resultId: result.ref.id,
      lowerResultRefs: Object.freeze([]),
    }, result.finishedAt);
  }

  private runActionCorrelation(action: RuntimeRunAction): OperationCorrelation {
    return Object.freeze({
      kind: "run_action",
      run: action.ref.run,
      runAction: action.ref,
      provenance: action.provenance,
      materializationRevision: action.basis.runRevision,
    });
  }

  private runActionCorrelationByRef(ref: RunActionRef): OperationCorrelation {
    const item = this.writer.getSnapshot().items.find(
      (candidate) => candidate.payload.kind === "run_action" &&
        candidate.payload.action.ref.id === ref.id,
    );
    if (item?.payload.kind !== "run_action") {
      throw new TypeError("Approval parent RunAction is not committed in this Run.");
    }
    return this.runActionCorrelation(item.payload.action);
  }

  private invocationInterruption(): InvocationInterruptionContext {
    const context = this.config.cancellation.context;
    return Object.freeze({
      signal: context.signal,
      get interruption() {
        const request = context.request;
        return request === null || !context.signal.aborted
          ? null
          : Object.freeze({
              kind: "run_cancellation" as const,
              cancellation: Object.freeze({
                runId: request.runId,
                requestId: request.id,
              }),
            });
      },
    });
  }

  private retryEvents(): RetryEventSink {
    return Object.freeze({
      emit: (candidate: import("../retry/index.js").RetryEvent) => {
        this.recordRetry(snapshotRetryEvent(candidate, this.runId));
        this.publishCurrentState();
      },
    });
  }

  private recordRetry(event: import("../retry/index.js").RetryEvent): void {
    const current = this.retryProjection ?? Object.freeze({
      attemptCount: 0,
      scheduledCount: 0,
      fallbackCount: 0,
      exhaustedCount: 0,
      cancellationCount: 0,
      omittedEventCount: 0,
      recentEvents: Object.freeze([]),
    });
    const events = [...current.recentEvents, event];
    const omitted = Math.max(0, events.length - 16);
    this.retryProjection = Object.freeze({
      attemptCount: current.attemptCount + (event.type === "retry_attempt_started" ? 1 : 0),
      scheduledCount: current.scheduledCount + (event.type === "retry_scheduled" ? 1 : 0),
      fallbackCount: current.fallbackCount + (event.type === "retry_fallback_selected" ? 1 : 0),
      exhaustedCount: current.exhaustedCount + (event.type === "retry_exhausted" ? 1 : 0),
      cancellationCount: current.cancellationCount + (event.type === "retry_cancelled" ? 1 : 0),
      omittedEventCount: current.omittedEventCount + omitted,
      recentEvents: Object.freeze(events.slice(omitted)),
    });
  }

  private onStateCommitted(state: RunState<TOutput>): void {
    while (this.emittedItemCount < state.items.length) {
      const item = state.items[this.emittedItemCount++]!;
      this.emit("run.item.appended", {
        itemId: item.ref.id,
        itemKind: item.payload.kind,
        itemSequence: item.ref.sequence,
      }, item.createdAt);
    }
    this.publishCurrentState();
  }

  private publishCurrentState(): void {
    const state = this.writer.getSnapshot();
    const childPending = [...this.childHandles].flatMap((handle) =>
      handle.getSnapshot().pendingInteractions
    );
    this.onUpdate({
      status: state.status,
      lastRunItemSequence: state.items.at(-1)?.ref.sequence ?? 0,
      plan: state.plan === null ? null : projectPlan(state.plan),
      retry: this.retryProjection,
      pendingInteractions: Object.freeze([
        ...this.interactions.getPendingProjections(),
        ...childPending,
      ]),
      result: this.terminalResult,
    });
  }

  private emit<TName extends RuntimeEventName>(
    name: TName,
    payload: RuntimeEventPayloadMap[TName],
    occurredAt = this.now(),
  ): void {
    try {
      this.eventStream.emit(name, payload, occurredAt);
    } catch {
      // Notifications remain non-authoritative.
    }
  }

  private emitTerminal(result: RunResult<TOutput>): void {
    const payload = {
      status: result.status,
      code: result.code,
      durationMs: Math.max(0, Date.parse(result.completedAt) - this.startedAtMs),
      itemCount: result.items.length,
      evidenceCount: result.evidenceRefs.length,
      artifactCount: result.artifactRefs.length,
      errorCodes: Object.freeze(result.failure === null
        ? []
        : [result.failure.failure.code, ...result.relatedFailures.map((failure) => failure.failure.code)]),
    };
    if (result.status === "succeeded") this.emit("run.completed", { ...payload, status: "succeeded", code: null });
    else if (result.status === "blocked") this.emit("run.blocked", { ...payload, status: "blocked", code: result.code });
    else if (result.status === "cancelled") this.emit("run.cancelled", { ...payload, status: "cancelled", code: result.code });
    else this.emit("run.failed", { ...payload, status: "failed", code: result.code });
  }

  private async recordLifecycle(
    phase: "started" | "succeeded" | "blocked" | "failed" | "cancelled",
    skipKinds = new Set<import("../run/index.js").RunFailureKind>(),
    context: ObservabilityRecordContext = this.runtimeObservabilityContext(),
  ): Promise<RunFailureCause[]> {
    const state = this.writer.getSnapshot();
    return recordRunnerLifecycle({
      phase,
      runId: this.runId,
      taskId: state.taskId,
      agentId: state.activeAgent.id,
      startedAtMs: this.startedAtMs,
      timestamp: this.now(),
      counters: state.counters,
      itemCount: state.items.length,
      workspace: this.config.workspace,
      identity: this.config.identity,
      auditRequirement: this.config.audit,
      telemetryRequirement: this.config.telemetry,
      context,
      auditPort: this.dependencies.auditPort,
      telemetryPort: this.dependencies.telemetryPort,
      skipKinds,
    });
  }

  private runtimeObservabilityContext(): ObservabilityRecordContext {
    return Object.freeze({
      purpose: "runtime",
      signal: this.config.cancellation.context.signal,
      deadlineAt: null,
    });
  }

  private id(kind: Parameters<ResolvedRunnerDependencies["createId"]>[0]["kind"], sequence?: number): string {
    const current = this.identitySequences.get(kind) ?? 0;
    const next = sequence ?? current + 1;
    this.identitySequences.set(kind, Math.max(current, next));
    return this.dependencies.createId({
      kind,
      runId: this.runId,
      sequence: next,
    });
  }

  private now(): string {
    const value = this.dependencies.now();
    if (
      typeof value !== "string" ||
      value.trim().length === 0 ||
      !Number.isFinite(Date.parse(value))
    ) throw new TypeError("Runner clock must return an ISO date-time.");
    return value;
  }
}

function terminalStatePatch<TOutput>(
  terminal: TerminalCandidate<TOutput>,
  cancellationRequest: import("../run/index.js").RunCancellationRequest | null,
  completedAt: string,
): Readonly<Record<string, unknown>> {
  if (terminal.status === "succeeded") return Object.freeze({
    status: "succeeded",
    code: null,
    finalOutput: terminal.output,
    failure: null,
    relatedFailures: Object.freeze([]),
    cancellationRequest: null,
    completedAt,
    pending: Object.freeze([]),
  });
  if (terminal.status === "blocked") return Object.freeze({
    status: "blocked",
    code: terminal.code,
    finalOutput: null,
    failure: null,
    relatedFailures: Object.freeze([]),
    cancellationRequest: null,
    completedAt,
    pending: Object.freeze([]),
  });
  if (terminal.status === "cancelled") return Object.freeze({
    status: "cancelled",
    code: "runtime_cancelled",
    finalOutput: null,
    failure: null,
    relatedFailures: Object.freeze([]),
    cancellationRequest: requireCancellation(cancellationRequest),
    completedAt,
    pending: Object.freeze([]),
  });
  return Object.freeze({
    status: "failed",
    code: terminal.code,
    finalOutput: null,
    failure: terminal.failure,
    relatedFailures: Object.freeze([...(terminal.relatedFailures ?? [])]),
    cancellationRequest,
    completedAt,
    pending: Object.freeze([]),
  });
}

function runtimeFailure(
  code: string,
  message: string,
  metadata: Readonly<Record<string, unknown>> = {},
): Extract<RunFailureCause, { readonly kind: "runtime" }> {
  return createRunFailureCause("runtime", Object.freeze({
    code,
    message,
    retryable: false,
    metadata: Object.freeze({ ...metadata }),
  }));
}

function operationFailure(owner: string, code: string, message = code): OperationFailure {
  return Object.freeze({
    owner,
    code,
    message,
    retryable: false,
    metadata: Object.freeze({}),
  });
}

function operationResultFromAction(
  registration: RegisteredOperation,
  binding: Extract<ResolvedOperationBinding, { readonly kind: "direct" | "hosted" }>,
  outcome: Extract<ActionExecutionResult, { readonly status: "settled" }>,
  startedAt: string,
  finishedAt: string,
  resultId: string,
): OperationResult {
  const semantic = outcome.semanticResult;
  const failure = semantic.failure === null
    ? null
    : operationFailure(semantic.failure.owner, semantic.failure.code, semantic.failure.message);
  return createOperationResult({
    ref: Object.freeze({ invocation: binding.invocation, id: resultId }),
    binding: binding.binding,
    semanticOwner: registration.operation.semanticOwner,
    status: semantic.status,
    output: semantic.output,
    failure,
    startedAt,
    finishedAt,
    lowerRefs: Object.freeze([{
      owner: "canonical-action",
      kind: "action_settlement",
      id: outcome.settlement.ref.id,
      revision: outcome.settlement.subject === null
        ? null
        : String(outcome.settlement.subject.revision),
    }]),
    metadata: Object.freeze({
      actionId: outcome.settlement.action.id,
      effectCertainty: outcome.settlement.effectCertainty,
      completionExtent: outcome.settlement.completionExtent,
    }),
  } as OperationResult);
}

function operationResultFromComposite(
  registration: RegisteredOperation,
  binding: Extract<ResolvedOperationBinding, { readonly kind: "composite" }>,
  result: CompositeResult,
  startedAt: string,
  finishedAt: string,
  resultId: string,
): OperationResult {
  const status = result.status;
  return createOperationResult({
    ref: Object.freeze({ invocation: binding.invocation, id: resultId }),
    binding: binding.binding,
    semanticOwner: registration.operation.semanticOwner,
    status,
    output: result.output,
    failure: result.failure === null
      ? null
      : operationFailure("operation-composition", result.failure.code, result.failure.message),
    startedAt,
    finishedAt,
    lowerRefs: Object.freeze(result.children.flatMap((child) =>
      child.result === null ? [] : [{
        owner: child.result.semanticOwner,
        kind: "operation_result",
        id: child.result.ref.id,
        revision: child.result.binding.revision,
      }]
    )),
    metadata: Object.freeze({
      compositeId: result.compositeId,
      childCount: result.children.length,
    }),
  } as OperationResult);
}

function adaptToolResult(call: ToolCall, result: OperationResult): ToolResult | null {
  try {
    return adaptToolSemanticResult(call, {
      operationInvocation: result.ref.invocation,
      status: result.status === "timed_out" ? "timeout" : result.status,
      output: result.output,
      error: result.failure === null
        ? null
        : Object.freeze({
            code: result.failure.code,
            message: result.failure.message,
            metadata: result.failure.metadata,
          }),
      startedAt: result.startedAt,
      finishedAt: result.finishedAt,
      metadata: result.metadata,
    });
  } catch {
    return null;
  }
}

function observationFailed(observation: RunObservation): boolean {
  switch (observation.payload.kind) {
    case "operation":
      return observation.payload.result.status !== "succeeded" &&
        observation.payload.result.status !== "partial";
    case "operation_rejected":
      return true;
    case "handoff":
      return observation.payload.status !== "applied";
    case "interaction":
      return observation.payload.status !== "resolved";
    case "plan_update":
      return observation.payload.result.status === "rejected";
  }
}

function bindingMatchesResolution(
  registration: RegisteredOperation,
  context: OperationInvocationContext,
  binding: ResolvedOperationBinding,
): boolean {
  return binding.kind === registration.binding.kind &&
    binding.invocation.id === context.invocation.id &&
    binding.invocation.operation.revision === context.invocation.operation.revision &&
    binding.binding.revision === registration.binding.ref.revision &&
    binding.resolverRevision === registration.binding.resolverRevision &&
    binding.correlation.kind === context.correlation.kind;
}

function resolutionBindingKind(registration: RegisteredOperation): ResolvedOperationBinding["kind"] {
  return registration.binding.kind;
}

function sameAgentRef(
  left: { readonly id: string; readonly revision: string },
  right: { readonly id: string; readonly revision: string },
): boolean {
  return left.id === right.id && left.revision === right.revision;
}

function handoffContext(
  policy: SameRunHandoffRequest["transferPolicy"],
  current: Context<RunObservation>,
  projection: ContextProjection<RunObservation>,
  input: RunInput,
): Context<RunObservation> {
  if (policy === "all_context") return current;
  if (policy === "fresh_context") return createInitialContext(input.task);
  return Object.freeze({
    messages: Object.freeze([...projection.messages]),
    observations: Object.freeze([...projection.observations]),
    evidenceRefs: Object.freeze([...projection.evidenceRefs]),
    metadata: Object.freeze({ ...projection.metadata }),
  });
}

function deriveActiveStatus(
  status: RunState["status"],
  pending: readonly PendingRunSubject[],
): RunState["status"] {
  if (!isActiveStatus(status)) return status;
  return deriveActiveRunStatus({ pending, progressableBranchIds: Object.freeze([]) });
}

function isActiveStatus(status: RunState["status"]): boolean {
  return status === "initializing" || status === "running" || status === "waiting";
}

function sameInteractionRequest(
  left: import("@agent-anything/interaction/protocol").InteractionRequestRef,
  right: import("@agent-anything/interaction/protocol").InteractionRequestRef,
): boolean {
  return left.id === right.id &&
    left.requestVersion === right.requestVersion &&
    left.protocol.owner === right.protocol.owner &&
    left.protocol.kind === right.protocol.kind &&
    left.protocol.revision === right.protocol.revision &&
    left.subject.owner === right.subject.owner &&
    left.subject.kind === right.subject.kind &&
    left.subject.id === right.subject.id &&
    left.subject.revision === right.subject.revision;
}

function interactionRequestKey(
  request: import("@agent-anything/interaction/protocol").InteractionRequestRef,
): string {
  return [
    request.protocol.owner,
    request.protocol.kind,
    request.protocol.revision,
    request.id,
    request.requestVersion,
    request.subject.owner,
    request.subject.kind,
    request.subject.id,
    request.subject.revision,
  ].join(":");
}

function terminalRecordRef(record: InteractionTerminalRecord): string {
  return record.kind === "resolved"
    ? record.resolution.resolutionId
    : record.kind === "failed"
      ? record.failureRef
      : `${record.request.id}:${record.kind}`;
}

function findParentRunActionId(
  state: RunState,
  interactionRequestId: string,
): string | null {
  for (const item of state.items) {
    if (
      item.payload.kind === "run_action" &&
      item.payload.action.subject.kind === "interaction" &&
      item.payload.action.subject.request?.id === interactionRequestId
    ) return item.payload.action.ref.id;
  }
  return null;
}

function requireCancellation(
  request: import("../run/index.js").RunCancellationRequest | null,
): import("../run/index.js").RunCancellationRequest {
  if (request === null) throw new TypeError("Cancelled Run requires a cancellation request.");
  return request;
}

function approvalSubmissionDigest(
  submission: import("@agent-anything/permission/approval").ApprovalDecisionSubmission,
): string {
  return JSON.stringify(submission);
}

function finalizationObservabilityContext(
  context: import("../run/index.js").RunFinalizationContext,
): ObservabilityRecordContext {
  return Object.freeze({
    purpose: "finalization",
    signal: context.signal,
    deadlineAt: context.deadlineAt,
  });
}

function composeActionExecutionObservers(
  configured: ActionExecutionObserver | undefined,
  invocation: ActionExecutionObserver | undefined,
): ActionExecutionObserver | undefined {
  const observers = [invocation, configured].filter(
    (observer, index, values): observer is ActionExecutionObserver =>
      observer !== undefined && values.indexOf(observer) === index,
  );
  return observers.length === 0
    ? undefined
    : Object.freeze({
        observe(notification: Parameters<ActionExecutionObserver["observe"]>[0]) {
          for (const observer of observers) {
            try {
              void Promise.resolve(observer.observe(notification)).catch(
                () => undefined,
              );
            } catch {
              // One observer cannot affect execution or another observer.
            }
          }
        },
      });
}
