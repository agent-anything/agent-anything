import type {
  ArtifactRef,
  EvidenceRef,
  ISODateTimeString,
  Metadata,
} from "@agent-anything/shared";
import type { ObservabilityRecordContext } from "@agent-anything/observability";
import {
  createApprovalRequest,
  projectApprovalReviewRequest,
  validateApprovalDecision,
  type ApprovalDecisionOption,
  type ApprovalRecord,
  type ApprovalReviewFailure,
  type ApprovalReviewInput,
  type ApprovalScope,
  type ValidatedApprovalDecision,
} from "@agent-anything/permission";
import type { Agent } from "../agent/index.js";
import {
  ControllerError,
  type ControllerDecision,
  type ControllerInput,
} from "../controller/index.js";
import {
  applyContextUpdate,
  createInitialContext,
  projectContext,
  type Context,
} from "../context/index.js";
import type { RuntimeEventName } from "../events/index.js";
import {
  abandonPlan,
  applyPlanUpdate,
  type Plan,
  type PlanLifecycleChange,
} from "../plan/index.js";
import type { Action, ActionCandidate } from "./Action.js";
import type {
  ActionDeniedObservation,
  ActionFailureObservation,
  ActionRejectedObservation,
  ApprovalDeclinedObservation,
  ApprovalLimitReachedObservation,
  ApprovalPolicyRejectedObservation,
  ApprovalReviewFailedObservation,
  Observation,
  PermissionsGrantedObservation,
  PlanUpdateResultObservation,
  ToolResultObservation,
} from "./Observation.js";
import type {
  CancellationBoundary,
  RunFinalizationContext,
  RunCancellationRequest,
} from "./RunCancellation.js";
import { toRunCancellationSummary } from "./RunCancellation.js";
import { createRunFinalizationContext } from "./RunFinalization.js";
import type { RunConfig } from "./RunConfig.js";
import type { RunInput } from "./RunInput.js";
import type { RunItem, RunItemBase } from "./RunItem.js";
import {
  createBlockedRunResult,
  createCancelledRunResult,
  createFailedRunResult,
  createSucceededRunResult,
  type RunBlockedCode,
  type RunFailureCode,
  type RunResult,
} from "./RunResult.js";
import type { RunnerDependencies } from "./Runner.js";
import { recordRunnerLifecycle } from "./RunnerObservability.js";
import {
  snapshotAgent,
  snapshotRunConfig,
  snapshotRunInput,
  validateControllerDecision,
} from "./RunnerValidation.js";
import type { RunCounters, RunState } from "./RunState.js";
import type { RuntimeError } from "./RuntimeError.js";
import {
  assertRunPermissionStateInvariant,
  createInitialRunPermissionState,
  projectPermissionContext,
  type PendingApproval,
  type RunPermissionState,
} from "./RunPermissionState.js";
import {
  deriveApprovalReviewDeadline,
  deriveRunDeadline,
} from "./RunPermissionConfig.js";
import type { ToolActionObservationPayload } from "./ToolActionBridge.js";
import {
  snapshotRetryEvent,
  type RetryEvent,
  type RetryEventSink,
} from "../retry/index.js";
import {
  executeApprovalReviewer,
  type ApprovalReviewerExecutionResult,
} from "./ApprovalReviewerExecution.js";
import {
  allowsExplicitPermissionRequest,
  preparePermissionRequestAction,
  type PreparedPermissionRequestAction,
} from "./PermissionRequestAction.js";
import {
  applyImmediateApprovalAuthority,
} from "./RunApprovalAuthority.js";
import {
  beginApprovalAuthorityApplication,
  beginApprovalReview,
  settleApproval,
  type ApprovalSettlementCounterEffect,
} from "./RunApprovalLifecycle.js";
import {
  recordApprovalRequestAudit,
  recordApprovalValidatedDecisionAudit,
} from "./RunnerApprovalAudit.js";
import {
  createApprovalRecordSummary,
  createApprovalRequestSummary,
} from "./ApprovalSummary.js";

type ResolvedRunnerDependencies = RunnerDependencies & {
  readonly now: NonNullable<RunnerDependencies["now"]>;
  readonly createId: NonNullable<RunnerDependencies["createId"]>;
  readonly retryExecutor: NonNullable<RunnerDependencies["retryExecutor"]>;
};

type RunItemDraft<TOutput> = (base: RunItemBase) => RunItem<TOutput>;

type TerminalCandidate<TOutput> =
  | {
      readonly status: "succeeded";
      readonly output: NonNullable<TOutput>;
    }
  | {
      readonly status: "blocked";
      readonly code: RunBlockedCode;
      readonly reason: string;
    }
  | {
      readonly status: "failed";
      readonly code: RunFailureCode;
      readonly errors: readonly [RuntimeError, ...RuntimeError[]];
      readonly cancellationRequest: RunCancellationRequest | null;
    }
  | {
      readonly status: "cancelled";
      readonly cancellationRequest: RunCancellationRequest;
    };

interface ProcessActionResult {
  readonly invalidatesBatch: boolean;
  readonly terminalResult: RunResult<unknown> | null;
}

type ActiveBoundaryKind = Extract<
  CancellationBoundary,
  "controller" | "tool" | "approval_reviewer"
>;

interface ActiveBoundary {
  readonly kind: ActiveBoundaryKind;
  readonly startedAt: ISODateTimeString;
  readonly rejectSettlement: (error: CancellationSettlementTimeoutError) => void;
  settlementTimer: ReturnType<typeof setTimeout> | null;
}

class CancellationSettlementTimeoutError extends Error {
  constructor(
    readonly boundary: ActiveBoundaryKind,
    readonly startedAt: ISODateTimeString,
    readonly timeoutMs: number,
  ) {
    super(`Cancellation settlement timed out at the ${boundary} boundary.`);
    this.name = "CancellationSettlementTimeoutError";
  }
}

export class RunExecution<TOutput> {
  private agent!: Agent<TOutput>;
  private input!: RunInput;
  private config!: RunConfig;
  private state!: RunState<TOutput>;
  private startedAtMs = 0;
  private terminalResult: RunResult<TOutput> | null = null;
  private cancellationListener: (() => void) | null = null;
  private activeBoundary: ActiveBoundary | null = null;

  constructor(
    private readonly dependencies: ResolvedRunnerDependencies,
    private readonly rawAgent: Agent<TOutput>,
    private readonly rawInput: RunInput,
    private readonly rawConfig: RunConfig,
  ) {}

  async run(): Promise<RunResult<TOutput>> {
    try {
      return await this.runInternal();
    } finally {
      this.disposeCancellationObservation();
      this.clearActiveBoundary();
    }
  }

  private async runInternal(): Promise<RunResult<TOutput>> {
    this.agent = snapshotAgent(this.rawAgent);
    this.input = snapshotRunInput(this.rawInput);

    const config = snapshotRunConfig(this.rawConfig, this.input.runId);
    if (!config.valid) {
      return this.createInvalidConfigResult(config.error);
    }
    this.config = config.config;

    const startedAt = this.now();
    this.startedAtMs = Date.parse(startedAt);
    this.state = freezeState({
      runId: this.input.runId,
      taskId: this.input.task.id,
      startingAgentId: this.agent.id,
      activeAgentId: this.agent.id,
      startedAt,
      status: "initializing",
      code: null,
      finalOutput: null,
      errors: Object.freeze([]) as readonly [],
      cancellationRequest: null,
      permission: createInitialRunPermissionState(this.config.permissions),
      context: createInitialContext(this.input.task),
      plan: null,
      items: Object.freeze([]),
      counters: freezeCounters({
        iterations: 0,
        actions: 0,
        consecutiveActionFailures: 0,
      }),
      evidenceRefs: Object.freeze([]),
      artifactRefs: Object.freeze([]),
      metadata: Object.freeze({
        ...this.config.metadata,
        ...this.input.metadata,
      }),
    });
    this.startCancellationObservation();

    if (this.cancellationRequest() !== null) {
      return this.cancelRun();
    }

    if (this.state.status !== "initializing") {
      throw new Error(`Run cannot start its loop from ${this.state.status}.`);
    }
    this.replaceState(freezeState({
      ...this.state,
      status: "running",
      code: null,
      finalOutput: null,
      errors: Object.freeze([]) as readonly [],
      cancellationRequest: null,
    }));
    this.emit("run.started", {
      runId: this.state.runId,
      agentId: this.state.activeAgentId,
    });

    const startErrors = await this.recordLifecycle("started", "succeeded");
    if (startErrors.length > 0) {
      const cancellationRequest = this.cancellationRequest();
      if (cancellationRequest !== null) {
        this.enterCancelling(cancellationRequest);
      }
      return this.terminalize({
        status: "failed",
        code: failureCode(startErrors[0]),
        errors: asErrorTuple(startErrors),
        cancellationRequest,
      }, new Set(startErrors.map((error) => error.owner)));
    }

    if (this.cancellationRequest() !== null) {
      return this.cancelRun();
    }

    while (this.isRunning()) {
      const limitError = this.checkLoopLimits();
      if (limitError !== null) {
        return this.fail(limitError);
      }

      this.replaceState(freezeState({
        ...this.state,
        counters: freezeCounters({
          ...this.state.counters,
          iterations: this.state.counters.iterations + 1,
        }),
      }));
      const iteration = this.state.counters.iterations;
      this.emit("controller.started", { runId: this.state.runId, iteration });

      let decision: ControllerDecision<unknown>;
      try {
        decision = await this.awaitBoundary(
          "controller",
          () => this.dependencies.controller.next(
            this.createControllerInput(),
            Object.freeze({
              cancellation: this.config.cancellation.context,
              retry: Object.freeze({
                providerRequest: this.config.retry.providerRequest,
                structuredOutput: this.config.retry.structuredOutput,
                deadlineAt: this.runDeadlineAt(),
                events: this.createRetryEventSink(),
              }),
            }),
          ),
        );
      } catch (error) {
        if (error instanceof CancellationSettlementTimeoutError) {
          this.emit("controller.finished", {
            runId: this.state.runId,
            iteration,
            status: "failed",
            code: "runtime_cancellation_settlement_timeout",
          });
          return this.fail(
            cancellationSettlementRuntimeError(error),
            "runtime_cancellation_settlement_timeout",
          );
        }
        if (
          error instanceof ControllerError &&
          error.boundarySettlement === "settled_failure"
        ) {
          this.emit("controller.finished", {
            runId: this.state.runId,
            iteration,
            status: "failed",
            code: error.runtimeError.code,
          });
          return this.fail(
            error.runtimeError,
            failureCode(error.runtimeError),
          );
        }
        if (this.cancellationRequest() !== null) {
          this.emit("controller.finished", {
            runId: this.state.runId,
            iteration,
            status: "cancelled",
          });
          return this.cancelRun();
        }

        const runtimeError = controllerRuntimeError(error);
        this.emit("controller.finished", {
          runId: this.state.runId,
          iteration,
          status: "failed",
          code: runtimeError.code,
        });
        return this.fail(runtimeError, failureCode(runtimeError));
      }

      if (this.cancellationRequest() !== null) {
        this.emit("controller.finished", {
          runId: this.state.runId,
          iteration,
          status: "cancelled",
        });
        return this.cancelRun();
      }

      const controllerDurationError = this.checkDurationLimit();
      if (controllerDurationError !== null) {
        this.emit("controller.finished", {
          runId: this.state.runId,
          iteration,
          status: "failed",
          code: controllerDurationError.code,
        });
        return this.fail(controllerDurationError);
      }

      const malformedDecision = validateControllerDecision(decision);
      if (malformedDecision !== null) {
        const error = runtimeError(
          "model",
          "model_output_invalid",
          malformedDecision,
          false,
        );
        this.emit("controller.finished", {
          runId: this.state.runId,
          iteration,
          status: "failed",
          code: error.code,
        });
        return this.fail(error, "model_output_invalid");
      }

      this.commitRunning(
        decision.modelItems.map((modelItem) => (base) => Object.freeze({
          ...base,
          kind: "model_output" as const,
          modelItem: Object.freeze({
            ...modelItem,
            metadata: Object.freeze({ ...modelItem.metadata }),
          }),
        })),
      );
      this.emit("controller.finished", {
        runId: this.state.runId,
        iteration,
        status: "succeeded",
        decisionKind: decision.kind,
      });

      if (decision.kind === "final_output") {
        let validation;
        try {
          validation = this.agent.output.validate(decision.output);
        } catch (error) {
          return this.fail(runtimeError(
            "model",
            "model_output_invalid",
            "Agent output validation failed.",
            false,
            errorMetadata(error),
          ), "model_output_invalid");
        }

        if (!validation.valid || validation.output === null || validation.output === undefined) {
          return this.fail(runtimeError(
            "model",
            "model_output_invalid",
            validation.valid
              ? "Agent output must be non-null."
              : validation.message,
            false,
          ), "model_output_invalid");
        }

        return this.terminalize({
          status: "succeeded",
          output: validation.output as NonNullable<TOutput>,
        });
      }

      if (decision.kind === "stop") {
        return this.terminalize({
          status: "blocked",
          code: "runtime_no_safe_path",
          reason: decision.reason,
        });
      }

      if (
        this.state.counters.actions + decision.actions.length >
        this.config.limits.maxActions
      ) {
        return this.fail(limitRuntimeError("Run exceeded maxActions.", {
          maxActions: this.config.limits.maxActions,
          attemptedActions: this.state.counters.actions + decision.actions.length,
        }));
      }

      const actions = this.materializeActions(decision.actions, iteration);
      for (const action of actions) {
        if (this.cancellationRequest() !== null) {
          return this.cancelRun();
        }

        const durationError = this.checkDurationLimit();
        if (durationError !== null) {
          return this.fail(durationError);
        }

        const processed = await this.processAction(action);
        if (processed.terminalResult !== null) {
          return processed.terminalResult as RunResult<TOutput>;
        }
        if (processed.invalidatesBatch) {
          break;
        }
      }
    }

    if (this.terminalResult === null) {
      throw new Error("Runner left its active loop without a terminal result.");
    }
    return this.terminalResult;
  }

  private createControllerInput(): ControllerInput<unknown> {
    return Object.freeze({
      runId: this.state.runId,
      iteration: this.state.counters.iterations,
      agent: this.agent,
      task: this.input.task,
      conversationItems: this.input.conversationItems,
      context: projectContext(
        this.state.context,
        this.state.plan,
        projectPermissionContext(this.config.permissions, this.state.permission),
      ),
      workspace: this.config.workspace,
      identity: this.config.identity,
      metadata: Object.freeze({ ...this.state.metadata }),
    });
  }

  private isRunning(): boolean {
    return this.state.status === "running";
  }

  private materializeActions(
    candidates: readonly ActionCandidate[],
    iteration: number,
  ): readonly Action[] {
    const firstSequence = this.state.counters.actions + 1;
    const actions = candidates.map((candidate, index) => {
      const sequence = firstSequence + index;
      return Object.freeze({
        id: this.createId("action", sequence),
        runId: this.state.runId,
        sequence,
        kind: candidate.kind,
        name: candidate.name,
        input: candidate.input,
        provenance: Object.freeze({
          modelItemId: candidate.modelItemId,
          controllerIteration: iteration,
        }),
      });
    });

    this.commitRunning(
      actions.map((action) => (base) => Object.freeze({
        ...base,
        kind: "action" as const,
        action,
      })),
      {
        counters: freezeCounters({
          ...this.state.counters,
          actions: this.state.counters.actions + actions.length,
        }),
      },
    );
    return Object.freeze(actions);
  }

  private async processAction(action: Action): Promise<ProcessActionResult> {
    if (action.kind === "internal" && action.name === "update_plan") {
      return this.processPlanUpdate(action);
    }
    if (action.kind === "tool") {
      return this.processToolAction(action as Action & { readonly kind: "tool" });
    }
    if (action.kind === "permission_request") {
      return this.processPermissionRequest(
        action as Action & { readonly kind: "permission_request" },
      );
    }

    const observation = Object.freeze({
      ...this.createObservationBase(action),
      kind: "action_rejected" as const,
      code: "action_unsupported" as const,
      message: `Action ${action.kind}:${action.name} is not supported by this Runner slice.`,
    });
    return this.commitActionObservation(observation, true, true);
  }

  private async processPermissionRequest(
    action: Action & { readonly kind: "permission_request" },
  ): Promise<ProcessActionResult> {
    if (action.name !== "request_permissions") {
      return this.rejectPermissionRequestAction(
        action,
        "Only permission_request:request_permissions is supported.",
      );
    }
    const prepared = preparePermissionRequestAction({
      actionInput: action.input,
      config: this.config.permissions,
    });
    if (prepared.status === "invalid") {
      return this.rejectPermissionRequestAction(action, prepared.message);
    }

    const createdAt = this.now();
    const requestId = this.createId("approval_request", action.sequence);
    const deadlineAt = deriveApprovalReviewDeadline({
      runDeadlineAt: this.runDeadlineAt(),
      reviewStartedAt: createdAt,
      reviewTimeoutMs: this.config.permissions.reviewer?.reviewTimeoutMs ?? null,
    });
    if (Date.parse(deadlineAt) <= Date.parse(createdAt)) {
      return {
        invalidatesBatch: true,
        terminalResult: await this.fail(limitRuntimeError(
          "Run deadline elapsed before approval review could start.",
          { requestId, deadlineAt },
        )),
      };
    }
    const request = createApprovalRequest({
      id: requestId,
      createdAt,
      requirement: {
        category: "permissions",
        subject: {
          runId: this.state.runId,
          actionId: action.id,
          actionFingerprint: prepared.request.actionFingerprint,
          environmentId: prepared.request.environment.environmentId,
          applicabilityKeys: [],
        },
        reason: prepared.request.reason,
        payload: {
          permissions: prepared.request.permissions,
          cwd: prepared.request.cwd,
          cwdDisplay: prepared.request.cwdDisplay,
          environmentId: prepared.request.environment.environmentId,
        },
        decisionOptions: permissionRequestDecisionOptions(requestId),
        trustedProposals: [],
        deadlineAt,
        metadata: {},
      },
    });

    if (prepared.status === "managed_denied") {
      const observation: ApprovalPolicyRejectedObservation = Object.freeze({
        ...this.createObservationBase(action),
        kind: "approval_policy_rejected",
        requestId: request.id,
        category: request.category,
        code: prepared.code,
        message: prepared.message,
      });
      return this.commitActionObservation(observation, true, true);
    }
    if (!allowsExplicitPermissionRequest(this.config.permissions.approvalPolicy)) {
      const observation: ApprovalPolicyRejectedObservation = Object.freeze({
        ...this.createObservationBase(action),
        kind: "approval_policy_rejected",
        requestId: request.id,
        category: request.category,
        code: "approval_policy_rejected",
        message: "The active Approval Policy does not allow explicit permission requests.",
      });
      return this.commitActionObservation(observation, true, true);
    }

    const limit = this.approvalRequestLimit(request.actionFingerprint);
    if (limit !== null) {
      const observation: ApprovalLimitReachedObservation = Object.freeze({
        ...this.createObservationBase(action),
        kind: "approval_limit_reached",
        requestId: request.id,
        category: request.category,
        ...limit,
      });
      return this.commitActionObservation(observation, true, true);
    }
    if (
      this.state.permission.counters.consecutiveReviewFailures >=
      this.config.permissions.approvalLimits.maxConsecutiveReviewFailures
    ) {
      return {
        invalidatesBatch: true,
        terminalResult: await this.fail(runtimeError(
          "approval",
          "approval_review_failure_limit_exceeded",
          "Approval reviewer failure circuit is open.",
          false,
          { requestId: request.id },
        ), "approval_review_failure_limit_exceeded"),
      };
    }

    const reviewer = this.config.permissions.reviewer;
    if (reviewer === null) {
      const observation: ApprovalReviewFailedObservation = Object.freeze({
        ...this.createObservationBase(action),
        kind: "approval_review_failed",
        requestId: request.id,
        category: request.category,
        code: "approval_reviewer_unavailable",
        message: "No approval reviewer is available.",
        retryable: false,
      });
      return this.commitActionObservation(observation, true, true);
    }

    const pendingVersion = this.state.permission.counters.lastPendingVersion + 1;
    const pending: PendingApproval & { readonly phase: "reviewing" } = Object.freeze({
      phase: "reviewing",
      request,
      reviewerBindingId: reviewer.bindingId,
      reviewer: reviewer.kind,
      reviewOperationId: this.createId("approval_review_operation", action.sequence),
      version: pendingVersion,
      createdAt,
    });
    this.enterApprovalReview(pending);

    const requestAuditError = await recordApprovalRequestAudit({
      request,
      pendingVersion,
      taskId: this.state.taskId,
      workspace: this.config.workspace,
      identity: this.config.identity,
      timestamp: this.now(),
      requirement: this.config.audit,
      signal: this.config.cancellation.context.signal,
      port: this.dependencies.auditPort,
    });
    if (this.cancellationRequest() !== null) {
      return this.settleCancelledApproval(null);
    }
    if (requestAuditError !== null) {
      const record = this.createApprovalRecord(
        {
          kind: "request_failure",
          owner: "audit",
          code: requestAuditError.code,
        },
        { kind: "not_applied", code: requestAuditError.code },
      );
      this.settlePendingApproval(record, "neutral", null, true);
      return {
        invalidatesBatch: true,
        terminalResult: await this.fail(
          requestAuditError,
          "audit_required_failed",
          new Set(["audit"]),
        ),
      };
    }

    let review: ApprovalReviewerExecutionResult;
    try {
      review = await this.awaitBoundary(
        "approval_reviewer",
        () => this.executeApprovalReview(prepared.request),
      );
    } catch (error) {
      if (error instanceof CancellationSettlementTimeoutError) {
        const cancellation = this.cancellationRequest();
        if (cancellation !== null) {
          this.settlePendingApproval(this.createApprovalRecord({
            kind: "run_cancelled",
            cancellationRequestId: cancellation.id,
            initiatingDecision: null,
          }, { kind: "not_applicable" }), "neutral", null, true);
          this.enterCancelling(cancellation);
        }
        return {
          invalidatesBatch: true,
          terminalResult: await this.fail(
            cancellationSettlementRuntimeError(error),
            "runtime_cancellation_settlement_timeout",
          ),
        };
      }
      const failure = approvalReviewFailure(
        "approval_review_failed",
        "Approval review operation failed.",
        false,
      );
      return this.settleReviewFailure(failure);
    }

    if (this.cancellationRequest() !== null || review.kind === "cancelled") {
      return this.settleCancelledApproval(null);
    }
    if (review.kind === "failed") {
      return this.settleReviewFailure(review.failure);
    }

    const validatedAt = this.now();
    const validation = validateApprovalDecision({
      request,
      pendingVersion,
      submission: review.outcome.submission,
      cwd: prepared.request.cwd,
      environment: prepared.request.environment,
      managedConstraints: this.config.permissions.managedConstraints,
      identities: {
        actionAuthorityId: this.createId("action_authority", pendingVersion),
        runPermissionGrantId: this.createId("run_permission_grant", pendingVersion),
        sessionAuthorityRecordId: this.createId("session_authority_record", pendingVersion),
      },
      validatedAt,
    });
    if (validation.status === "invalid") {
      return this.settleReviewFailure(approvalReviewFailure(
        "approval_review_malformed",
        validation.message,
        false,
      ));
    }
    return this.applyValidatedPermissionDecision(validation.decision, review.outcome.rationale);
  }

  private rejectPermissionRequestAction(
    action: Action,
    message: string,
  ): Promise<ProcessActionResult> {
    const observation: ActionRejectedObservation = Object.freeze({
      ...this.createObservationBase(action),
      kind: "action_rejected",
      code: "action_invalid",
      message,
    });
    return this.commitActionObservation(observation, true, true);
  }

  private approvalRequestLimit(
    actionFingerprint: string,
  ): Pick<ApprovalLimitReachedObservation, "limit" | "current" | "maximum"> | null {
    const counters = this.state.permission.counters;
    const limits = this.config.permissions.approvalLimits;
    if (counters.totalRequests >= limits.maxRequestsPerRun) {
      return {
        limit: "requests_per_run",
        current: counters.totalRequests,
        maximum: limits.maxRequestsPerRun,
      };
    }
    const fingerprintCount = counters.requestsByActionFingerprint.find(
      (entry) => entry.actionFingerprint === actionFingerprint,
    )?.count ?? 0;
    if (fingerprintCount >= limits.maxRequestsPerActionFingerprint) {
      return {
        limit: "requests_per_action_fingerprint",
        current: fingerprintCount,
        maximum: limits.maxRequestsPerActionFingerprint,
      };
    }
    if (counters.consecutiveDeclines >= limits.maxConsecutiveDeclines) {
      return {
        limit: "consecutive_declines",
        current: counters.consecutiveDeclines,
        maximum: limits.maxConsecutiveDeclines,
      };
    }
    return null;
  }

  private enterApprovalReview(
    pending: PendingApproval & { readonly phase: "reviewing" },
  ): void {
    if (this.state.status !== "running") {
      throw new Error(`Cannot request approval while Run is ${this.state.status}.`);
    }
    const permission = beginApprovalReview({
      permission: this.state.permission,
      pending,
    });
    const items = this.materializeItems([(base) => Object.freeze({
      ...base,
      kind: "approval_requested" as const,
      request: createApprovalRequestSummary(pending.request),
      pendingVersion: pending.version,
      reviewer: pending.reviewer,
      reviewOperationId: pending.reviewOperationId,
    })]);
    this.replaceState(freezeState({
      ...this.state,
      status: "waiting_for_approval",
      permission: permission as RunPermissionState & { readonly pendingApproval: PendingApproval },
      items: Object.freeze([...this.state.items, ...items]),
    }));
    this.publishItems(items);
    this.emit("approval.requested", {
      runId: pending.request.runId,
      requestId: pending.request.id,
      actionId: pending.request.actionId,
      actionFingerprint: pending.request.actionFingerprint,
      category: pending.request.category,
      pendingVersion: pending.version,
      reviewer: pending.reviewer,
      phase: pending.phase,
      reviewOperationId: pending.reviewOperationId,
    });
  }

  private async executeApprovalReview(
    prepared: PreparedPermissionRequestAction,
  ): Promise<ApprovalReviewerExecutionResult> {
    const pending = this.requirePendingApproval();
    const reviewer = this.config.permissions.reviewer;
    if (reviewer === null) {
      return { kind: "failed", failure: approvalReviewFailure(
        "approval_reviewer_unavailable",
        "Approval reviewer became unavailable.",
        false,
      ) };
    }
    const permissionProjection = projectPermissionContext(
      this.config.permissions,
      this.state.permission,
    );
    const reviewInput: ApprovalReviewInput = Object.freeze({
      request: projectApprovalReviewRequest(pending.request),
      pendingVersion: pending.version,
      context: Object.freeze({
        workspaceTrustState: this.config.workspace.trustState,
        ruleOutcome: "none" as const,
        currentAuthority: Object.freeze({
          fileSystemRead: permissionProjection.authority.hasAdditionalFileSystemRead,
          fileSystemWrite: permissionProjection.authority.hasAdditionalFileSystemWrite,
          network: permissionProjection.authority.hasAdditionalNetwork,
        }),
        annotations: Object.freeze({ rootId: prepared.rootId }),
      }),
    });
    return executeApprovalReviewer({
      reviewer,
      review: reviewInput,
      operationId: pending.reviewOperationId,
      startedAt: pending.createdAt,
      deadlineAt: pending.request.deadlineAt,
      retryPolicy: this.config.retry.approvalsReviewer,
      retryExecutor: this.dependencies.retryExecutor,
      cancellation: this.config.cancellation.context,
      events: this.createRetryEventSink(),
      now: () => this.now(),
    });
  }

  private async applyValidatedPermissionDecision(
    decision: ValidatedApprovalDecision,
    rationale: string | null,
  ): Promise<ProcessActionResult> {
    if (decision.kind === "cancel") {
      const pending = this.requirePendingApproval();
      this.config.cancellation.requestCancellation({
        origin: "approval",
        reasonCode: "approval_cancelled",
        reason: rationale ?? undefined,
        approvalRequestId: pending.request.id,
      });
      return this.settleCancelledApproval("cancel");
    }
    if (decision.kind === "decline") {
      const record = this.createApprovalRecord(
        { kind: "decision", decision },
        { kind: "not_applicable" },
      );
      const pending = this.requirePendingApproval();
      const observation: ApprovalDeclinedObservation = Object.freeze({
        ...this.createObservationBaseFromPending(pending),
        kind: "approval_declined",
        requestId: pending.request.id,
        category: pending.request.category,
        reason: decision.reason,
      });
      this.settlePendingApproval(record, "declined", observation, true);
      return { invalidatesBatch: true, terminalResult: null };
    }

    const authorityOperationId = this.createId(
      "authority_operation",
      this.requirePendingApproval().version,
    );
    if (this.state.status !== "waiting_for_approval") {
      throw new Error("Approval authority application requires a waiting Run.");
    }
    const waitingState = this.state;
    this.replaceState(freezeState({
      ...waitingState,
      permission: beginApprovalAuthorityApplication({
        permission: waitingState.permission,
        decision,
        authorityOperationId,
      }) as RunPermissionState & { readonly pendingApproval: PendingApproval },
    }));
    const pending = this.requirePendingApproval();
    const auditError = await recordApprovalValidatedDecisionAudit({
      request: pending.request,
      pendingVersion: pending.version,
      decision,
      taskId: this.state.taskId,
      workspace: this.config.workspace,
      identity: this.config.identity,
      timestamp: this.now(),
      requirement: this.config.audit,
      signal: this.config.cancellation.context.signal,
      port: this.dependencies.auditPort,
    });
    if (this.cancellationRequest() !== null) {
      return this.settleCancelledApproval(null);
    }
    if (auditError !== null) {
      const record = this.createApprovalRecord(
        { kind: "decision", decision },
        { kind: "not_applied", code: auditError.code },
      );
      this.settlePendingApproval(record, "neutral", null, true);
      return {
        invalidatesBatch: true,
        terminalResult: await this.fail(
          auditError,
          "audit_required_failed",
          new Set(["audit"]),
        ),
      };
    }

    const applied = applyImmediateApprovalAuthority({
      permission: this.state.permission,
      decision,
    });
    if (applied.status === "deferred") {
      const record = this.createApprovalRecord(
        { kind: "decision", decision },
        { kind: "not_applied", code: "approval_scope_unavailable" },
      );
      const observation = Object.freeze({
        ...this.createObservationBaseFromPending(pending),
        kind: "approval_application_failed" as const,
        requestId: pending.request.id,
        category: pending.request.category,
        scope: applied.scope as ApprovalScope,
        code: "approval_scope_unavailable",
        message: "The selected approval scope is not active in this Runner slice.",
      });
      this.settlePendingApproval(record, "neutral", observation, true);
      return { invalidatesBatch: true, terminalResult: null };
    }
    if (applied.status === "not_applicable") {
      throw new Error("A non-authority approval decision reached authority application.");
    }
    const record = this.createApprovalRecord(
      { kind: "decision", decision },
      applied.application,
    );
    const grant = decision.kind === "grantPermissions" &&
        decision.authority.scope === "run"
      ? decision.authority.grant
      : null;
    const observation: PermissionsGrantedObservation | null = grant === null
      ? null
      : Object.freeze({
          ...this.createObservationBaseFromPending(pending),
          kind: "permissions_granted" as const,
          requestId: pending.request.id,
          category: pending.request.category,
          scope: "run" as const,
          summary: Object.freeze({
            fileSystemReadTargetCount: grant.permissions.fileSystem?.read?.length ?? 0,
            fileSystemWriteTargetCount: grant.permissions.fileSystem?.write?.length ?? 0,
            networkEnabled: grant.permissions.network?.enabled === true,
            networkDomainCount: grant.permissions.network?.domains?.length ?? 0,
          }),
        });
    this.settlePendingApproval(
      record,
      "applied",
      observation,
      false,
      applied.permission,
    );
    return { invalidatesBatch: true, terminalResult: null };
  }

  private settleReviewFailure(
    failure: ApprovalReviewFailure,
  ): Promise<ProcessActionResult> {
    const pending = this.requirePendingApproval();
    const record = this.createApprovalRecord(
      { kind: "review_failure", failure },
      { kind: "not_applicable" },
    );
    const observation: ApprovalReviewFailedObservation = Object.freeze({
      ...this.createObservationBaseFromPending(pending),
      kind: "approval_review_failed",
      requestId: pending.request.id,
      category: pending.request.category,
      code: failure.code,
      message: failure.message,
      retryable: failure.retryable,
    });
    this.settlePendingApproval(record, "review_failure", observation, true);
    if (
      failure.code === "approval_review_timeout" &&
      pending.request.deadlineAt === this.runDeadlineAt()
    ) {
      return this.fail(limitRuntimeError(
        "Run deadline elapsed during approval review.",
        { requestId: pending.request.id, deadlineAt: pending.request.deadlineAt },
      )).then((terminalResult) => ({
        invalidatesBatch: true,
        terminalResult,
      }));
    }
    if (
      this.state.permission.counters.consecutiveReviewFailures >=
      this.config.permissions.approvalLimits.maxConsecutiveReviewFailures
    ) {
      return this.fail(runtimeError(
        "approval",
        "approval_review_failure_limit_exceeded",
        "Approval reviewer failure circuit limit was reached.",
        false,
        { requestId: pending.request.id },
      ), "approval_review_failure_limit_exceeded").then((terminalResult) => ({
        invalidatesBatch: true,
        terminalResult,
      }));
    }
    return Promise.resolve({ invalidatesBatch: true, terminalResult: null });
  }

  private settleCancelledApproval(
    initiatingDecision: "cancel" | null,
  ): Promise<ProcessActionResult> {
    const cancellation = this.cancellationRequest();
    if (cancellation === null) {
      throw new Error("Approval cancellation requires an accepted Run cancellation.");
    }
    const record = this.createApprovalRecord({
      kind: "run_cancelled",
      cancellationRequestId: cancellation.id,
      initiatingDecision,
    }, { kind: "not_applicable" });
    this.settlePendingApproval(record, "neutral", null, true);
    return this.cancelRun().then((terminalResult) => ({
      invalidatesBatch: true,
      terminalResult,
    }));
  }

  private settlePendingApproval(
    record: ApprovalRecord,
    counterEffect: ApprovalSettlementCounterEffect,
    observation: Observation | null,
    failed: boolean,
    permissionBase: RunPermissionState = this.state.permission,
  ): void {
    if (this.state.status !== "waiting_for_approval") {
      throw new Error(`Cannot settle approval while Run is ${this.state.status}.`);
    }
    const permission = settleApproval({
      permission: permissionBase,
      record,
      counterEffect,
    });
    const drafts: RunItemDraft<TOutput>[] = [
      (base) => Object.freeze({
        ...base,
        kind: "approval_resolved" as const,
        record: createApprovalRecordSummary(record),
      }),
      ...(observation === null ? [] : [observationDraft<TOutput>(observation)]),
    ];
    const items = this.materializeItems(drafts);
    const context = observation === null
      ? this.state.context
      : applyContextUpdate(this.state.context, {
          observations: [observation],
          metadata: { lastActionId: observation.actionId },
        });
    this.replaceState(freezeState({
      ...this.state,
      status: "running",
      permission,
      context,
      counters: nextActionCounters(this.state.counters, failed),
      items: Object.freeze([...this.state.items, ...items]),
    }));
    this.publishItems(items);
    const summary = createApprovalRecordSummary(record);
    this.emit("approval.resolved", {
      runId: record.runId,
      requestId: record.requestId,
      actionId: record.actionId,
      actionFingerprint: record.actionFingerprint,
      pendingVersion: record.pendingVersion,
      reviewer: record.reviewer,
      resolutionKind: summary.resolutionKind,
      decisionKind: summary.decisionKind,
      applicationKind: summary.applicationKind,
      code: summary.code,
      authorityRecordIds: summary.authorityRecordIds,
    });
  }

  private createApprovalRecord(
    resolution: ApprovalRecord["resolution"],
    application: ApprovalRecord["application"],
  ): ApprovalRecord {
    const pending = this.requirePendingApproval();
    return deepFreezeValue({
      id: this.createId("approval_record", pending.version),
      runId: pending.request.runId,
      requestId: pending.request.id,
      actionId: pending.request.actionId,
      actionFingerprint: pending.request.actionFingerprint,
      pendingVersion: pending.version,
      reviewer: pending.reviewer,
      resolution,
      application,
      resolvedAt: this.now(),
      metadata: {},
    });
  }

  private requirePendingApproval(): PendingApproval {
    if (
      this.state.status !== "waiting_for_approval" ||
      this.state.permission.pendingApproval === null
    ) {
      throw new Error("Run has no active PendingApproval.");
    }
    return this.state.permission.pendingApproval;
  }

  private createObservationBaseFromPending(pending: PendingApproval) {
    const actionItem = this.state.items.find(
      (item) => item.kind === "action" && item.action.id === pending.request.actionId,
    );
    if (actionItem === undefined || actionItem.kind !== "action") {
      throw new Error("PendingApproval has no authoritative Action RunItem.");
    }
    return {
      id: this.createId("observation", actionItem.action.sequence),
      runId: pending.request.runId,
      actionId: pending.request.actionId,
      createdAt: this.now(),
      metadata: Object.freeze({
        actionKind: "permission_request",
        actionName: "request_permissions",
      }),
    };
  }

  private async processToolAction(
    action: Action & { readonly kind: "tool" },
  ): Promise<ProcessActionResult> {
    const tool = this.agent.tools.find((candidate) => candidate.name === action.name);
    if (tool === undefined) {
      const observation: ActionRejectedObservation = Object.freeze({
        ...this.createObservationBase(action),
        kind: "action_rejected",
        code: "tool_not_found",
        message: `Tool ${action.name} is not available to Agent ${this.agent.id}.`,
      });
      return this.commitActionObservation(observation, true, true);
    }

    const bridge = this.dependencies.toolActionBridge;
    if (bridge === undefined) {
      const observation: ActionRejectedObservation = Object.freeze({
        ...this.createObservationBase(action),
        kind: "action_rejected",
        code: "action_unsupported",
        message: "This Runner has no ToolActionBridge.",
      });
      return this.commitActionObservation(observation, true, true);
    }

    this.emit("tool.started", {
      runId: this.state.runId,
      actionId: action.id,
      toolName: action.name,
    });

    let result;
    try {
      result = await this.awaitBoundary(
        "tool",
        () => bridge.execute({
          action,
          task: this.input.task,
          workspace: this.config.workspace,
          identity: this.config.identity,
          cancellation: this.config.cancellation.context,
          cancellationLimits: this.config.cancellationLimits,
          audit: this.config.audit,
          telemetry: this.config.telemetry,
          toolRisk: tool.risk,
          metadata: Object.freeze({
            runId: this.state.runId,
            taskId: this.state.taskId,
            agentId: this.state.activeAgentId,
          }),
        }),
      );
    } catch (error) {
      if (error instanceof CancellationSettlementTimeoutError) {
        this.emit("tool.finished", {
          runId: this.state.runId,
          actionId: action.id,
          toolName: action.name,
          status: "failed",
          code: "runtime_cancellation_settlement_timeout",
        });
        return {
          invalidatesBatch: true,
          terminalResult: await this.fail(
            cancellationSettlementRuntimeError(error),
            "runtime_cancellation_settlement_timeout",
          ),
        };
      }
      if (this.cancellationRequest() !== null) {
        this.emit("tool.finished", {
          runId: this.state.runId,
          actionId: action.id,
          toolName: action.name,
          status: "cancelled",
        });
        return { invalidatesBatch: true, terminalResult: await this.cancelRun() };
      }

      const bridgeError = runtimeError(
        "tool",
        "tool_action_bridge_failed",
        error instanceof Error ? error.message : "ToolActionBridge failed.",
        false,
        { actionId: action.id, toolName: action.name },
      );
      this.emit("tool.finished", {
        runId: this.state.runId,
        actionId: action.id,
        toolName: action.name,
        status: "failed",
        code: bridgeError.code,
      });
      return {
        invalidatesBatch: true,
        terminalResult: await this.fail(bridgeError, "tool_execution_failed"),
      };
    }

    this.emit("tool.finished", {
      runId: this.state.runId,
      actionId: action.id,
      toolName: action.name,
      status: result.status === "observed" ? result.outcome : "failed",
      ...(result.status === "terminal_failure" ? { code: result.code } : {}),
    });

    if (result.status === "terminal_failure") {
      this.commitSettledToolState([], {
        evidenceRefs: result.evidenceRefs,
        artifactRefs: result.artifactRefs,
      });
      const cancellationRequest = this.cancellationRequest();
      if (cancellationRequest !== null) {
        this.enterCancelling(cancellationRequest);
      }
      return {
        invalidatesBatch: true,
        terminalResult: await this.terminalize({
          status: "failed",
          code: result.code,
          errors: result.errors,
          cancellationRequest,
        }, new Set(result.errors.map((error) => error.owner))),
      };
    }

    const observation = result.observation === null
      ? null
      : this.materializeToolObservation(action, result.observation);
    const processed = await this.commitToolOutcome(
      action,
      observation,
      result.outcome !== "succeeded",
      result.evidenceRefs,
      result.artifactRefs,
    );

    if (processed.terminalResult !== null) {
      return processed;
    }
    if (this.cancellationRequest() !== null) {
      return { invalidatesBatch: true, terminalResult: await this.cancelRun() };
    }
    return processed;
  }

  private materializeToolObservation(
    action: Action,
    payload: ToolActionObservationPayload,
  ): ToolResultObservation | ActionDeniedObservation | ActionFailureObservation |
    ActionRejectedObservation {
    const base = this.createObservationBase(action);
    const metadata = Object.freeze({ ...base.metadata, ...payload.metadata });
    switch (payload.kind) {
      case "tool_result":
        return Object.freeze({ ...base, metadata, kind: payload.kind, result: payload.result });
      case "action_denied":
        return Object.freeze({
          ...base,
          metadata,
          kind: payload.kind,
          owner: payload.owner,
          code: payload.code,
          message: payload.message,
        });
      case "action_failure":
        return Object.freeze({ ...base, metadata, kind: payload.kind, error: payload.error });
      case "action_rejected":
        return Object.freeze({
          ...base,
          metadata,
          kind: payload.kind,
          code: payload.code,
          message: payload.message,
        });
    }
  }

  private async commitToolOutcome(
    action: Action,
    observation: Observation | null,
    failed: boolean,
    evidenceRefs: readonly EvidenceRef[],
    artifactRefs: readonly ArtifactRef[],
  ): Promise<ProcessActionResult> {
    const context = applyContextUpdate(this.state.context, {
      observations: observation === null ? [] : [observation],
      evidenceRefs,
      metadata: {
        lastActionId: action.id,
        lastControllerIteration: action.provenance.controllerIteration,
      },
    });
    const counters = nextActionCounters(this.state.counters, failed);
    this.commitSettledToolState(
      observation === null ? [] : [observationDraft<TOutput>(observation)],
      { context, counters, evidenceRefs, artifactRefs },
    );

    if (this.state.status === "cancelling") {
      return { invalidatesBatch: true, terminalResult: null };
    }

    if (counters.consecutiveActionFailures > this.config.limits.maxConsecutiveActionFailures) {
      return {
        invalidatesBatch: true,
        terminalResult: await this.fail(limitRuntimeError(
          "Run exceeded maxConsecutiveActionFailures.",
          {
            maxConsecutiveActionFailures:
              this.config.limits.maxConsecutiveActionFailures,
            actualConsecutiveActionFailures: counters.consecutiveActionFailures,
          },
        )),
      };
    }

    return { invalidatesBatch: true, terminalResult: null };
  }

  private async processPlanUpdate(action: Action): Promise<ProcessActionResult> {
    const now = this.now();
    const result = this.state.plan === null
      ? applyPlanUpdate({
          currentPlan: null,
          newPlanId: this.createId("plan", 1),
          candidate: action.input,
          limits: this.config.limits.plan,
          now,
        })
      : applyPlanUpdate({
          currentPlan: this.state.plan,
          candidate: action.input,
          limits: this.config.limits.plan,
          now,
        });
    const observation: PlanUpdateResultObservation = Object.freeze({
      ...this.createObservationBase(action),
      kind: "plan_update",
      result: result.observation,
    });
    const failed = result.status === "rejected";
    const context = applyContextUpdate(this.state.context, {
      observations: [observation],
      metadata: {
        lastActionId: action.id,
        lastControllerIteration: action.provenance.controllerIteration,
      },
    });
    const counters = nextActionCounters(this.state.counters, failed);
    const drafts = [
      ...result.lifecycle.map((change) => planLifecycleDraft<TOutput>(change)),
      observationDraft<TOutput>(observation),
    ];

    this.commitRunning(drafts, {
      context,
      plan: result.plan,
      counters,
    });

    if (counters.consecutiveActionFailures > this.config.limits.maxConsecutiveActionFailures) {
      return {
        invalidatesBatch: true,
        terminalResult: await this.fail(limitRuntimeError(
          "Run exceeded maxConsecutiveActionFailures.",
          {
            maxConsecutiveActionFailures:
              this.config.limits.maxConsecutiveActionFailures,
            actualConsecutiveActionFailures: counters.consecutiveActionFailures,
          },
        )),
      };
    }

    return { invalidatesBatch: failed, terminalResult: null };
  }

  private async commitActionObservation(
    observation: Observation,
    failed: boolean,
    invalidatesBatch: boolean,
  ): Promise<ProcessActionResult> {
    const context = applyContextUpdate(this.state.context, {
      observations: [observation],
      metadata: { lastActionId: observation.actionId },
    });
    const counters = nextActionCounters(this.state.counters, failed);
    this.commitRunning([observationDraft<TOutput>(observation)], {
      context,
      counters,
    });

    if (counters.consecutiveActionFailures > this.config.limits.maxConsecutiveActionFailures) {
      return {
        invalidatesBatch: true,
        terminalResult: await this.fail(limitRuntimeError(
          "Run exceeded maxConsecutiveActionFailures.",
          {
            maxConsecutiveActionFailures:
              this.config.limits.maxConsecutiveActionFailures,
            actualConsecutiveActionFailures: counters.consecutiveActionFailures,
          },
        )),
      };
    }

    return { invalidatesBatch, terminalResult: null };
  }

  private createObservationBase(action: Action) {
    return {
      id: this.createId("observation", action.sequence),
      runId: this.state.runId,
      actionId: action.id,
      createdAt: this.now(),
      metadata: Object.freeze({
        actionKind: action.kind,
        actionName: action.name,
        controllerIteration: action.provenance.controllerIteration,
      }),
    };
  }

  private checkLoopLimits(): RuntimeError | null {
    const cancellationRequest = this.cancellationRequest();
    if (cancellationRequest !== null) {
      return null;
    }

    const duration = this.checkDurationLimit();
    if (duration !== null) {
      return duration;
    }
    if (this.state.counters.iterations >= this.config.limits.maxIterations) {
      return limitRuntimeError("Run exceeded maxIterations.", {
        maxIterations: this.config.limits.maxIterations,
      });
    }
    if (
      this.state.counters.consecutiveActionFailures >
      this.config.limits.maxConsecutiveActionFailures
    ) {
      return limitRuntimeError("Run exceeded maxConsecutiveActionFailures.", {
        maxConsecutiveActionFailures:
          this.config.limits.maxConsecutiveActionFailures,
        actualConsecutiveActionFailures:
          this.state.counters.consecutiveActionFailures,
      });
    }
    return null;
  }

  private checkDurationLimit(): RuntimeError | null {
    const elapsedMs = Date.parse(this.now()) - this.startedAtMs;
    if (elapsedMs > this.config.limits.maxDurationMs) {
      return limitRuntimeError("Run exceeded maxDurationMs.", {
        maxDurationMs: this.config.limits.maxDurationMs,
        elapsedMs,
      });
    }
    return null;
  }

  private runDeadlineAt(): ISODateTimeString {
    return deriveRunDeadline(this.state.startedAt, this.config.limits.maxDurationMs);
  }

  private fail(
    error: RuntimeError,
    code: RunFailureCode = "runtime_limit_exceeded",
    skipOwners: ReadonlySet<RuntimeError["owner"]> = new Set(),
  ): Promise<RunResult<TOutput>> {
    return this.terminalize({
      status: "failed",
      code,
      errors: Object.freeze([error]) as readonly [RuntimeError],
      cancellationRequest: this.state.status === "cancelling"
        ? this.state.cancellationRequest
        : null,
    }, skipOwners);
  }

  private cancelRun(): Promise<RunResult<TOutput>> {
    const request = this.cancellationRequest();
    if (request === null) {
      throw new Error("Cannot cancel a Run without an accepted cancellation request.");
    }
    this.enterCancelling(request);
    return this.terminalize({ status: "cancelled", cancellationRequest: request });
  }

  private enterCancelling(request: RunCancellationRequest): void {
    if (this.state.status === "cancelling") {
      return;
    }
    if (this.state.status !== "initializing" && this.state.status !== "running") {
      throw new Error(`Run cannot enter cancelling from ${this.state.status}.`);
    }

    const summary = toRunCancellationSummary(request);
    const item = this.materializeItems([
      (base) => Object.freeze({
        ...base,
        kind: "run_cancellation_requested" as const,
        request: summary,
      }),
    ]);
    this.replaceState(freezeState({
      ...this.state,
      status: "cancelling",
      code: null,
      finalOutput: null,
      errors: Object.freeze([]) as readonly [],
      cancellationRequest: request,
      items: Object.freeze([...this.state.items, ...item]),
    }));
    this.publishItems(item);
  }

  private async terminalize(
    initial: TerminalCandidate<TOutput>,
    skipOwners: ReadonlySet<RuntimeError["owner"]> = new Set(),
  ): Promise<RunResult<TOutput>> {
    if (this.terminalResult !== null) {
      return this.terminalResult;
    }

    let candidate = this.reconcileTerminalCancellation(initial);
    const firstFinalization = await this.finalizeCandidate(candidate, skipOwners);
    candidate = firstFinalization.candidate;

    if (!firstFinalization.failed) {
      const correctedCandidate = this.reconcileTerminalCancellation(candidate);
      if (correctedCandidate.status !== candidate.status) {
        candidate = (
          await this.finalizeCandidate(correctedCandidate, skipOwners)
        ).candidate;
      }
    }

    const completedAt = this.now();
    const completedAtMs = Date.parse(completedAt);
    const metadata = Object.freeze({
      ...this.state.metadata,
      startedAt: this.state.startedAt,
      completedAt,
      durationMs: Math.max(0, completedAtMs - this.startedAtMs),
      iterations: this.state.counters.iterations,
      actions: this.state.counters.actions,
      consecutiveActionFailures: this.state.counters.consecutiveActionFailures,
      startingAgentId: this.state.startingAgentId,
      activeAgentId: this.state.activeAgentId,
    });

    let plan = this.state.plan;
    const drafts: RunItemDraft<TOutput>[] = [];
    if (plan !== null && plan.status === "active") {
      const abandoned = abandonPlan({
        plan,
        terminalStatus: candidate.status,
        reasonCode: candidate.status === "succeeded"
          ? null
          : candidate.status === "cancelled"
            ? "runtime_cancelled"
            : candidate.code,
        now: completedAt,
      });
      plan = abandoned.plan;
      drafts.push(...abandoned.lifecycle.map((change) => planLifecycleDraft<TOutput>(change)));
    }

    if (candidate.status === "succeeded") {
      drafts.push((base) => Object.freeze({
        ...base,
        kind: "final_output" as const,
        output: candidate.output,
      }));
    } else if (candidate.status === "blocked") {
      drafts.push(
        (base) => Object.freeze({
          ...base,
          kind: "stop" as const,
          reason: candidate.reason,
        }),
        (base) => Object.freeze({
          ...base,
          kind: "run_blocked" as const,
          code: candidate.code,
        }),
      );
    } else if (candidate.status === "failed") {
      drafts.push((base) => Object.freeze({
        ...base,
        kind: "run_failed" as const,
        code: candidate.code,
        errors: candidate.errors,
      }));
    } else {
      drafts.push((base) => Object.freeze({
        ...base,
        kind: "run_cancelled" as const,
        cancellation: toRunCancellationSummary(candidate.cancellationRequest),
        completedAt,
      }));
    }

    const items = this.materializeItems(drafts);
    const allItems = Object.freeze([...this.state.items, ...items]);
    const permission = this.state.permission;
    if (permission.pendingApproval !== null) {
      throw new Error("Run cannot terminalize while approval is pending.");
    }
    const base = {
      ...this.state,
      permission,
      plan,
      items: allItems,
      metadata,
    };

    if (candidate.status === "succeeded") {
      this.replaceState(freezeState({
        ...base,
        status: "succeeded",
        code: null,
        finalOutput: candidate.output,
        errors: Object.freeze([]) as readonly [],
        cancellationRequest: null,
      }));
    } else if (candidate.status === "blocked") {
      this.replaceState(freezeState({
        ...base,
        status: "blocked",
        code: candidate.code,
        finalOutput: null,
        errors: Object.freeze([]) as readonly [],
        cancellationRequest: null,
      }));
    } else if (candidate.status === "failed") {
      this.replaceState(freezeState({
        ...base,
        status: "failed",
        code: candidate.code,
        finalOutput: null,
        errors: candidate.errors,
        cancellationRequest: candidate.cancellationRequest,
      }));
    } else {
      this.replaceState(freezeState({
        ...base,
        status: "cancelled",
        code: "runtime_cancelled",
        finalOutput: null,
        errors: Object.freeze([]) as readonly [],
        cancellationRequest: candidate.cancellationRequest,
      }));
    }

    this.publishItems(items);
    this.emit(terminalEventName(candidate.status), {
      runId: this.state.runId,
      status: candidate.status,
      code: candidate.status === "succeeded" ? null : this.state.code,
    });
    this.terminalResult = this.createResult();
    return this.terminalResult;
  }

  private reconcileTerminalCancellation(
    candidate: TerminalCandidate<TOutput>,
  ): TerminalCandidate<TOutput> {
    const acceptedCancellation = this.cancellationRequest();
    if (
      acceptedCancellation === null ||
      (candidate.status === "failed" && candidate.cancellationRequest !== null)
    ) {
      return candidate;
    }

    this.enterCancelling(acceptedCancellation);
    return {
      status: "cancelled",
      cancellationRequest: acceptedCancellation,
    };
  }

  private async finalizeCandidate(
    candidate: TerminalCandidate<TOutput>,
    skipOwners: ReadonlySet<RuntimeError["owner"]>,
  ): Promise<{
    readonly candidate: TerminalCandidate<TOutput>;
    readonly failed: boolean;
  }> {
    const scope = createRunFinalizationContext({
      runId: this.state.runId,
      cancellation: terminalCancellationSummary(candidate),
      timeoutMs: this.config.cancellationLimits.finalizationTimeoutMs,
      startedAt: this.now(),
    });

    let finalizationErrors: RuntimeError[];
    try {
      finalizationErrors = await this.recordLifecycle(
        candidate.status,
        auditOutcome(candidate.status),
        skipOwners,
        finalizationObservabilityContext(scope.context),
      );
    } finally {
      scope.dispose();
    }

    if (finalizationErrors.length === 0) {
      return { candidate, failed: false };
    }

    const priorErrors = candidate.status === "failed" ? [...candidate.errors] : [];
    const acceptedCancellation = this.cancellationRequest();
    const cancellationRequest = candidate.status === "cancelled"
      ? candidate.cancellationRequest
      : candidate.status === "failed" && candidate.cancellationRequest !== null
        ? candidate.cancellationRequest
        : acceptedCancellation;

    return {
      candidate: {
        status: "failed",
        code: failureCode(finalizationErrors[0]),
        errors: asErrorTuple([...priorErrors, ...finalizationErrors]),
        cancellationRequest,
      },
      failed: true,
    };
  }

  private createResult(): RunResult<TOutput> {
    const base = {
      runId: this.state.runId,
      taskId: this.state.taskId,
      items: this.state.items,
      evidenceRefs: this.state.evidenceRefs,
      artifactRefs: this.state.artifactRefs,
      metadata: this.state.metadata,
    };

    switch (this.state.status) {
      case "succeeded":
        return createSucceededRunResult(base, this.state.finalOutput);
      case "blocked":
        return createBlockedRunResult(base, this.state.code);
      case "failed":
        return createFailedRunResult(
          base,
          this.state.code,
          this.state.errors,
          this.state.cancellationRequest === null
            ? null
            : toRunCancellationSummary(this.state.cancellationRequest),
        );
      case "cancelled":
        return createCancelledRunResult(
          base,
          toRunCancellationSummary(this.state.cancellationRequest),
        );
      default:
        throw new Error(`RunResult cannot be created from ${this.state.status}.`);
    }
  }

  private createInvalidConfigResult(error: RuntimeError): RunResult<TOutput> {
    const input = this.input;
    const now = this.now();
    const item: RunItem<TOutput> = Object.freeze({
      id: this.dependencies.createId({
        kind: "run_item",
        runId: input.runId,
        sequence: 1,
      }),
      runId: input.runId,
      sequence: 1,
      createdAt: now,
      metadata: Object.freeze({}),
      kind: "run_failed",
      code: "runtime_invalid_options",
      errors: Object.freeze([error]) as readonly [RuntimeError],
    });
    return createFailedRunResult(
      {
        runId: input.runId,
        taskId: input.task.id,
        items: [item],
        metadata: Object.freeze({
          ...input.metadata,
          completedAt: now,
          iterations: 0,
          actions: 0,
        }),
      },
      "runtime_invalid_options",
      Object.freeze([error]) as readonly [RuntimeError],
    );
  }

  private commitRunning(
    drafts: readonly RunItemDraft<TOutput>[],
    update: {
      readonly context?: Context;
      readonly plan?: Plan | null;
      readonly counters?: RunCounters;
      readonly evidenceRefs?: readonly EvidenceRef[];
      readonly artifactRefs?: readonly ArtifactRef[];
    } = {},
  ): void {
    if (this.state.status !== "running") {
      throw new Error(`Cannot commit active work while Run is ${this.state.status}.`);
    }
    const items = this.materializeItems(drafts);
    this.replaceState(freezeState({
      ...this.state,
      context: update.context ?? this.state.context,
      plan: update.plan === undefined ? this.state.plan : update.plan,
      counters: update.counters ?? this.state.counters,
      evidenceRefs: appendUnique(this.state.evidenceRefs, update.evidenceRefs ?? []),
      artifactRefs: appendUnique(this.state.artifactRefs, update.artifactRefs ?? []),
      items: Object.freeze([...this.state.items, ...items]),
    }));
    this.publishItems(items);
  }

  private commitSettledToolState(
    drafts: readonly RunItemDraft<TOutput>[],
    update: {
      readonly context?: Context;
      readonly counters?: RunCounters;
      readonly evidenceRefs?: readonly EvidenceRef[];
      readonly artifactRefs?: readonly ArtifactRef[];
    },
  ): void {
    if (this.state.status !== "running" && this.state.status !== "cancelling") {
      throw new Error(`Cannot commit a settled Tool outcome while Run is ${this.state.status}.`);
    }
    const items = this.materializeItems(drafts);
    this.replaceState(freezeState({
      ...this.state,
      context: update.context ?? this.state.context,
      counters: update.counters ?? this.state.counters,
      evidenceRefs: appendUnique(this.state.evidenceRefs, update.evidenceRefs ?? []),
      artifactRefs: appendUnique(this.state.artifactRefs, update.artifactRefs ?? []),
      items: Object.freeze([...this.state.items, ...items]),
    }));
    this.publishItems(items);
  }

  private createRetryEventSink(): RetryEventSink {
    return Object.freeze({
      emit: (event: RetryEvent) => this.commitRetryEvent(event),
    });
  }

  private commitRetryEvent(candidate: RetryEvent): void {
    if (
      this.state.status !== "running" &&
      this.state.status !== "waiting_for_approval" &&
      this.state.status !== "cancelling"
    ) {
      throw new Error(`Cannot commit Retry history while Run is ${this.state.status}.`);
    }
    const retry = snapshotRetryEvent(candidate, this.state.runId);
    const items = this.materializeItems([
      (base) => Object.freeze({
        ...base,
        kind: retry.type,
        retry,
      }) as RunItem<TOutput>,
    ]);
    this.replaceState(freezeState({
      ...this.state,
      items: Object.freeze([...this.state.items, ...items]),
    }));
    this.publishItems(items);
    this.emit(retryRuntimeEventName(retry.type), { ...retry }, retry.occurredAt);
  }

  private materializeItems(
    drafts: readonly RunItemDraft<TOutput>[],
  ): readonly RunItem<TOutput>[] {
    const firstSequence = this.state.items.length + 1;
    return Object.freeze(drafts.map((draft, index) => {
      const sequence = firstSequence + index;
      const base: RunItemBase = Object.freeze({
        id: this.createId("run_item", sequence),
        runId: this.state.runId,
        sequence,
        createdAt: this.now(),
        metadata: Object.freeze({}),
      });
      return draft(base);
    }));
  }

  private publishItems(items: readonly RunItem<TOutput>[]): void {
    for (const item of items) {
      this.emit("run.item.appended", {
        runId: item.runId,
        itemId: item.id,
        itemKind: item.kind,
        itemSequence: item.sequence,
      });
    }
  }

  private replaceState(next: RunState<TOutput>): void {
    if (this.state !== undefined) {
      assertStateTransition(this.state, next);
    }
    this.state = next;
  }

  private cancellationRequest(): RunCancellationRequest | null {
    return this.config?.cancellation.context.request ?? null;
  }

  private startCancellationObservation(): void {
    if (this.cancellationListener !== null) {
      throw new Error("Cancellation observation is already active.");
    }
    const signal = this.config.cancellation.context.signal;
    const listener = () => this.observeCancellation();
    this.cancellationListener = listener;
    signal.addEventListener("abort", listener, { once: true });
    if (signal.aborted) {
      this.observeCancellation();
    }
  }

  private disposeCancellationObservation(): void {
    if (this.cancellationListener === null || this.config === undefined) {
      return;
    }
    this.config.cancellation.context.signal.removeEventListener(
      "abort",
      this.cancellationListener,
    );
    this.cancellationListener = null;
  }

  private observeCancellation(): void {
    const request = this.cancellationRequest();
    if (request === null || this.state === undefined) {
      return;
    }
    if (this.state.status === "initializing" || this.state.status === "running") {
      this.enterCancelling(request);
    }
    this.startActiveBoundarySettlementTimer();
  }

  private async awaitBoundary<TValue>(
    kind: ActiveBoundaryKind,
    execute: () => Promise<TValue>,
  ): Promise<TValue> {
    if (this.activeBoundary !== null) {
      throw new Error(
        `Cannot start ${kind} while ${this.activeBoundary.kind} is still active.`,
      );
    }
    if (this.cancellationRequest() !== null) {
      this.observeCancellation();
      throw this.config.cancellation.context.signal.reason;
    }

    let rejectSettlement!: (error: CancellationSettlementTimeoutError) => void;
    const settlementTimeout = new Promise<never>((_resolve, reject) => {
      rejectSettlement = reject;
    });
    const boundary: ActiveBoundary = {
      kind,
      startedAt: this.now(),
      rejectSettlement,
      settlementTimer: null,
    };
    this.activeBoundary = boundary;

    const operation = Promise.resolve().then(() => {
      if (this.cancellationRequest() !== null) {
        this.observeCancellation();
        throw this.config.cancellation.context.signal.reason;
      }
      return execute();
    });

    try {
      return await Promise.race([operation, settlementTimeout]);
    } finally {
      if (this.activeBoundary === boundary) {
        this.clearActiveBoundary();
      }
    }
  }

  private startActiveBoundarySettlementTimer(): void {
    const boundary = this.activeBoundary;
    if (boundary === null || boundary.settlementTimer !== null) {
      return;
    }
    const timeoutMs = this.config.cancellationLimits.boundarySettlementTimeoutMs;
    boundary.settlementTimer = setTimeout(() => {
      boundary.rejectSettlement(new CancellationSettlementTimeoutError(
        boundary.kind,
        boundary.startedAt,
        timeoutMs,
      ));
    }, timeoutMs);
  }

  private clearActiveBoundary(): void {
    if (this.activeBoundary?.settlementTimer !== null &&
        this.activeBoundary?.settlementTimer !== undefined) {
      clearTimeout(this.activeBoundary.settlementTimer);
    }
    this.activeBoundary = null;
  }

  private createId(kind: Parameters<ResolvedRunnerDependencies["createId"]>[0]["kind"], sequence: number): string {
    const id = this.dependencies.createId({ kind, runId: this.state.runId, sequence });
    assertNonEmpty(id, `${kind} id`);
    return id;
  }

  private now(): ISODateTimeString {
    const value = this.dependencies.now();
    if (typeof value !== "string" || value.trim().length === 0 || !Number.isFinite(Date.parse(value))) {
      throw new TypeError("Runner clock must return a valid ISO date-time string.");
    }
    return value;
  }

  private emit(
    name: RuntimeEventName,
    payload: Metadata,
    timestamp?: ISODateTimeString,
  ): void {
    try {
      this.dependencies.eventEmitter?.emit({
        name,
        taskId: this.input.task.id,
        payload,
        timestamp: timestamp ?? this.now(),
      });
    } catch {
      // Runtime notifications are non-authoritative; RunState remains the source of truth.
    }
  }

  private async recordLifecycle(
    phase: "started" | "succeeded" | "blocked" | "failed" | "cancelled",
    outcome: "succeeded" | "failed" | "blocked" | "cancelled",
    skipOwners: ReadonlySet<RuntimeError["owner"]> = new Set(),
    context: ObservabilityRecordContext = this.runtimeObservabilityContext(),
  ): Promise<RuntimeError[]> {
    const timestamp = this.now();
    return recordRunnerLifecycle({
      phase,
      outcome,
      runId: this.state.runId,
      taskId: this.state.taskId,
      agentId: this.state.activeAgentId,
      startedAtMs: this.startedAtMs,
      timestamp,
      counters: this.state.counters,
      itemCount: this.state.items.length,
      workspace: this.config.workspace,
      identity: this.config.identity,
      auditRequirement: this.config.audit,
      telemetryRequirement: this.config.telemetry,
      auditPort: this.dependencies.auditPort,
      telemetryPort: this.dependencies.telemetryPort,
      skipOwners,
      context,
    });
  }

  private runtimeObservabilityContext(): ObservabilityRecordContext {
    return Object.freeze({
      purpose: "runtime",
      signal: this.config.cancellation.context.signal,
      deadlineAt: null,
    });
  }
}

function finalizationObservabilityContext(
  context: RunFinalizationContext,
): ObservabilityRecordContext {
  return Object.freeze({
    purpose: "finalization",
    signal: context.signal,
    deadlineAt: context.deadlineAt,
  });
}

function permissionRequestDecisionOptions(
  requestId: string,
): readonly [ApprovalDecisionOption, ...ApprovalDecisionOption[]] {
  return deepFreezeValue([
    {
      id: `${requestId}:grant_run`,
      kind: "grantPermissions" as const,
      scope: "run" as const,
      label: "Grant for this run",
      description: "Grant a selected subset for the active run.",
      trustedProposalRef: null,
      metadata: {},
    },
    {
      id: `${requestId}:decline`,
      kind: "decline" as const,
      scope: null,
      label: "Decline",
      description: "Continue without granting these permissions.",
      trustedProposalRef: null,
      metadata: {},
    },
    {
      id: `${requestId}:cancel`,
      kind: "cancel" as const,
      scope: null,
      label: "Cancel run",
      description: "Cancel the active run.",
      trustedProposalRef: null,
      metadata: {},
    },
  ]);
}

function approvalReviewFailure(
  code: ApprovalReviewFailure["code"],
  message: string,
  retryable: boolean,
): ApprovalReviewFailure {
  return Object.freeze({
    code,
    message,
    retryable,
    metadata: Object.freeze({}),
  });
}

function deepFreezeValue<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) deepFreezeValue(child);
  return Object.freeze(value);
}

function terminalCancellationSummary(
  candidate: TerminalCandidate<unknown>,
) {
  if (candidate.status === "cancelled") {
    return toRunCancellationSummary(candidate.cancellationRequest);
  }
  if (candidate.status === "failed" && candidate.cancellationRequest !== null) {
    return toRunCancellationSummary(candidate.cancellationRequest);
  }
  return null;
}

function planLifecycleDraft<TOutput>(
  change: PlanLifecycleChange,
): RunItemDraft<TOutput> {
  switch (change.kind) {
    case "created":
      return (base) => Object.freeze({
        ...base,
        kind: "plan_created",
        plan: change.plan,
        explanation: change.explanation,
      });
    case "updated":
      return (base) => Object.freeze({
        ...base,
        kind: "plan_updated",
        previousVersion: change.previousVersion,
        plan: change.plan,
        transition: change.transition,
        explanation: change.explanation,
      });
    case "completed":
      return (base) => Object.freeze({
        ...base,
        kind: "plan_completed",
        plan: change.plan,
      });
    case "abandoned":
      return (base) => Object.freeze({
        ...base,
        kind: "plan_abandoned",
        plan: change.plan,
        terminalStatus: change.terminalStatus,
        reasonCode: change.reasonCode,
      });
  }
}

function observationDraft<TOutput>(observation: Observation): RunItemDraft<TOutput> {
  return (base) => Object.freeze({
    ...base,
    kind: "observation",
    observation,
  });
}

function nextActionCounters(current: RunCounters, failed: boolean): RunCounters {
  return freezeCounters({
    ...current,
    consecutiveActionFailures: failed
      ? current.consecutiveActionFailures + 1
      : 0,
  });
}

function controllerRuntimeError(error: unknown): RuntimeError {
  if (error instanceof ControllerError) {
    return error.runtimeError;
  }
  return runtimeError(
    "model",
    "model_output_invalid",
    "Controller failed to produce a valid decision.",
    false,
    errorMetadata(error),
  );
}

function limitRuntimeError(message: string, metadata: Metadata): RuntimeError {
  return runtimeError("runtime", "runtime_limit_exceeded", message, false, metadata);
}

function cancellationSettlementRuntimeError(
  error: CancellationSettlementTimeoutError,
): RuntimeError {
  return runtimeError(
    "runtime",
    "runtime_cancellation_settlement_timeout",
    error.message,
    false,
    {
      boundary: error.boundary,
      boundaryStartedAt: error.startedAt,
      settlementTimeoutMs: error.timeoutMs,
    },
  );
}

function runtimeError(
  owner: RuntimeError["owner"],
  code: string,
  message: string,
  retryable: boolean,
  metadata: Metadata = {},
): RuntimeError {
  return Object.freeze({
    owner,
    code,
    message,
    retryable,
    metadata: Object.freeze({ ...metadata }),
  });
}

function errorMetadata(error: unknown): Metadata {
  return error instanceof Error ? { causeName: error.name } : {};
}

function failureCode(error: RuntimeError): RunFailureCode {
  return error.code as RunFailureCode;
}

function asErrorTuple(
  errors: readonly RuntimeError[],
): readonly [RuntimeError, ...RuntimeError[]] {
  if (errors.length === 0) {
    throw new TypeError("At least one RuntimeError is required.");
  }
  return Object.freeze([...errors]) as unknown as readonly [RuntimeError, ...RuntimeError[]];
}

function auditOutcome(
  status: TerminalCandidate<unknown>["status"],
): "succeeded" | "failed" | "blocked" | "cancelled" {
  return status;
}

function terminalEventName(status: TerminalCandidate<unknown>["status"]): RuntimeEventName {
  switch (status) {
    case "succeeded": return "run.completed";
    case "blocked": return "run.blocked";
    case "failed": return "run.failed";
    case "cancelled": return "run.cancelled";
  }
}

function retryRuntimeEventName(type: RetryEvent["type"]): RuntimeEventName {
  switch (type) {
    case "retry_attempt_started": return "retry.attempt.started";
    case "retry_attempt_finished": return "retry.attempt.finished";
    case "retry_scheduled": return "retry.scheduled";
    case "retry_fallback_selected": return "retry.fallback.selected";
    case "retry_exhausted": return "retry.exhausted";
    case "retry_cancelled": return "retry.cancelled";
  }
}

function assertStateTransition<TOutput>(
  current: RunState<TOutput>,
  next: RunState<TOutput>,
): void {
  if (current.runId !== next.runId || current.taskId !== next.taskId) {
    throw new Error("RunState identity cannot change.");
  }
  const terminal = current.status === "succeeded" || current.status === "blocked" ||
    current.status === "failed" || current.status === "cancelled";
  if (terminal) {
    throw new Error(`Terminal RunState ${current.status} cannot transition.`);
  }
  if (current.status === "cancelling" && next.status !== "cancelling" &&
      next.status !== "cancelled" && next.status !== "failed") {
    throw new Error(`Cancelling RunState cannot transition to ${next.status}.`);
  }
}

function freezeState<TOutput>(state: RunState<TOutput>): RunState<TOutput> {
  assertRunPermissionStateInvariant(state.permission, state.status);
  return Object.freeze(state);
}

function freezeCounters(counters: RunCounters): RunCounters {
  return Object.freeze({ ...counters });
}

function appendUnique<TValue>(
  current: readonly TValue[],
  next: readonly TValue[],
): readonly TValue[] {
  const values = [...current];
  for (const value of next) {
    if (!values.includes(value)) {
      values.push(value);
    }
  }
  return Object.freeze(values);
}

function assertNonEmpty(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${field} must be a non-empty string.`);
  }
}
