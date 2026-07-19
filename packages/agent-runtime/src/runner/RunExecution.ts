import type {
  ArtifactRef,
  EvidenceRef,
  ISODateTimeString,
  Metadata,
} from "@agent-anything/shared";
import type { ObservabilityRecordContext } from "@agent-anything/observability";
import type { AppliedPolicyAmendmentRecord } from "@agent-anything/governance";
import {
  createApprovalRequest,
  projectApprovalReviewRequest,
  validateApprovalDecision,
  type ApprovalRecord,
  type ApprovalRequirement,
  type ApprovalRequest,
  type ApprovalReviewContext,
  type ApprovalReviewFailure,
  type ApprovalReviewInput,
  type ApprovalScope,
  type PermissionResolutionEnvironmentInput,
  type SessionAuthorityRecord,
  type ValidatedApprovalDecision,
} from "@agent-anything/permission";
import type { Agent } from "@agent-anything/agent-core/agent";
import type {
  ActionAssessment,
  ActionAssessmentReviewContext,
  ActionDispatchAuthorization,
  ActionDispatchPlan,
  ActionRevalidationResult,
  ActionExecutionResult,
  PreparedExternalAction,
  SandboxAttempt,
} from "@agent-anything/action-execution";
import { ControllerError } from "../controller/ProviderBackedController.js";
import type {
  ControllerDecision,
  ControllerInput,
} from "@agent-anything/agent-core/controller";
import {
  applyContextUpdate,
  createInitialContext,
  projectContext,
  type Context,
} from "@agent-anything/agent-core/context";
import type { RuntimeEventName } from "@agent-anything/agent-core/events";
import {
  abandonPlan,
  applyPlanUpdate,
  type Plan,
  type PlanLifecycleChange,
} from "@agent-anything/agent-core/plan";
import type { Action, ActionCandidate } from "@agent-anything/agent-core/action";
import type {
  ActionDeniedObservation,
  ActionFailureObservation,
  ActionRejectedObservation,
  ApprovalDeclinedObservation,
  ApprovalLimitReachedObservation,
  ApprovalPolicyRejectedObservation,
  ApprovalReviewFailedObservation,
  ApprovalApplicationFailedObservation,
  Observation,
  PermissionsGrantedObservation,
  PlanUpdateResultObservation,
  ToolResultObservation,
} from "@agent-anything/agent-core/run";
import type {
  InterruptibleOperationKind,
  RunFinalizationContext,
  RunCancellationRequest,
} from "@agent-anything/agent-core/run";
import { toRunCancellationSummary } from "@agent-anything/agent-core/run";
import { createRunFinalizationContext } from "./RunFinalization.js";
import type { ResolvedRunConfig, RunConfig } from "./RunConfig.js";
import type { RunInput } from "@agent-anything/agent-core/run";
import type {
  ActionAssessedSummary,
  ActionInvalidatedSummary,
  ActionPreparedSummary,
  ApprovalRequestedRunItem,
  RunItem,
  RunItemBase,
  SandboxAttemptResolutionSummary,
  SandboxAttemptSummary,
} from "@agent-anything/agent-core/run";
import {
  createBlockedRunResult,
  createCancelledRunResult,
  createFailedRunResult,
  createSucceededRunResult,
  type RunBlockedCode,
  type RunFailureCode,
  type RunResult,
} from "@agent-anything/agent-core/run";
import type {
  ResolvedRunnerDependencies,
  RunnerDependencies,
} from "./RunnerDependencies.js";
import { recordRunnerLifecycle } from "./RunnerObservability.js";
import {
  snapshotAgent,
  snapshotRunConfig,
  snapshotRunInput,
  validateControllerDecision,
} from "./RunnerValidation.js";
import type { RunCounters, RunState } from "@agent-anything/agent-core/run";
import type { RuntimeError } from "@agent-anything/agent-core/run";
import {
  assertRunPermissionStateInvariant,
  createInitialRunPermissionState,
  deriveEffectivePermissionContext,
  projectPermissionContext,
  type PendingApproval,
  type RunPermissionState,
} from "@agent-anything/agent-core/run";
import {
  deriveApprovalReviewDeadline,
  deriveAuthorityCommitDeadline,
  deriveRunDeadline,
} from "@agent-anything/agent-core/run";
import {
  snapshotRetryEvent,
  type RetryEvent,
  type RetryEventSink,
} from "@agent-anything/agent-core/retry";
import {
  executeApprovalReviewer,
  type ApprovalReviewerExecutionResult,
} from "./ApprovalReviewerExecution.js";
import {
  allowsExplicitPermissionRequest,
  createPermissionRequestDecisionContract,
  preparePermissionRequestAction,
} from "./PermissionRequestAction.js";
import {
  applyCommittedPolicyAmendment,
  applyCommittedSessionAuthority,
  applyImmediateApprovalAuthority,
  consumeActionApprovalCoverage,
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
import { recordApprovalResolution } from "./RunnerApprovalObservability.js";
import {
  createApprovalRecordSummary,
  createApprovalRequestSummary,
} from "@agent-anything/agent-core/run";
import {
  authorityCommitOwner,
  executeAuthorityCommit,
  isDurableAuthorityDecision,
  type AuthorityCommitExecutionResult,
  type AuthorityCommitOwner,
} from "./AuthorityCommitExecution.js";
import { recordActionDispatchAuthorizationAudit } from "./RunnerActionDispatchAudit.js";
import {
  recordSandboxAttemptResolved,
  recordSandboxAttemptStarted,
} from "./RunnerSandboxAttemptObservability.js";
import {
  classifyToolResult,
  settleToolResultEvidence,
  type ValidToolResultClassification,
} from "./ActionResultSettlement.js";

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

interface ExternalApprovalResult extends ProcessActionResult {
  readonly authorityApplied: boolean;
}

type ExternalActionRevalidationOutcome =
  | { readonly kind: "result"; readonly result: ActionRevalidationResult }
  | { readonly kind: "processed"; readonly processed: ProcessActionResult };

interface ApprovalOperationInput {
  readonly action: Action;
  readonly request: ApprovalRequest;
  readonly cwd: string;
  readonly environment: PermissionResolutionEnvironmentInput;
  readonly reviewContext: ApprovalReviewContext;
}

type RetryEventAcceptance =
  | { readonly kind: "controller" }
  | {
      readonly kind: "approval_reviewer";
      readonly requestId: string;
      readonly pendingVersion: number;
      readonly operationId: string;
    };

type ActiveOperationKind = Extract<
  InterruptibleOperationKind,
  "controller" | "tool" | "approval_reviewer" | "authority_commit"
>;

interface ActiveOperation {
  readonly kind: ActiveOperationKind;
  readonly startedAt: ISODateTimeString;
  readonly rejectSettlement: (error: OperationSettlementTimeoutError) => void;
  interruptionTimer: ReturnType<typeof setTimeout> | null;
  settlementTimer: ReturnType<typeof setTimeout> | null;
}

class OperationSettlementTimeoutError extends Error {
  constructor(
    readonly operation: ActiveOperationKind,
    readonly interruptionKind: "run_cancellation" | "operation_deadline",
    readonly startedAt: ISODateTimeString,
    readonly timeoutMs: number,
  ) {
    super(
      `${interruptionKind} settlement timed out for the ${operation} operation.`,
    );
    this.name = "OperationSettlementTimeoutError";
  }
}

export class RunExecution<TOutput> {
  private agent!: Agent<TOutput>;
  private input!: RunInput;
  private config!: ResolvedRunConfig;
  private state!: RunState<TOutput>;
  private startedAtMs = 0;
  private terminalResult: RunResult<TOutput> | null = null;
  private cancellationListener: (() => void) | null = null;
  private activeOperation: ActiveOperation | null = null;

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
      this.clearActiveOperation();
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
    const actionPipelineParts = [
      this.dependencies.actionEnforcementPipeline !== undefined,
      this.dependencies.sandboxExecutionGateway !== undefined,
      this.dependencies.evidenceBuilder !== undefined,
      this.dependencies.evidenceStorage !== undefined,
      this.config.actionContext !== null,
    ];
    if (actionPipelineParts.some(Boolean) && !actionPipelineParts.every(Boolean)) {
      return this.createInvalidConfigResult(runtimeError(
        "runtime",
        "runtime_invalid_options",
        "ActionEnforcementPipeline, SandboxExecutionGateway, EvidenceBuilderPort, StoragePort, and RunConfig.actionContext must be configured together.",
        false,
        {},
      ));
    }

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
        decision = await this.awaitInterruptibleOperation(
          "controller",
          () => this.dependencies.controller.next(
            this.createControllerInput(),
            Object.freeze({
              cancellation: this.config.cancellation.context,
              retry: Object.freeze({
                providerRequest: this.config.retry.providerRequest,
                structuredOutput: this.config.retry.structuredOutput,
                deadlineAt: this.runDeadlineAt(),
                events: this.createRetryEventSink({ kind: "controller" }),
              }),
            }),
          ),
        );
      } catch (error) {
        if (error instanceof OperationSettlementTimeoutError) {
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
          error.operationSettlement === "settled_failure"
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
    const requestId = this.createId(
      "approval_request",
      this.state.permission.counters.lastPendingVersion + 1,
    );
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
    const decisionContract = createPermissionRequestDecisionContract({
      requestId,
      prepared: prepared.request,
      config: this.config.permissions,
    });
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
        decisionOptions: decisionContract.decisionOptions,
        trustedProposals: decisionContract.trustedProposals,
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

    return this.processApprovalOperation({
      action,
      request,
      cwd: prepared.request.cwd,
      environment: prepared.request.environment,
      reviewContext: this.createApprovalReviewContext({
        ruleOutcome: "none",
        annotations: Object.freeze({ rootId: prepared.request.rootId }),
      }),
    });
  }

  private async processApprovalOperation(
    input: ApprovalOperationInput,
  ): Promise<ProcessActionResult> {
    const { action, request } = input;
    const createdAt = request.createdAt;
    if (Date.parse(request.deadlineAt) <= Date.parse(this.now())) {
      return {
        invalidatesBatch: true,
        terminalResult: await this.fail(limitRuntimeError(
          "Run deadline elapsed before approval review could start.",
          { requestId: request.id, deadlineAt: request.deadlineAt },
        )),
      };
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
      reviewOperationId: this.createId("approval_review_operation", pendingVersion),
      version: pendingVersion,
      createdAt,
    });
    const requestedItem = this.enterApprovalReview(pending);

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
      const settlementErrors = await this.settlePendingApproval(
        record,
        "neutral",
        null,
        true,
        this.state.permission,
        new Set(["audit"]),
      );
      return {
        invalidatesBatch: true,
        terminalResult: await this.failMany(
          asErrorTuple([requestAuditError, ...settlementErrors]),
          "audit_required_failed",
        ),
      };
    }
    this.publishItems([requestedItem]);
    this.emitApprovalRequested(requestedItem);

    let review: ApprovalReviewerExecutionResult;
    try {
      review = await this.awaitInterruptibleOperation(
        "approval_reviewer",
        () => this.executeApprovalReview(input.reviewContext),
        pending.request.deadlineAt,
      );
    } catch (error) {
      if (error instanceof OperationSettlementTimeoutError) {
        const cancellation = this.cancellationRequest();
        let settlementErrors: RuntimeError[];
        if (cancellation !== null) {
          settlementErrors = await this.settlePendingApproval(
            this.createApprovalRecord({
              kind: "run_cancelled",
              cancellationRequestId: cancellation.id,
              initiatingDecision: null,
            }, { kind: "not_applicable" }),
            "neutral",
            null,
            true,
          );
          this.enterCancelling(cancellation);
        } else {
          settlementErrors = await this.settlePendingApproval(
            this.createApprovalRecord({
              kind: "review_failure",
              failure: approvalReviewFailure(
                "approval_review_timeout",
                "Approval reviewer did not settle after its deadline.",
                false,
              ),
            }, { kind: "not_applicable" }),
            "review_failure",
            null,
            true,
          );
        }
        const settlementError = approvalSettlementRuntimeError(error);
        return {
          invalidatesBatch: true,
          terminalResult: await this.failMany(
            asErrorTuple([settlementError, ...settlementErrors]),
            "approval_cancellation_unconfirmed",
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
      cwd: input.cwd,
      environment: input.environment,
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
  ): ApprovalRequestedRunItem {
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
    const item = items[0];
    if (item === undefined || item.kind !== "approval_requested") {
      throw new Error("Approval request transition did not materialize its RunItem.");
    }
    return item;
  }

  private emitApprovalRequested(
    item: ApprovalRequestedRunItem,
  ): void {
    this.emit("approval.requested", {
      runId: item.runId,
      requestId: item.request.requestId,
      actionId: item.request.actionId,
      actionFingerprint: item.request.actionFingerprint,
      category: item.request.category,
      pendingVersion: item.pendingVersion,
      reviewer: item.reviewer,
      phase: "reviewing",
      reviewOperationId: item.reviewOperationId,
    });
  }

  private async executeApprovalReview(
    reviewContext: ApprovalReviewContext,
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
    const reviewInput: ApprovalReviewInput = Object.freeze({
      request: projectApprovalReviewRequest(pending.request),
      pendingVersion: pending.version,
      context: reviewContext,
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
      events: this.createRetryEventSink({
        kind: "approval_reviewer",
        requestId: pending.request.id,
        pendingVersion: pending.version,
        operationId: pending.reviewOperationId,
      }),
      now: () => this.now(),
    });
  }

  private createApprovalReviewContext(input: {
    readonly ruleOutcome: ApprovalReviewContext["ruleOutcome"];
    readonly currentAuthority?: ApprovalReviewContext["currentAuthority"];
    readonly annotations: ApprovalReviewContext["annotations"];
  }): ApprovalReviewContext {
    const permissionProjection = projectPermissionContext(
      this.config.permissions,
      this.state.permission,
    );
    return Object.freeze({
      workspaceTrustState: this.config.workspace.trustState,
      ruleOutcome: input.ruleOutcome,
      currentAuthority: input.currentAuthority ?? Object.freeze({
        fileSystemRead: permissionProjection.authority.hasAdditionalFileSystemRead,
        fileSystemWrite: permissionProjection.authority.hasAdditionalFileSystemWrite,
        network: permissionProjection.authority.hasAdditionalNetwork,
      }),
      annotations: Object.freeze({ ...input.annotations }),
    });
  }

  private async applyValidatedPermissionDecision(
    decision: ValidatedApprovalDecision,
    rationale: string | null,
  ): Promise<ProcessActionResult> {
    const pendingAtValidation = this.requirePendingApproval();
    const auditError = await recordApprovalValidatedDecisionAudit({
      request: pendingAtValidation.request,
      pendingVersion: pendingAtValidation.version,
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
      const settlementErrors = await this.settlePendingApproval(
        record,
        "neutral",
        null,
        true,
        this.state.permission,
        new Set(["audit"]),
      );
      return {
        invalidatesBatch: true,
        terminalResult: await this.failMany(
          asErrorTuple([auditError, ...settlementErrors]),
          "audit_required_failed",
        ),
      };
    }

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
      const settlementErrors = await this.settlePendingApproval(
        record,
        "declined",
        observation,
        true,
      );
      return {
        invalidatesBatch: true,
        terminalResult: settlementErrors.length === 0
          ? null
          : await this.failMany(asErrorTuple(settlementErrors)),
      };
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
    const applied = applyImmediateApprovalAuthority({
      permission: this.state.permission,
      decision,
    });
    if (applied.status === "deferred") {
      if (!isDurableAuthorityDecision(decision)) {
        throw new Error("A deferred approval decision has no durable authority operation.");
      }
      const applying = this.requirePendingApproval();
      if (applying.phase !== "applying_authority") {
        throw new Error("Durable authority application requires an applying PendingApproval.");
      }
      const commitStartedAt = this.now();
      const commitDeadlineAt = deriveAuthorityCommitDeadline({
        runDeadlineAt: this.runDeadlineAt(),
        commitStartedAt,
        commitTimeoutMs: this.config.permissions.authorityApplicationLimits.commitTimeoutMs,
      });
      let result: AuthorityCommitExecutionResult;
      try {
        result = await this.awaitInterruptibleOperation(
          "authority_commit",
          () => executeAuthorityCommit({
            decision,
            pending: applying,
            config: this.config.permissions,
            cancellation: this.config.cancellation.context,
            startedAt: commitStartedAt,
            deadlineAt: commitDeadlineAt,
            policyAmendmentRecordId: this.createId(
              "policy_amendment_record",
              applying.version,
            ),
            now: () => this.now(),
          }),
          commitDeadlineAt,
        );
      } catch (error) {
        if (error instanceof OperationSettlementTimeoutError) {
          return this.settleUnconfirmedAuthorityCommit(
            decision,
            applying,
            commitDeadlineAt,
            error,
          );
        }
        throw error;
      }
      return this.settleAuthorityCommit(decision, result);
    }
    if (applied.status === "not_applicable") {
      throw new Error("A non-authority approval decision reached authority application.");
    }
    const pending = this.requirePendingApproval();
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
    const settlementErrors = await this.settlePendingApproval(
      record,
      "applied",
      observation,
      false,
      applied.permission,
    );
    return {
      invalidatesBatch: true,
      terminalResult: settlementErrors.length === 0
        ? null
        : await this.failMany(asErrorTuple(settlementErrors)),
    };
  }

  private async settleAuthorityCommit(
    decision: ValidatedApprovalDecision,
    result: AuthorityCommitExecutionResult,
  ): Promise<ProcessActionResult> {
    const pending = this.requirePendingApproval();
    if (result.kind === "applied") {
      const permission = result.application.target === "session_authority"
        ? applyCommittedSessionAuthority({
            permission: this.state.permission,
            record: result.record as SessionAuthorityRecord,
          })
        : applyCommittedPolicyAmendment({
            permission: this.state.permission,
            record: result.record as AppliedPolicyAmendmentRecord,
          });
      const observation = result.application.target === "session_authority" &&
          "grantedPermissions" in result.record && result.record.grantedPermissions !== null
        ? this.createSessionPermissionsGrantedObservation(pending, result.record)
        : null;
      const record = this.createApprovalRecord(
        { kind: "decision", decision },
        result.application,
      );
      const settlementErrors = await this.settlePendingApproval(
        record,
        "applied",
        observation,
        false,
        permission,
      );
      if (settlementErrors.length > 0) {
        return {
          invalidatesBatch: true,
          terminalResult: await this.failMany(asErrorTuple(settlementErrors)),
        };
      }
      return this.finishAuthoritySettlement(result, true);
    }

    const record = this.createApprovalRecord(
      { kind: "decision", decision },
      result.application,
    );
    const observation: ApprovalApplicationFailedObservation = Object.freeze({
      ...this.createObservationBaseFromPending(pending),
      kind: "approval_application_failed",
      requestId: pending.request.id,
      category: pending.request.category,
      scope: result.scope,
      code: result.kind === "interrupted"
        ? authorityInterruptionCode(result.owner)
        : result.code,
      message: result.kind === "interrupted"
        ? "Authority application was interrupted before durable commit."
        : result.message,
    });
    const settlementErrors = await this.settlePendingApproval(
      record,
      "neutral",
      observation,
      true,
    );
    if (settlementErrors.length > 0) {
      return {
        invalidatesBatch: true,
        terminalResult: await this.failMany(asErrorTuple(settlementErrors)),
      };
    }
    return this.finishAuthoritySettlement(result, false);
  }

  private settleUnconfirmedAuthorityCommit(
    decision: ValidatedApprovalDecision,
    pending: PendingApproval & { readonly phase: "applying_authority" },
    deadlineAt: ISODateTimeString,
    error: OperationSettlementTimeoutError,
  ): Promise<ProcessActionResult> {
    if (!isDurableAuthorityDecision(decision)) {
      throw new Error("An unconfirmed authority commit requires a durable decision.");
    }
    const owner = authorityCommitOwner(decision);
    const cancellation = this.cancellationRequest();
    const interruption = error.interruptionKind === "run_cancellation" && cancellation !== null
      ? Object.freeze({
          kind: "run_cancellation" as const,
          cancellation: Object.freeze({
            runId: cancellation.runId,
            requestId: cancellation.id,
          }),
        })
      : Object.freeze({
          kind: "operation_deadline" as const,
          deadline: Object.freeze({
            operationId: pending.authorityOperationId,
            deadlineAt,
          }),
        });
    const result: Extract<
      AuthorityCommitExecutionResult,
      { readonly kind: "outcome_unknown" }
    > = Object.freeze({
      kind: "outcome_unknown" as const,
      owner,
      scope: owner === "permission" ? "session" as const : "persistent" as const,
      commitId: `${pending.authorityOperationId}:commit`,
      deadlineAt,
      interruption,
      code: owner === "permission"
        ? "session_authority_commit_outcome_unknown"
        : "policy_amendment_commit_outcome_unknown",
      message: error.message,
      application: Object.freeze({
        kind: "outcome_unknown" as const,
        code: owner === "permission"
          ? "session_authority_commit_outcome_unknown"
          : "policy_amendment_commit_outcome_unknown",
      }),
    });
    return this.settleAuthorityCommit(decision, result);
  }

  private createSessionPermissionsGrantedObservation(
    pending: PendingApproval,
    record: SessionAuthorityRecord,
  ): PermissionsGrantedObservation {
    const permissions = record.grantedPermissions!;
    return Object.freeze({
      ...this.createObservationBaseFromPending(pending),
      kind: "permissions_granted",
      requestId: pending.request.id,
      category: pending.request.category,
      scope: "session",
      summary: Object.freeze({
        fileSystemReadTargetCount: permissions.fileSystem?.read?.length ?? 0,
        fileSystemWriteTargetCount: permissions.fileSystem?.write?.length ?? 0,
        networkEnabled: permissions.network?.enabled === true,
        networkDomainCount: permissions.network?.domains?.length ?? 0,
      }),
    });
  }

  private async finishAuthoritySettlement(
    result: AuthorityCommitExecutionResult,
    applied: boolean,
  ): Promise<ProcessActionResult> {
    const cancellation = this.cancellationRequest();
    if (cancellation !== null) {
      if (result.kind === "outcome_unknown") {
        this.enterCancelling(cancellation);
        return {
          invalidatesBatch: true,
          terminalResult: await this.fail(
            authorityCommitRuntimeError(result),
            authorityCommitFailureCode(result.owner, true),
          ),
        };
      }
      return { invalidatesBatch: true, terminalResult: await this.cancelRun() };
    }

    if (result.kind === "outcome_unknown") {
      return {
        invalidatesBatch: true,
        terminalResult: await this.fail(
          authorityCommitRuntimeError(result),
          authorityCommitFailureCode(result.owner, true),
        ),
      };
    }
    if (result.interruption?.kind === "operation_deadline") {
      if (result.deadlineAt === this.runDeadlineAt()) {
        return {
          invalidatesBatch: true,
          terminalResult: await this.fail(limitRuntimeError(
            "Run deadline elapsed during authority application.",
            { commitId: result.commitId, deadlineAt: result.deadlineAt },
          )),
        };
      }
      if (applied) {
        return {
          invalidatesBatch: true,
          terminalResult: await this.fail(
            runtimeError(
              result.owner,
              authorityCommitFailureCode(result.owner, false),
              "Authority was durably committed, but completion was confirmed after its operation deadline.",
              false,
              { commitId: result.commitId, deadlineAt: result.deadlineAt },
            ),
            authorityCommitFailureCode(result.owner, false),
          ),
        };
      }
    }
    return { invalidatesBatch: true, terminalResult: null };
  }

  private async settleReviewFailure(
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
    const settlementErrors = await this.settlePendingApproval(
      record,
      "review_failure",
      observation,
      true,
    );
    if (settlementErrors.length > 0) {
      return {
        invalidatesBatch: true,
        terminalResult: await this.failMany(asErrorTuple(settlementErrors)),
      };
    }
    if (
      failure.code === "approval_review_timeout" &&
      pending.request.deadlineAt === this.runDeadlineAt()
    ) {
      const terminalResult = await this.fail(limitRuntimeError(
        "Run deadline elapsed during approval review.",
        { requestId: pending.request.id, deadlineAt: pending.request.deadlineAt },
      ));
      return { invalidatesBatch: true, terminalResult };
    }
    if (
      this.state.permission.counters.consecutiveReviewFailures >=
      this.config.permissions.approvalLimits.maxConsecutiveReviewFailures
    ) {
      const terminalResult = await this.fail(runtimeError(
        "approval",
        "approval_review_failure_limit_exceeded",
        "Approval reviewer failure circuit limit was reached.",
        false,
        { requestId: pending.request.id },
      ), "approval_review_failure_limit_exceeded");
      return { invalidatesBatch: true, terminalResult };
    }
    return { invalidatesBatch: true, terminalResult: null };
  }

  private async settleCancelledApproval(
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
    const settlementErrors = await this.settlePendingApproval(
      record,
      "neutral",
      null,
      true,
    );
    if (settlementErrors.length > 0) {
      this.enterCancelling(cancellation);
      return {
        invalidatesBatch: true,
        terminalResult: await this.failMany(asErrorTuple(settlementErrors)),
      };
    }
    return {
      invalidatesBatch: true,
      terminalResult: await this.cancelRun(),
    };
  }

  private async settlePendingApproval(
    record: ApprovalRecord,
    counterEffect: ApprovalSettlementCounterEffect,
    observation: Observation | null,
    failed: boolean,
    permissionBase: RunPermissionState = this.state.permission,
    skipOwners: ReadonlySet<RuntimeError["owner"]> = new Set(),
  ): Promise<RuntimeError[]> {
    if (this.state.status !== "waiting_for_approval") {
      throw new Error(`Cannot settle approval while Run is ${this.state.status}.`);
    }
    const permission = settleApproval({
      permission: permissionBase,
      record,
      counterEffect,
    });
    const summary = createApprovalRecordSummary(record);
    const drafts: RunItemDraft<TOutput>[] = [
      (base) => Object.freeze({
        ...base,
        kind: "approval_resolved" as const,
        record: summary,
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
    const recordingStartedAt = this.now();
    const scope = createRunFinalizationContext({
      runId: this.state.runId,
      cancellation: this.cancellationRequest() === null
        ? null
        : toRunCancellationSummary(this.cancellationRequest()!),
      timeoutMs: this.config.cancellationLimits.finalizationTimeoutMs,
      startedAt: recordingStartedAt,
    });
    let errors: RuntimeError[];
    try {
      errors = await recordApprovalResolution({
        runId: record.runId,
        summary,
        taskId: this.state.taskId,
        workspace: this.config.workspace,
        identity: this.config.identity,
        timestamp: recordingStartedAt,
        counters: permission.counters,
        auditRequirement: this.config.audit,
        telemetryRequirement: this.config.telemetry,
        context: Object.freeze({
          purpose: "finalization" as const,
          signal: scope.context.signal,
          deadlineAt: scope.context.deadlineAt,
        }),
        auditPort: this.dependencies.auditPort,
        telemetryPort: this.dependencies.telemetryPort,
        skipOwners,
      });
    } finally {
      scope.dispose();
    }
    if (errors.length === 0 && skipOwners.size === 0) {
      this.publishItems(items);
      this.emitApprovalResolved(summary);
    }
    return errors;
  }

  private emitApprovalResolved(
    summary: ReturnType<typeof createApprovalRecordSummary>,
  ): void {
    this.emit("approval.resolved", {
      runId: this.state.runId,
      requestId: summary.requestId,
      actionId: summary.actionId,
      actionFingerprint: summary.actionFingerprint,
      pendingVersion: summary.pendingVersion,
      reviewer: summary.reviewer,
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
        actionKind: actionItem.action.kind,
        actionName: actionItem.action.name,
      }),
    };
  }

  private async processToolAction(
    action: Action & { readonly kind: "tool" },
  ): Promise<ProcessActionResult> {
    if (this.dependencies.actionEnforcementPipeline === undefined) {
      const observation: ActionRejectedObservation = Object.freeze({
        ...this.createObservationBase(action),
        kind: "action_rejected",
        code: "action_unsupported",
        message: "This Runner has no canonical Action pipeline.",
      });
      return this.commitActionObservation(observation, true, true);
    }

    this.emit("tool.started", {
      runId: this.state.runId,
      actionId: action.id,
      toolName: action.name,
    });

    return this.processExternalToolAction(action);
  }

  private async processExternalToolAction(
    action: Action & { readonly kind: "tool" },
  ): Promise<ProcessActionResult> {
    const pipeline = this.dependencies.actionEnforcementPipeline;
    const context = this.config.actionContext;
    if (pipeline === undefined || context === null) {
      throw new Error("External Action processing requires a complete pipeline composition.");
    }

    let preparation;
    try {
      preparation = await this.awaitInterruptibleOperation(
        "tool",
        () => pipeline.prepare({
          action,
          workspace: {
            workspaceId: context.workspace.workspaceId,
            trustState: context.workspace.trustState,
            roots: context.workspace.roots.map((root) => ({
              rootId: root.rootId,
              platform: root.platform,
              path: root.canonicalPath,
              resolvedPath: root.resolvedPath ?? root.canonicalPath,
              resolutionFingerprint: root.resolutionFingerprint,
            })),
          },
          actor: context.actor,
          environment: context.environment,
          interruption: this.createActionInterruptionContext(),
        }),
        this.runDeadlineAt(),
      );
    } catch (error) {
      return this.handleActionPipelineOperationError(action, error, "preparation");
    }

    if (preparation.status === "rejected") {
      const observation: ActionRejectedObservation = Object.freeze({
        ...this.createObservationBase(action),
        kind: "action_rejected",
        code: preparation.code,
        message: preparation.message,
      });
      return this.commitActionObservation(observation, true, true);
    }
    if (preparation.status === "failed") {
      return this.commitActionFailure(action, preparation.error);
    }
    if (preparation.status === "interrupted") {
      return this.handleActionInterruption(action);
    }

    this.recordActionPrepared(preparation.prepared);
    return this.assessPreparedExternalAction(action, preparation.prepared, 1);
  }

  private async assessPreparedExternalAction(
    action: Action & { readonly kind: "tool" },
    prepared: PreparedExternalAction,
    attemptOrdinal: 1 | 2,
  ): Promise<ProcessActionResult> {
    const pipeline = this.dependencies.actionEnforcementPipeline;
    if (pipeline === undefined) {
      throw new Error("Prepared Action assessment requires ActionEnforcementPipeline.");
    }

    while (this.isRunning()) {
      const assessmentStartedAt = this.now();
      const approvalDeadlineAt = deriveApprovalReviewDeadline({
        runDeadlineAt: this.runDeadlineAt(),
        reviewStartedAt: assessmentStartedAt,
        reviewTimeoutMs: this.config.permissions.reviewer?.reviewTimeoutMs ?? null,
      });
      let assessment: ActionAssessment;
      try {
        assessment = await this.awaitInterruptibleOperation(
          "tool",
          () => pipeline.assess({
            prepared,
            authority: this.createActionAssessmentAuthority(approvalDeadlineAt),
            interruption: this.createActionInterruptionContext(),
          }),
          this.runDeadlineAt(),
        );
      } catch (error) {
        return this.handleActionPipelineOperationError(action, error, "assessment");
      }

      this.recordActionAssessed(prepared, assessment);

      if (assessment.status === "approval_required") {
        const result = await this.processExternalActionApproval(
          action,
          assessment.requirement,
          assessment.reviewContext,
          assessmentStartedAt,
        );
        if (result.terminalResult !== null || !result.authorityApplied) return result;
        continue;
      }
      if (assessment.status !== "authorized") {
        return this.commitActionAssessment(action, prepared, assessment);
      }

      const revalidationOutcome = await this.revalidatePreparedExternalAction(
        action,
        prepared,
        assessment.authorization,
        attemptOrdinal,
      );
      if (revalidationOutcome.kind === "processed") return revalidationOutcome.processed;
      const revalidation = revalidationOutcome.result;
      if (revalidation.status === "approval_required") {
        const result = await this.processExternalActionApproval(
          action,
          revalidation.requirement,
          revalidation.reviewContext,
          this.now(),
        );
        if (result.terminalResult !== null || !result.authorityApplied) return result;
        continue;
      }
      if (revalidation.status !== "ready") {
        return this.commitActionRevalidation(action, prepared, revalidation);
      }
      return this.commitActionDispatchPlan(action, prepared, revalidation.plan);
    }

    if (this.cancellationRequest() !== null) {
      return { invalidatesBatch: true, terminalResult: await this.cancelRun() };
    }
    throw new Error("Prepared Action assessment left the running lifecycle unexpectedly.");
  }

  private async processExternalActionApproval(
    action: Action & { readonly kind: "tool" },
    requirement: ApprovalRequirement,
    reviewContext: ActionAssessmentReviewContext,
    createdAt: ISODateTimeString,
  ): Promise<ExternalApprovalResult> {
    const requestOrdinal = this.state.permission.counters.lastPendingVersion + 1;
    const request = createApprovalRequest({
      id: this.createId("approval_request", requestOrdinal),
      createdAt,
      requirement,
    }) as ApprovalRequest;
    const result = await this.processApprovalOperation({
      action,
      request,
      cwd: this.actionDecisionCwd(),
      environment: this.actionDecisionEnvironment(),
      reviewContext: this.createApprovalReviewContext({
        ruleOutcome: reviewContext.ruleOutcome,
        currentAuthority: reviewContext.currentAuthority,
        annotations: Object.freeze({ source: "external_action" }),
      }),
    });
    if (result.terminalResult !== null) {
      return Object.freeze({ ...result, authorityApplied: false });
    }
    const record = this.state.permission.approvalRecords.find(
      (candidate) => candidate.requestId === request.id,
    );
    return Object.freeze({
      ...result,
      invalidatesBatch: true,
      authorityApplied: record?.application.kind === "applied",
    });
  }

  private async revalidatePreparedExternalAction(
    action: Action & { readonly kind: "tool" },
    prepared: PreparedExternalAction,
    authorization: ActionDispatchAuthorization,
    attemptOrdinal: 1 | 2,
  ): Promise<ExternalActionRevalidationOutcome> {
    const pipeline = this.dependencies.actionEnforcementPipeline;
    if (pipeline === undefined) {
      throw new Error("Prepared Action revalidation requires ActionEnforcementPipeline.");
    }
    const startedAt = this.now();
    const approvalDeadlineAt = deriveApprovalReviewDeadline({
      runDeadlineAt: this.runDeadlineAt(),
      reviewStartedAt: startedAt,
      reviewTimeoutMs: this.config.permissions.reviewer?.reviewTimeoutMs ?? null,
    });
    try {
      const result = await this.awaitInterruptibleOperation(
        "tool",
        () => pipeline.revalidate({
          prepared,
          authorization,
          authority: this.createActionAssessmentAuthority(approvalDeadlineAt),
          interruption: this.createActionInterruptionContext(),
          attemptOrdinal,
        }),
        this.runDeadlineAt(),
      );
      return Object.freeze({ kind: "result" as const, result });
    } catch (error) {
      const handled = await this.handleActionPipelineOperationError(
        action,
        error,
        "revalidation",
      );
      return Object.freeze({ kind: "processed" as const, processed: handled });
    }
  }

  private createActionAssessmentAuthority(approvalDeadlineAt: ISODateTimeString) {
    const effective = deriveEffectivePermissionContext(
      this.config.permissions,
      this.state.permission,
    );
    return Object.freeze({
      profile: effective.profile,
      approvalPolicy: this.config.permissions.approvalPolicy,
      managedConstraints: this.config.permissions.managedConstraints,
      execRules: this.config.permissions.rules,
      networkRules: this.config.permissions.networkRules,
      runPermissionGrants: effective.runPermissionGrants,
      sessionAuthorityContext: this.config.permissions.sessionAuthority?.context ?? null,
      sessionAuthorityRecords: effective.sessionAuthorityRecords,
      appliedPolicyAmendments: effective.appliedPolicyAmendments,
      actionCoverage: this.state.permission.actionCoverage,
      approvalDeadlineAt,
    });
  }

  private createActionInterruptionContext() {
    const cancellation = this.config.cancellation.context;
    return Object.freeze({
      signal: cancellation.signal,
      get interruption() {
        const request = cancellation.request;
        return request === null
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

  private actionDecisionEnvironment(): PermissionResolutionEnvironmentInput {
    const profile = this.config.permissions.permissionProfile;
    return Object.freeze({
      environmentId: profile.environmentId,
      platform: profile.platform,
      workspaceRoots: Object.freeze(profile.workspaceRoots.map((root) => Object.freeze({
        rootId: root.rootId,
        path: root.canonicalPath,
      }))),
    });
  }

  private actionDecisionCwd(): string {
    const root = this.config.permissions.permissionProfile.workspaceRoots[0];
    if (root === undefined) throw new Error("Action approval requires a resolved workspace root.");
    return root.canonicalPath;
  }

  private recordActionPrepared(prepared: PreparedExternalAction): void {
    if (this.state.status !== "running") return;
    const summary: ActionPreparedSummary = Object.freeze({
      actionId: prepared.action.id,
      actionFingerprint: prepared.actionFingerprint,
      category: prepared.safeSummary.kind,
      effectCount: prepared.subject.effectSet.kind === "effects"
        ? prepared.subject.effectSet.values.length
        : 0,
      targetAssertionCount: prepared.subject.targetAssertions.length,
    });
    this.commitRunning([(base) => Object.freeze({
      ...base,
      kind: "action_prepared" as const,
      prepared: summary,
    })]);
    this.emit("action.prepared", { runId: this.state.runId, ...summary });
  }

  private recordActionAssessed(
    prepared: PreparedExternalAction,
    assessment: ActionAssessment,
  ): void {
    if (this.state.status !== "running") return;
    const summary: ActionAssessedSummary = Object.freeze({
      actionId: prepared.action.id,
      actionFingerprint: prepared.actionFingerprint,
      status: assessment.status,
      owner: assessment.status === "denied"
        ? assessment.owner
        : assessment.status === "invalidated"
        ? "tool"
        : assessment.status === "failed"
        ? assessment.error.owner === "policy" ||
            assessment.error.owner === "permission" ||
            assessment.error.owner === "tool"
          ? assessment.error.owner
          : null
        : null,
      code: assessment.status === "denied" || assessment.status === "invalidated"
        ? assessment.code
        : assessment.status === "failed"
        ? assessment.error.code
        : null,
    });
    this.commitRunning([(base) => Object.freeze({
      ...base,
      kind: "action_assessed" as const,
      assessment: summary,
    })]);
    this.emit("action.assessed", { runId: this.state.runId, ...summary });
  }

  private recordActionInvalidated(
    prepared: PreparedExternalAction,
    phase: ActionInvalidatedSummary["phase"],
    owner: ActionInvalidatedSummary["owner"],
    code: string,
  ): void {
    if (this.state.status !== "running") return;
    const summary: ActionInvalidatedSummary = Object.freeze({
      actionId: prepared.action.id,
      actionFingerprint: prepared.actionFingerprint,
      phase,
      owner,
      code,
    });
    this.commitRunning([(base) => Object.freeze({
      ...base,
      kind: "action_invalidated" as const,
      invalidation: summary,
    })]);
    this.emit("action.invalidated", { runId: this.state.runId, ...summary });
  }

  private commitActionAssessment(
    action: Action,
    prepared: PreparedExternalAction,
    assessment: Exclude<
      ActionAssessment,
      { readonly status: "approval_required" | "authorized" }
    >,
  ): Promise<ProcessActionResult> {
    if (assessment.status === "denied") {
      const observation: ActionDeniedObservation = Object.freeze({
        ...this.createObservationBase(action),
        kind: "action_denied",
        owner: assessment.owner,
        code: assessment.code,
        message: assessment.message,
      });
      return this.commitActionObservation(observation, true, true);
    }
    if (assessment.status === "invalidated") {
      this.recordActionInvalidated(prepared, "assessment", "tool", assessment.code);
      const observation: ActionDeniedObservation = Object.freeze({
        ...this.createObservationBase(action),
        kind: "action_denied",
        owner: "tool",
        code: assessment.code,
        message: assessment.message,
      });
      return this.commitActionObservation(observation, true, true);
    }
    if (assessment.status === "failed") {
      return this.commitActionFailure(action, assessment.error);
    }
    if (assessment.status === "interrupted") {
      return this.handleActionInterruption(action);
    }

    return this.handleActionInterruption(action);
  }

  private commitActionRevalidation(
    action: Action,
    prepared: PreparedExternalAction,
    revalidation: Exclude<
      ActionRevalidationResult,
      { readonly status: "approval_required" | "ready" }
    >,
  ): Promise<ProcessActionResult> {
    if (revalidation.status === "denied") {
      const observation: ActionDeniedObservation = Object.freeze({
        ...this.createObservationBase(action),
        kind: "action_denied",
        owner: revalidation.owner,
        code: revalidation.code,
        message: revalidation.message,
      });
      return this.commitActionObservation(observation, true, true);
    }
    if (revalidation.status === "invalidated") {
      this.recordActionInvalidated(prepared, "revalidation", "tool", revalidation.code);
      const observation: ActionDeniedObservation = Object.freeze({
        ...this.createObservationBase(action),
        kind: "action_denied",
        owner: "tool",
        code: revalidation.code,
        message: revalidation.message,
      });
      return this.commitActionObservation(observation, true, true);
    }
    if (revalidation.status === "failed") {
      return this.commitActionFailure(action, revalidation.error);
    }
    return this.handleActionInterruption(action);
  }

  private async commitActionDispatchPlan(
    action: Action & { readonly kind: "tool" },
    prepared: PreparedExternalAction,
    plan: ActionDispatchPlan,
  ): Promise<ProcessActionResult> {
    if (this.cancellationRequest() !== null) {
      return { invalidatesBatch: true, terminalResult: await this.cancelRun() };
    }

    if (plan.actionCoverageIdToConsume !== null) {
      const consumed = consumeActionApprovalCoverage({
        permission: this.state.permission,
        coverageId: plan.actionCoverageIdToConsume,
        runId: plan.runId,
        actionId: plan.actionId,
        actionFingerprint: plan.actionFingerprint,
      });
      if (consumed.status === "rejected") {
        this.recordActionInvalidated(prepared, "dispatch", "permission", consumed.code);
        const observation: ActionDeniedObservation = Object.freeze({
          ...this.createObservationBase(action),
          kind: "action_denied",
          owner: "permission",
          code: consumed.code,
          message: "The exact Action approval coverage is unavailable for dispatch.",
        });
        return this.commitActionObservation(observation, true, true);
      }
      if (this.state.status !== "running" || consumed.permission.pendingApproval !== null) {
        throw new Error("Action coverage can be consumed only while the Run is active.");
      }
      this.replaceState(freezeState({
        ...this.state,
        permission: Object.freeze({
          ...consumed.permission,
          pendingApproval: null,
        }),
      }));
    }

    if (this.cancellationRequest() !== null) {
      return { invalidatesBatch: true, terminalResult: await this.cancelRun() };
    }

    let auditError: RuntimeError | null;
    try {
      auditError = await this.awaitInterruptibleOperation(
        "tool",
        () => recordActionDispatchAuthorizationAudit({
          plan,
          taskId: this.state.taskId,
          workspace: this.config.workspace,
          identity: this.config.identity,
          timestamp: this.now(),
          requirement: this.config.audit,
          signal: this.config.cancellation.context.signal,
          ...(this.dependencies.auditPort === undefined
            ? {}
            : { port: this.dependencies.auditPort }),
        }),
        this.runDeadlineAt(),
      );
    } catch (error) {
      if (error instanceof OperationSettlementTimeoutError) {
        return {
          invalidatesBatch: true,
          terminalResult: await this.fail(
            cancellationSettlementRuntimeError(error),
            "runtime_cancellation_settlement_timeout",
          ),
        };
      }
      if (this.cancellationRequest() !== null) {
        return { invalidatesBatch: true, terminalResult: await this.cancelRun() };
      }
      auditError = runtimeError(
        "audit",
        "audit_required_failed",
        "Action dispatch authorization Audit failed unexpectedly.",
        false,
        { actionId: action.id },
      );
    }
    if (auditError !== null) {
      return {
        invalidatesBatch: true,
        terminalResult: await this.fail(auditError, "audit_required_failed"),
      };
    }
    if (this.cancellationRequest() !== null) {
      return { invalidatesBatch: true, terminalResult: await this.cancelRun() };
    }

    const gateway = this.dependencies.sandboxExecutionGateway;
    if (gateway === undefined) {
      throw new Error("Authorized Action dispatch requires SandboxExecutionGateway.");
    }
    let sandboxPreparation;
    try {
      sandboxPreparation = await this.awaitInterruptibleOperation(
        "tool",
        () => gateway.prepare({
          plan,
          preparedInvocation: prepared.preparedInvocation,
          deadlineAt: this.runDeadlineAt(),
          interruption: this.createActionInterruptionContext(),
        }),
        this.runDeadlineAt(),
      );
    } catch (error) {
      return this.handleActionPipelineOperationError(action, error, "dispatch");
    }
    if (sandboxPreparation.status === "failed") {
      return {
        invalidatesBatch: true,
        terminalResult: await this.fail(
          sandboxPreparation.error,
          "sandbox_enforcement_failed",
        ),
      };
    }
    if (sandboxPreparation.status === "interrupted") {
      return this.handleActionInterruption(action);
    }

    const sandboxAttempt = sandboxPreparation.prepared.attempt;
    let startErrors: readonly RuntimeError[];
    try {
      startErrors = await this.awaitInterruptibleOperation(
        "tool",
        () => recordSandboxAttemptStarted({
          attempt: sandboxAttempt,
          taskId: this.state.taskId,
          workspace: this.config.workspace,
          identity: this.config.identity,
          timestamp: this.now(),
          auditRequirement: this.config.audit,
          telemetryRequirement: this.config.telemetry,
          signal: this.config.cancellation.context.signal,
          ...(this.dependencies.auditPort === undefined
            ? {}
            : { auditPort: this.dependencies.auditPort }),
          ...(this.dependencies.telemetryPort === undefined
            ? {}
            : { telemetryPort: this.dependencies.telemetryPort }),
        }),
        this.runDeadlineAt(),
      );
    } catch (error) {
      return this.handleActionPipelineOperationError(action, error, "dispatch");
    }
    if (startErrors.length > 0) {
      const error = startErrors[0]!;
      return {
        invalidatesBatch: true,
        terminalResult: await this.fail(error, infrastructureFailureCode(error)),
      };
    }
    this.commitSettledToolState([
      (base) => Object.freeze({
        ...base,
        kind: "sandbox_attempt_started" as const,
        attempt: sandboxAttemptSummary(sandboxAttempt),
      }),
    ], {});
    this.emit("sandbox.attempt.started", {
      runId: sandboxAttempt.runId,
      actionId: sandboxAttempt.actionId,
      attemptId: sandboxAttempt.id,
      ordinal: sandboxAttempt.ordinal,
      enforcement: sandboxAttempt.enforcement,
    });

    let execution: ActionExecutionResult;
    try {
      execution = await this.awaitInterruptibleOperation(
        "tool",
        () => gateway.execute(sandboxPreparation.prepared),
        this.runDeadlineAt(),
        true,
      );
    } catch (error) {
      return this.handleActionPipelineOperationError(action, error, "dispatch");
    }

    let toolResultClassification: ValidToolResultClassification | null = null;
    let retainedToolOutcome: {
      readonly observation: ToolResultObservation | null;
      readonly items: readonly RunItem<TOutput>[];
      readonly counters: RunCounters;
    } | null = null;
    if (execution.status === "executed") {
      const classification = classifyToolResult(execution.toolResult);
      if (classification.status === "invalid") {
        execution = Object.freeze({
          status: "failed" as const,
          attempt: execution.attempt,
          error: classification.error,
        });
      } else {
        toolResultClassification = classification;
        const observation = classification.createObservation
          ? this.createExternalToolResultObservation(action, execution)
          : null;
        retainedToolOutcome = Object.freeze({
          observation,
          ...this.retainExternalToolOutcome(action, observation, classification.failed),
        });
      }
    }

    const resolution = sandboxAttemptResolution(sandboxAttempt, execution, this.now());
    this.commitSettledToolState([
      (base) => Object.freeze({
        ...base,
        kind: "sandbox_attempt_resolved" as const,
        resolution,
      }),
    ], {});
    this.emit("sandbox.attempt.resolved", {
      runId: sandboxAttempt.runId,
      actionId: sandboxAttempt.actionId,
      attemptId: sandboxAttempt.id,
      ordinal: sandboxAttempt.ordinal,
      enforcement: sandboxAttempt.enforcement,
      outcome: resolution.outcome,
      code: resolution.code,
    });

    let resolutionErrors: readonly RuntimeError[];
    try {
      resolutionErrors = await this.awaitInterruptibleOperation(
        "tool",
        () => recordSandboxAttemptResolved({
          attempt: sandboxAttempt,
          resolution,
          taskId: this.state.taskId,
          workspace: this.config.workspace,
          identity: this.config.identity,
          timestamp: resolution.settledAt,
          auditRequirement: this.config.audit,
          telemetryRequirement: this.config.telemetry,
          signal: new AbortController().signal,
          ...(this.dependencies.auditPort === undefined
            ? {}
            : { auditPort: this.dependencies.auditPort }),
          ...(this.dependencies.telemetryPort === undefined
            ? {}
            : { telemetryPort: this.dependencies.telemetryPort }),
        }),
        this.runDeadlineAt(),
        true,
      );
    } catch (error) {
      if (error instanceof OperationSettlementTimeoutError) {
        if (execution.status === "executed" && retainedToolOutcome !== null) {
          this.publishExternalToolOutcome(
            action,
            execution,
            retainedToolOutcome.items,
            retainedToolOutcome.observation,
            [],
            { status: "failed", code: "runtime_cancellation_settlement_timeout" },
          );
        }
        return {
          invalidatesBatch: true,
          terminalResult: await this.fail(
            cancellationSettlementRuntimeError(error),
            "runtime_cancellation_settlement_timeout",
          ),
        };
      }
      resolutionErrors = Object.freeze([runtimeError(
        "runtime",
        "runtime_action_dispatch_failed",
        "Sandbox attempt settlement failed unexpectedly.",
        false,
        { actionId: action.id, attemptId: sandboxAttempt.id },
      )]);
    }
    if (resolutionErrors.length > 0) {
      const error = resolutionErrors[0]!;
      if (execution.status === "executed" && retainedToolOutcome !== null) {
        this.publishExternalToolOutcome(
          action,
          execution,
          retainedToolOutcome.items,
          retainedToolOutcome.observation,
          [],
          { status: "failed", code: error.code },
        );
      }
      return {
        invalidatesBatch: true,
        terminalResult: await this.fail(error, infrastructureFailureCode(error)),
      };
    }

    if (execution.status === "executed") {
      if (toolResultClassification === null) {
        throw new Error("Executed Action lost its validated ToolResult classification.");
      }
      if (retainedToolOutcome === null) {
        throw new Error("Executed Action lost its retained ToolResult state.");
      }
      return this.settleExecutedActionResult(
        action,
        execution,
        toolResultClassification,
        retainedToolOutcome,
      );
    }
    if (execution.status === "sandbox_denied") {
      return this.processSandboxDenial(action, prepared, plan, execution);
    }
    if (execution.status === "sandbox_unavailable") {
      const error = runtimeError(
        "sandbox",
        execution.code,
        "The selected sandbox enforcement could not execute the Action.",
        false,
        {
          actionId: action.id,
          attemptId: execution.attempt.id,
          stage: execution.stage,
          effectState: execution.effectState,
        },
      );
      return {
        invalidatesBatch: true,
        terminalResult: await this.fail(error, "sandbox_enforcement_failed"),
      };
    }
    if (execution.status === "interrupted") {
      return this.handleActionInterruption(action, execution.interruption);
    }
    if (execution.error.code === "tool_result_invalid") {
      return {
        invalidatesBatch: true,
        terminalResult: await this.fail(execution.error, "tool_execution_failed"),
      };
    }
    if (execution.error.owner === "tool") {
      return this.commitActionFailure(action, execution.error);
    }
    return {
      invalidatesBatch: true,
      terminalResult: await this.fail(execution.error, "sandbox_enforcement_failed"),
    };
  }

  private async settleExecutedActionResult(
    action: Action & { readonly kind: "tool" },
    execution: Extract<ActionExecutionResult, { readonly status: "executed" }>,
    classification: ValidToolResultClassification,
    retained: {
      readonly observation: ToolResultObservation | null;
      readonly items: readonly RunItem<TOutput>[];
      readonly counters: RunCounters;
    },
  ): Promise<ProcessActionResult> {
    const evidenceBuilder = this.dependencies.evidenceBuilder;
    const evidenceStorage = this.dependencies.evidenceStorage;
    if (evidenceBuilder === undefined || evidenceStorage === undefined) {
      throw new Error("Complete Action result settlement dependencies are unavailable.");
    }

    let settlement;
    try {
      settlement = await this.awaitInterruptibleOperation(
        "tool",
        () => settleToolResultEvidence({
          actionId: action.id,
          toolResult: execution.toolResult,
          classification,
          evidenceBuilder,
          storage: evidenceStorage,
          isInterrupted: () => this.cancellationRequest() !== null,
        }),
        this.runDeadlineAt(),
        true,
      );
    } catch (error) {
      if (error instanceof OperationSettlementTimeoutError) {
        this.publishExternalToolOutcome(action, execution, retained.items, retained.observation, [], {
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
      settlement = Object.freeze({
        status: "failed" as const,
        evidenceRefs: Object.freeze([]),
        artifactRefs: Object.freeze([]),
        error: runtimeError(
          "tool",
          "tool_evidence_creation_failed",
          "Action result settlement failed unexpectedly.",
          false,
          { actionId: action.id },
        ),
      });
    }

    const contextWithEvidence = applyContextUpdate(this.state.context, {
      observations: [],
      evidenceRefs: settlement.evidenceRefs,
      metadata: {
        lastActionId: action.id,
        lastControllerIteration: action.provenance.controllerIteration,
      },
    });
    this.commitSettledToolState([], {
      context: contextWithEvidence,
      evidenceRefs: settlement.evidenceRefs,
      artifactRefs: settlement.artifactRefs,
    });
    this.publishExternalToolOutcome(
      action,
      execution,
      retained.items,
      retained.observation,
      settlement.evidenceRefs,
      settlement.status === "failed"
        ? { status: "failed", code: settlement.error.code }
        : { status: classification.failed ? "failed" : "succeeded", code: execution.toolResult.error?.code ?? null },
    );

    if (settlement.status === "failed") {
      return {
        invalidatesBatch: true,
        terminalResult: await this.fail(
          settlement.error,
          settlement.error.owner === "storage" ? "storage_write_failed" : "tool_execution_failed",
        ),
      };
    }
    if (settlement.status === "interrupted" || this.cancellationRequest() !== null) {
      return { invalidatesBatch: true, terminalResult: await this.cancelRun() };
    }
    if (
      retained.counters.consecutiveActionFailures >
        this.config.limits.maxConsecutiveActionFailures
    ) {
      return {
        invalidatesBatch: true,
        terminalResult: await this.fail(limitRuntimeError(
          "Run exceeded maxConsecutiveActionFailures.",
          {
            maxConsecutiveActionFailures:
              this.config.limits.maxConsecutiveActionFailures,
            actualConsecutiveActionFailures:
              retained.counters.consecutiveActionFailures,
          },
        )),
      };
    }
    return { invalidatesBatch: true, terminalResult: null };
  }

  private createExternalToolResultObservation(
    action: Action,
    execution: Extract<ActionExecutionResult, { readonly status: "executed" }>,
  ): ToolResultObservation {
    const base = this.createObservationBase(action);
    return Object.freeze({
      ...base,
      kind: "tool_result" as const,
      result: execution.toolResult,
      metadata: Object.freeze({
        ...base.metadata,
        toolName: execution.toolResult.toolName,
        toolResultStatus: execution.toolResult.status,
        sandboxAttemptId: execution.attempt.id,
        sandboxEnforcement: execution.attempt.enforcement,
        sandboxIsolation: execution.isolation,
      }),
    });
  }

  private retainExternalToolOutcome(
    action: Action,
    observation: Observation | null,
    failed: boolean,
  ): { readonly items: readonly RunItem<TOutput>[]; readonly counters: RunCounters } {
    const context = applyContextUpdate(this.state.context, {
      observations: observation === null ? [] : [observation],
      evidenceRefs: [],
      metadata: {
        lastActionId: action.id,
        lastControllerIteration: action.provenance.controllerIteration,
      },
    });
    const counters = nextActionCounters(this.state.counters, failed);
    const items = observation === null
      ? Object.freeze([])
      : this.materializeItems([observationDraft<TOutput>(observation)]);
    this.replaceState(freezeState({
      ...this.state,
      context,
      counters,
      items: Object.freeze([...this.state.items, ...items]),
    }));
    return Object.freeze({ items, counters });
  }

  private publishExternalToolOutcome(
    action: Action,
    execution: Extract<ActionExecutionResult, { readonly status: "executed" }>,
    items: readonly RunItem<TOutput>[],
    observation: Observation | null,
    evidenceRefs: readonly EvidenceRef[],
    outcome: { readonly status: "succeeded" | "failed"; readonly code: string | null },
  ): void {
    this.publishItems(items);
    if (observation !== null) {
      this.publishObservationNotifications(observation, evidenceRefs);
    }
    this.emit("tool.finished", {
      runId: this.state.runId,
      actionId: action.id,
      toolName: execution.toolResult.toolName,
      status: outcome.status,
      code: outcome.code,
      toolResultStatus: execution.toolResult.status,
      durationMs: Math.max(
        0,
        Date.parse(execution.toolResult.finishedAt) - Date.parse(execution.toolResult.startedAt),
      ),
    });
  }

  private async processSandboxDenial(
    action: Action & { readonly kind: "tool" },
    prepared: PreparedExternalAction,
    plan: ActionDispatchPlan,
    execution: Extract<ActionExecutionResult, { readonly status: "sandbox_denied" }>,
  ): Promise<ProcessActionResult> {
    if (plan.attemptOrdinal === 2) {
      return this.commitSandboxDenialObservation(
        action,
        execution.denial.code,
        execution.denial.message,
      );
    }
    const pipeline = this.dependencies.actionEnforcementPipeline;
    if (pipeline === undefined) {
      throw new Error("Sandbox denial processing requires ActionEnforcementPipeline.");
    }
    let escalation;
    try {
      escalation = await this.awaitInterruptibleOperation(
        "tool",
        () => pipeline.deriveEscalation({
          prepared,
          plan,
          denial: execution.denial,
          interruption: this.createActionInterruptionContext(),
        }),
        this.runDeadlineAt(),
      );
    } catch (error) {
      return this.handleActionPipelineOperationError(action, error, "escalation");
    }
    if (escalation.status === "eligible") {
      const proposal = escalation.proposal;
      this.commitSettledToolState([
        (base) => Object.freeze({
          ...base,
          kind: "sandbox_escalation_proposed" as const,
          previousAttemptId: proposal.previousAttemptId,
          actionId: action.id,
          previousActionFingerprint: proposal.previousActionFingerprint,
          nextActionFingerprint: proposal.prepared.actionFingerprint,
          deniedEffectKind: execution.denial.deniedEffect.kind as "file_system" | "network",
        }),
      ], {});
      this.emit("sandbox.escalation.proposed", {
        runId: this.state.runId,
        actionId: action.id,
        previousAttemptId: proposal.previousAttemptId,
        previousActionFingerprint: proposal.previousActionFingerprint,
        nextActionFingerprint: proposal.prepared.actionFingerprint,
        deniedEffectKind: execution.denial.deniedEffect.kind,
      });
      return this.assessPreparedExternalAction(action, proposal.prepared, 2);
    }
    if (escalation.status === "ineligible" || escalation.status === "invalidated") {
      if (escalation.status === "invalidated") {
        this.recordActionInvalidated(prepared, "revalidation", "tool", escalation.code);
      }
      return this.commitSandboxDenialObservation(
        action,
        escalation.code,
        escalation.message,
      );
    }
    if (escalation.status === "interrupted") {
      return this.handleActionInterruption(action);
    }
    return {
      invalidatesBatch: true,
      terminalResult: await this.fail(
        escalation.error,
        "tool_sandbox_escalation_failed",
      ),
    };
  }

  private commitSandboxDenialObservation(
    action: Action,
    code: string,
    message: string,
  ): Promise<ProcessActionResult> {
    const observation: ActionDeniedObservation = Object.freeze({
      ...this.createObservationBase(action),
      kind: "action_denied",
      owner: "sandbox",
      code,
      message,
    });
    return this.commitActionObservation(observation, true, true);
  }

  private commitActionFailure(
    action: Action,
    error: RuntimeError,
  ): Promise<ProcessActionResult> {
    const observation: ActionFailureObservation = Object.freeze({
      ...this.createObservationBase(action),
      kind: "action_failure",
      error,
    });
    return this.commitActionObservation(observation, true, true);
  }

  private handleActionInterruption(
    action: Action,
    interruption?: Extract<ActionExecutionResult, { readonly status: "interrupted" }>["interruption"],
  ): Promise<ProcessActionResult> {
    if (this.cancellationRequest() !== null) {
      return this.cancelRun().then((terminalResult) => ({
        invalidatesBatch: true,
        terminalResult,
      }));
    }
    if (interruption?.kind === "operation_deadline") {
      return this.commitActionFailure(action, runtimeError(
        "tool",
        "tool_timeout",
        "Action execution exceeded its operation deadline.",
        false,
        {
          actionId: action.id,
          operationId: interruption.deadline.operationId,
          deadlineAt: interruption.deadline.deadlineAt,
        },
      ));
    }
    if (interruption?.kind === "run_cancellation") {
      return this.fail(runtimeError(
        "tool",
        "tool_cancellation_unconfirmed",
        "Action reported Run cancellation without a matching active request.",
        false,
        {
          actionId: action.id,
          reportedRunId: interruption.cancellation.runId,
          reportedRequestId: interruption.cancellation.requestId,
        },
      ), "tool_cancellation_unconfirmed").then((terminalResult) => ({
        invalidatesBatch: true,
        terminalResult,
      }));
    }
    return this.commitActionFailure(action, runtimeError(
      "runtime",
      "runtime_action_interrupted",
      "Action processing was interrupted before execution.",
      false,
      { actionId: action.id },
    ));
  }

  private async handleActionPipelineOperationError(
    action: Action,
    error: unknown,
    phase: "preparation" | "assessment" | "revalidation" | "dispatch" | "escalation",
  ): Promise<ProcessActionResult> {
    if (error instanceof OperationSettlementTimeoutError) {
      return {
        invalidatesBatch: true,
        terminalResult: await this.fail(
          cancellationSettlementRuntimeError(error),
          "runtime_cancellation_settlement_timeout",
        ),
      };
    }
    if (this.cancellationRequest() !== null) {
      return { invalidatesBatch: true, terminalResult: await this.cancelRun() };
    }
    return this.commitActionFailure(action, runtimeError(
      "runtime",
      `runtime_action_${phase}_failed`,
      `Action ${phase} failed unexpectedly.`,
      false,
      { actionId: action.id },
    ));
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
    this.publishObservationNotifications(observation, []);

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

  private publishObservationNotifications(
    observation: Observation,
    evidenceRefs: readonly EvidenceRef[],
  ): void {
    const outcome = observationNotificationOutcome(observation);
    this.emit("observation.created", {
      runId: this.state.runId,
      actionId: observation.actionId,
      observationId: observation.id,
      status: outcome.status,
      code: outcome.code,
    });
    this.emit("context.updated", {
      runId: this.state.runId,
      observationId: observation.id,
    });
    for (const evidenceId of evidenceRefs) {
      this.emit("evidence.created", {
        runId: this.state.runId,
        actionId: observation.actionId,
        evidenceId,
        evidenceRefs,
      });
    }
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

  private failMany(
    errors: readonly [RuntimeError, ...RuntimeError[]],
    code: RunFailureCode = failureCode(errors[0]),
  ): Promise<RunResult<TOutput>> {
    return this.terminalize({
      status: "failed",
      code,
      errors: Object.freeze([...errors]) as unknown as readonly [
        RuntimeError,
        ...RuntimeError[],
      ],
      cancellationRequest: this.cancellationRequest(),
    }, new Set(errors.map((error) => error.owner)));
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

  private createRetryEventSink(
    acceptance: RetryEventAcceptance,
  ): RetryEventSink {
    return Object.freeze({
      emit: (event: RetryEvent) => {
        if (this.acceptsRetryEvent(acceptance, event)) {
          this.commitRetryEvent(event);
        }
      },
    });
  }

  private acceptsRetryEvent(
    acceptance: RetryEventAcceptance,
    event: RetryEvent,
  ): boolean {
    if (acceptance.kind === "controller") {
      return this.activeOperation?.kind === "controller" &&
        this.state.status === "running";
    }
    const pending = this.state.permission.pendingApproval;
    return this.activeOperation?.kind === "approval_reviewer" &&
      this.state.status === "waiting_for_approval" &&
      pending?.phase === "reviewing" &&
      pending.request.id === acceptance.requestId &&
      pending.version === acceptance.pendingVersion &&
      pending.reviewOperationId === acceptance.operationId &&
      event.operationId === acceptance.operationId;
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
      this.publishPlanItem(item);
    }
  }

  private publishPlanItem(item: RunItem<TOutput>): void {
    switch (item.kind) {
      case "plan_created":
        this.emit("plan.created", {
          runId: item.runId,
          plan: item.plan,
        });
        return;
      case "plan_updated":
        this.emit("plan.updated", {
          runId: item.runId,
          plan: item.plan,
          previousVersion: item.previousVersion,
          transition: item.transition,
        });
        return;
      case "plan_completed":
        this.emit("plan.completed", {
          runId: item.runId,
          plan: item.plan,
        });
        return;
      case "plan_abandoned":
        this.emit("plan.abandoned", {
          runId: item.runId,
          plan: item.plan,
          terminalStatus: item.terminalStatus,
          reasonCode: item.reasonCode,
        });
        return;
      default:
        return;
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
    this.startActiveOperationSettlementTimer("run_cancellation");
  }

  private async awaitInterruptibleOperation<TValue>(
    kind: ActiveOperationKind,
    execute: () => Promise<TValue>,
    interruptionDeadlineAt: ISODateTimeString | null = null,
    allowInterruptedStart = false,
  ): Promise<TValue> {
    if (this.activeOperation !== null) {
      throw new Error(
        `Cannot start ${kind} while ${this.activeOperation.kind} is still active.`,
      );
    }
    if (!allowInterruptedStart && this.cancellationRequest() !== null) {
      this.observeCancellation();
      throw this.config.cancellation.context.signal.reason;
    }

    let rejectSettlement!: (error: OperationSettlementTimeoutError) => void;
    const settlementTimeout = new Promise<never>((_resolve, reject) => {
      rejectSettlement = reject;
    });
    const operationState: ActiveOperation = {
      kind,
      startedAt: this.now(),
      rejectSettlement,
      interruptionTimer: null,
      settlementTimer: null,
    };
    this.activeOperation = operationState;
    if (allowInterruptedStart && this.cancellationRequest() !== null) {
      this.observeCancellation();
    }
    if (interruptionDeadlineAt !== null) {
      const delayMs = Math.max(0, Date.parse(interruptionDeadlineAt) - Date.parse(this.now()));
      operationState.interruptionTimer = setTimeout(
        () => this.startActiveOperationSettlementTimer("operation_deadline"),
        delayMs,
      );
    }

    const operation = Promise.resolve().then(() => {
      if (!allowInterruptedStart && this.cancellationRequest() !== null) {
        this.observeCancellation();
        throw this.config.cancellation.context.signal.reason;
      }
      return execute();
    });

    try {
      return await Promise.race([operation, settlementTimeout]);
    } finally {
      if (this.activeOperation === operationState) {
        this.clearActiveOperation();
      }
    }
  }

  private startActiveOperationSettlementTimer(
    cause: "run_cancellation" | "operation_deadline",
  ): void {
    const operation = this.activeOperation;
    if (operation === null || operation.settlementTimer !== null) {
      return;
    }
    const timeoutMs = this.config.cancellationLimits.operationSettlementTimeoutMs;
    operation.settlementTimer = setTimeout(() => {
      operation.rejectSettlement(new OperationSettlementTimeoutError(
        operation.kind,
        cause,
        operation.startedAt,
        timeoutMs,
      ));
    }, timeoutMs);
  }

  private clearActiveOperation(): void {
    if (this.activeOperation?.interruptionTimer !== null &&
        this.activeOperation?.interruptionTimer !== undefined) {
      clearTimeout(this.activeOperation.interruptionTimer);
    }
    if (this.activeOperation?.settlementTimer !== null &&
        this.activeOperation?.settlementTimer !== undefined) {
      clearTimeout(this.activeOperation.settlementTimer);
    }
    this.activeOperation = null;
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

function authorityCommitFailureCode(
  owner: AuthorityCommitOwner,
  unconfirmed: boolean,
): RunFailureCode {
  if (owner === "permission") {
    return unconfirmed
      ? "session_authority_commit_unconfirmed"
      : "session_authority_commit_failed";
  }
  return unconfirmed
    ? "policy_amendment_commit_unconfirmed"
    : "policy_amendment_commit_failed";
}

function authorityInterruptionCode(owner: AuthorityCommitOwner): string {
  return owner === "permission"
    ? "session_authority_commit_interrupted"
    : "policy_amendment_commit_interrupted";
}

function authorityCommitRuntimeError(
  result: Extract<AuthorityCommitExecutionResult, { readonly kind: "outcome_unknown" }>,
): RuntimeError {
  return runtimeError(
    result.owner,
    result.code,
    result.message,
    false,
    { commitId: result.commitId, deadlineAt: result.deadlineAt },
  );
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

function observationNotificationOutcome(
  observation: Observation,
): { readonly status: string; readonly code: string | null } {
  switch (observation.kind) {
    case "tool_result":
      return {
        status: observation.result.status,
        code: observation.result.error?.code ?? null,
      };
    case "action_denied":
      return { status: "denied", code: observation.code };
    case "action_failure":
      return { status: "failed", code: observation.error.code };
    case "action_rejected":
      return { status: "rejected", code: observation.code };
    case "approval_declined":
      return { status: "declined", code: null };
    case "approval_policy_rejected":
    case "approval_review_failed":
    case "approval_application_failed":
      return { status: "failed", code: observation.code };
    case "approval_limit_reached":
      return { status: "limit_reached", code: observation.limit };
    case "permissions_granted":
      return { status: "granted", code: null };
    case "plan_update":
      return { status: "updated", code: null };
  }
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
  error: OperationSettlementTimeoutError,
): RuntimeError {
  return runtimeError(
    "runtime",
    "runtime_cancellation_settlement_timeout",
    error.message,
    false,
    {
      operation: error.operation,
      operationStartedAt: error.startedAt,
      settlementTimeoutMs: error.timeoutMs,
    },
  );
}

function approvalSettlementRuntimeError(
  error: OperationSettlementTimeoutError,
): RuntimeError {
  return runtimeError(
    "approval",
    "approval_cancellation_unconfirmed",
    error.message,
    false,
    {
      operation: error.operation,
      operationStartedAt: error.startedAt,
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

function sandboxAttemptSummary(attempt: SandboxAttempt): SandboxAttemptSummary {
  return Object.freeze({
    attemptId: attempt.id,
    actionId: attempt.actionId,
    actionFingerprint: attempt.actionFingerprint,
    ordinal: attempt.ordinal,
    enforcement: attempt.enforcement,
    policyId: attempt.policyId,
    authoritySnapshotId: attempt.authoritySnapshotId,
    dispatchPlanFingerprint: attempt.dispatchPlanFingerprint,
    startedAt: attempt.startedAt,
  });
}

function sandboxAttemptResolution(
  attempt: SandboxAttempt,
  execution: ActionExecutionResult,
  settledAt: ISODateTimeString,
): SandboxAttemptResolutionSummary {
  switch (execution.status) {
    case "executed":
      return Object.freeze({
        attemptId: attempt.id,
        actionId: attempt.actionId,
        ordinal: attempt.ordinal,
        enforcement: attempt.enforcement,
        outcome: execution.status,
        code: execution.toolResult.error?.code ?? execution.toolResult.status,
        effectState: null,
        settledAt,
      });
    case "sandbox_denied":
      return Object.freeze({
        attemptId: attempt.id,
        actionId: attempt.actionId,
        ordinal: attempt.ordinal,
        enforcement: attempt.enforcement,
        outcome: execution.status,
        code: execution.denial.code,
        effectState: execution.denial.effectState,
        settledAt,
      });
    case "sandbox_unavailable":
      return Object.freeze({
        attemptId: attempt.id,
        actionId: attempt.actionId,
        ordinal: attempt.ordinal,
        enforcement: attempt.enforcement,
        outcome: execution.status,
        code: execution.code,
        effectState: execution.effectState,
        settledAt,
      });
    case "interrupted":
      return Object.freeze({
        attemptId: attempt.id,
        actionId: attempt.actionId,
        ordinal: attempt.ordinal,
        enforcement: attempt.enforcement,
        outcome: execution.status,
        code: execution.interruption.kind,
        effectState: null,
        settledAt,
      });
    case "failed":
      return Object.freeze({
        attemptId: attempt.id,
        actionId: attempt.actionId,
        ordinal: attempt.ordinal,
        enforcement: attempt.enforcement,
        outcome: execution.status,
        code: execution.error.code,
        effectState: null,
        settledAt,
      });
  }
}

function infrastructureFailureCode(error: RuntimeError): RunFailureCode {
  return error.owner === "audit"
    ? "audit_required_failed"
    : error.owner === "telemetry"
    ? "runtime_telemetry_required_failed"
    : failureCode(error);
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
