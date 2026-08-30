import type { InvocationInterruptionContext } from "@agent-anything/agent-core/control";
import type { ResolvedOperationBinding } from "@agent-anything/operation-catalog/binding";
import type {
  ActionPolicyAssessment,
  ActionPolicyContext,
  ActionPolicyPort,
} from "@agent-anything/governance/policy";
import type {
  ActionPermissionAssessment,
  ActionPermissionContext,
  ActionPermissionAssessmentPort,
} from "@agent-anything/permission/authority";
import { sealApprovalRequirement } from "@agent-anything/permission/approval";
import type {
  ActionRegistrationSnapshot,
  CanonicalEffectFamily,
} from "@agent-anything/canonical-action/registration";
import type {
  CanonicalActorIdentity,
  CanonicalActionRef,
  CanonicalActionSubjectRevision,
  CanonicalEnvironmentIdentity,
  CanonicalWorkspaceIdentity,
} from "@agent-anything/canonical-action/subject";
import type {
  CanonicalActionSettlement,
  CanonicalActionSettlementStatus,
  ActionReplayBasis,
} from "@agent-anything/canonical-action/settlement";
import type { RunActionRef } from "@agent-anything/agent-core/run-action";
import {
  CanonicalActionLedger,
} from "../coordination/CanonicalActionLedger.js";
import type {
  ActionAdapterImplementation,
  ActionSemanticResult,
  PreparedAction,
} from "../registration/ActionAdapter.js";
import {
  createActionAdapterImplementationSnapshot,
} from "../registration/ActionAdapter.js";
import type {
  SandboxEnforcement,
  SandboxExecutionGateway,
  SandboxExecutionResult,
  SandboxPolicyEnvelope,
} from "../sandbox/SandboxContracts.js";

export interface ActionApprovalResolutionPort {
  resolve(input: {
    readonly action: CanonicalActionRef;
    readonly parentRunAction: RunActionRef | null;
    readonly subject: CanonicalActionSubjectRevision;
    readonly assessment: Extract<
      ActionPermissionAssessment,
      { readonly status: "approval_required" }
    >;
    readonly interruption: InvocationInterruptionContext;
  }): Promise<
    | {
        readonly status: "applied";
        readonly approvalRecordId: string;
        readonly authoritySnapshotId: string;
      }
    | {
        readonly status: "denied" | "cancelled" | "expired" | "invalidated" | "limit_exceeded";
        readonly code: string;
      }
    | { readonly status: "failed" | "interrupted" | "unknown_effect"; readonly code: string }
  >;
}

export interface ActionRecordPort {
  recordPreEffect(input: {
    readonly subject: CanonicalActionSubjectRevision;
    readonly policy: ActionPolicyAssessment;
    readonly permission: ActionPermissionAssessment;
    readonly dispatchPlanFingerprint: string;
    readonly recordedAt: string;
  }): Promise<{ readonly recordId: string }>;
  recordPostEffect(input: {
    readonly settlement: CanonicalActionSettlement;
    readonly sandbox: SandboxExecutionResult | null;
  }): Promise<{ readonly recordId: string }>;
}

export type ActionRetryDecision =
  | { readonly status: "stop"; readonly code: string }
  | {
      readonly status: "retry";
      readonly replayBasis: ActionReplayBasis;
      readonly delayMs: number;
      readonly decisionRecordId: string;
    };

export interface ActionRetryDecisionPort {
  decide(input: {
    readonly subject: CanonicalActionSubjectRevision;
    readonly attempt: import("@agent-anything/canonical-action/subject").ActionAttemptRef;
    readonly result: SandboxExecutionResult;
    readonly remainingAttempts: number;
  }): Promise<ActionRetryDecision>;
  wait(input: {
    readonly delayMs: number;
    readonly interruption: InvocationInterruptionContext;
  }): Promise<"elapsed" | "interrupted">;
}

export interface ActionExecutionRequest<TRequest = unknown> {
  readonly action: CanonicalActionRef;
  readonly parentRunAction: RunActionRef | null;
  readonly runId: string;
  readonly binding: ResolvedOperationBinding<TRequest> & {
    readonly kind: "direct" | "hosted";
  };
  readonly securityContext: {
    readonly workspace: CanonicalWorkspaceIdentity | null;
    readonly actor: CanonicalActorIdentity;
    readonly environment: CanonicalEnvironmentIdentity;
  };
  readonly policyContext: ActionPolicyContext;
  readonly permissionContext: () => ActionPermissionContext;
  readonly enforcement: SandboxEnforcement;
  readonly interruption: InvocationInterruptionContext;
  readonly deadlineAt: string;
  readonly maxAttempts: number;
  readonly isProgressionBasisCurrent: () => boolean;
  readonly authority: {
    readonly captureBasis: () => CapturedActionAuthorityBasis;
    readonly isBasisCurrent: (basis: CapturedActionAuthorityBasis) => boolean;
  };
}

interface CapturedActionAuthorityBasis {
  readonly authorityRevision: string;
  readonly resourceRevision: number;
}

export type ActionExecutionResult<TOutput = unknown> =
  | {
      readonly status: "settled";
      readonly settlement: CanonicalActionSettlement;
      readonly semanticResult: ActionSemanticResult<TOutput>;
    }
  | {
      readonly status: "pending_interaction";
      readonly action: CanonicalActionRef;
      readonly subject: CanonicalActionSubjectRevision;
      readonly assessment: Extract<
        ActionPermissionAssessment,
        { readonly status: "approval_required" }
      >;
    };

export interface ActionExecutionCoordinatorDependencies {
  readonly registrations: ActionRegistrationSnapshot;
  readonly adapters: readonly ActionAdapterImplementation[];
  readonly policy: ActionPolicyPort;
  readonly permission: ActionPermissionAssessmentPort;
  readonly approval: ActionApprovalResolutionPort | null;
  readonly sandbox: SandboxExecutionGateway;
  readonly records: ActionRecordPort;
  readonly retry: ActionRetryDecisionPort;
  readonly observer?: ActionExecutionObserver;
  readonly now?: () => string;
  readonly createId?: (kind: string) => string;
}

export type ActionExecutionNotification =
  | {
      readonly kind: "attempt_started";
      readonly runId: string;
      readonly actionId: string;
      readonly attemptId: string;
      readonly ordinal: number;
      readonly enforcement: SandboxEnforcement;
      readonly occurredAt: string;
    }
  | {
      readonly kind: "settled";
      readonly runId: string;
      readonly actionId: string;
      readonly settlementId: string;
      readonly status: CanonicalActionSettlementStatus;
      readonly attemptCount: number;
      readonly enforcement: SandboxEnforcement;
      readonly causeOwner: string | null;
      readonly causeRef: string | null;
      readonly occurredAt: string;
    };

export interface ActionExecutionObserver {
  observe(notification: ActionExecutionNotification): void | Promise<void>;
}

/** Invocation-local coordinator; CanonicalActionLedger remains the sole Action state writer. */
export class ActionExecutionCoordinator {
  private readonly adapters;
  private readonly now: () => string;
  private nextId = 1;

  constructor(private readonly dependencies: ActionExecutionCoordinatorDependencies) {
    this.adapters = createActionAdapterImplementationSnapshot(
      dependencies.registrations,
      dependencies.adapters,
    );
    this.now = dependencies.now ?? (() => new Date().toISOString());
  }

  async execute<TRequest, TOutput>(
    request: ActionExecutionRequest<TRequest>,
  ): Promise<ActionExecutionResult<TOutput>> {
    const ledger = new CanonicalActionLedger(request.action, request.parentRunAction);
    await ledger.transition({ expectedRevision: 0, kind: "begin_preparation" });
    const captured = this.adapters.find(request.binding.actionAdapterId);
    if (captured === undefined || !bindingMatches(captured.registration, request.binding)) {
      return this.settleWithoutSubject<TOutput>(
        ledger,
        request,
        "invalid",
        "action-execution",
        "action_adapter_unavailable",
      );
    }

    const preparedResult = await captured.adapter.prepare(request.binding, {
      action: request.action,
      parentRunAction: request.parentRunAction,
      subjectRevision: 1,
      registration: captured.registration,
      workspace: request.securityContext.workspace,
      actor: request.securityContext.actor,
      environment: request.securityContext.environment,
      interruption: request.interruption,
      now: this.now,
    });
    if (preparedResult.status !== "prepared") {
      return this.settleWithoutSubject<TOutput>(
        ledger,
        request,
        preparationStatus(preparedResult.status),
        preparedResult.owner,
        preparedResult.code,
      );
    }
    const prepared = preparedResult.prepared;
    assertPreparedCoherence(request, captured.registration, prepared);
    const fingerprint = await actionFingerprint(prepared.subject);
    const requirement = prepared.approval === null
      ? null
      : sealApprovalRequirement({
          draft: prepared.approval,
          runId: request.runId,
          actionId: request.action.id,
          actionFingerprint: fingerprint,
          sealedAt: this.now(),
        });
    await ledger.transition({
      expectedRevision: ledger.getSnapshot().revision,
      kind: "record_subject",
      subject: prepared.subject,
    });
    await ledger.transition({
      expectedRevision: ledger.getSnapshot().revision,
      kind: "begin_assessment",
    });

    const policy = await this.dependencies.policy.evaluate({
      checkId: this.id("policy"),
      subject: prepared.subject,
      context: request.policyContext,
    });
    if (policy.status === "denied" || policy.status === "failed" || policy.status === "interrupted") {
      return this.settlePrepared<TOutput>(
        ledger,
        request,
        captured.adapter,
        prepared,
        policy.status === "denied" ? "denied" : policy.status === "interrupted" ? "cancelled" : "failed",
        policy.owner,
        policy.code ?? policy.checkId,
      );
    }

    const reviewCauses = policy.status === "review_required"
      ? Object.freeze(["governance_review" as const])
      : Object.freeze([]);
    let permission = await this.dependencies.permission.assess({
      assessmentId: this.id("permission"),
      actionFingerprint: fingerprint,
      subject: prepared.subject,
      requirement,
      reviewCauses,
      context: request.permissionContext(),
      interruption: request.interruption,
    });
    if (permission.status === "approval_required") {
      if (this.dependencies.approval === null) {
        await ledger.transition({
          expectedRevision: ledger.getSnapshot().revision,
          kind: "await_approval",
        });
        return Object.freeze({
          status: "pending_interaction" as const,
          action: request.action,
          subject: prepared.subject,
          assessment: permission,
        });
      }
      await ledger.transition({
        expectedRevision: ledger.getSnapshot().revision,
        kind: "await_approval",
      });
      const approval = await this.dependencies.approval.resolve({
        action: request.action,
        parentRunAction: request.parentRunAction,
        subject: prepared.subject,
        assessment: permission,
        interruption: request.interruption,
      });
      if (approval.status !== "applied") {
        return this.settlePrepared<TOutput>(
          ledger,
          request,
          captured.adapter,
          prepared,
          approval.status === "denied"
            ? "denied"
            : approval.status === "cancelled" || approval.status === "interrupted"
              ? "cancelled"
              : approval.status === "invalidated" || approval.status === "expired"
                ? "invalidated"
                : approval.status === "unknown_effect"
                  ? "unknown_effect"
                  : "failed",
          approval.status === "limit_exceeded" ? "agent-runtime" : "permission",
          approval.code,
        );
      }
      await ledger.transition({
        expectedRevision: ledger.getSnapshot().revision,
        kind: "begin_assessment",
      });
      permission = await this.dependencies.permission.assess({
        assessmentId: this.id("permission-reassessment"),
        actionFingerprint: fingerprint,
        subject: prepared.subject,
        requirement,
        reviewCauses,
        context: request.permissionContext(),
        interruption: request.interruption,
      });
    }
    if (permission.status !== "authorized") {
      const permissionCode = permission.status === "approval_required"
        ? "permission_reassessment_not_authorized"
        : permission.code;
      return this.settlePrepared<TOutput>(
        ledger,
        request,
        captured.adapter,
        prepared,
        permission.status === "denied" ? "denied" : permission.status === "interrupted" ? "cancelled" : "failed",
        permission.owner,
        permissionCode,
      );
    }
    let authorityBasis: CapturedActionAuthorityBasis = request.authority.captureBasis();

    if (!request.isProgressionBasisCurrent()) {
      return this.settlePrepared<TOutput>(
        ledger,
        request,
        captured.adapter,
        prepared,
        "invalidated",
        "agent-runtime",
        "action_progression_basis_invalidated",
      );
    }
    if (!request.authority.isBasisCurrent(authorityBasis)) {
      return this.settlePrepared<TOutput>(
        ledger,
        request,
        captured.adapter,
        prepared,
        "invalidated",
        "agent-runtime",
        "action_authority_basis_stale",
      );
    }

    await ledger.transition({
      expectedRevision: ledger.getSnapshot().revision,
      kind: "mark_ready",
    });
    await ledger.transition({
      expectedRevision: ledger.getSnapshot().revision,
      kind: "begin_revalidation",
    });
    const revalidation = await captured.adapter.revalidate(
      prepared,
      prepared.assertions,
      {
        action: request.action,
        parentRunAction: request.parentRunAction,
        subjectRevision: prepared.subject.ref.revision,
        registration: captured.registration,
        workspace: request.securityContext.workspace,
        actor: request.securityContext.actor,
        environment: request.securityContext.environment,
        interruption: request.interruption,
        now: this.now,
      },
    );
    if (revalidation.status !== "valid") {
      return this.settlePrepared<TOutput>(
        ledger,
        request,
        captured.adapter,
        prepared,
        revalidation.status === "invalidated" ? "invalidated" : revalidation.status === "interrupted" ? "cancelled" : "failed",
        revalidation.owner,
        revalidation.code,
      );
    }

    if (!request.isProgressionBasisCurrent()) {
      return this.settlePrepared<TOutput>(
        ledger,
        request,
        captured.adapter,
        prepared,
        "invalidated",
        "agent-runtime",
        "action_progression_basis_invalidated",
      );
    }
    if (!request.authority.isBasisCurrent(authorityBasis)) {
      return this.settlePrepared<TOutput>(
        ledger,
        request,
        captured.adapter,
        prepared,
        "invalidated",
        "agent-runtime",
        "action_authority_basis_stale",
      );
    }

    if (permission.actionCoverageId !== null) {
      const consumption = await this.dependencies.permission.consumeActionCoverage({
        coverageId: permission.actionCoverageId,
        actionFingerprint: fingerprint,
        subject: prepared.subject,
        context: request.permissionContext(),
        interruption: request.interruption,
      });
      if (consumption.status !== "consumed") {
        return this.settlePrepared<TOutput>(
          ledger,
          request,
          captured.adapter,
          prepared,
          consumption.status === "interrupted" ? "cancelled" : "invalidated",
          "permission",
          consumption.code,
        );
      }
      // Consuming exact single-Action coverage is an intentional restrictive
      // authority transition. Capture the resulting current basis rather than
      // invalidating the Action because of its own successful consumption.
      authorityBasis = request.authority.captureBasis();
    }

    const dispatchPlanFingerprint = this.id("dispatch-plan");
    await this.dependencies.records.recordPreEffect({
      subject: prepared.subject,
      policy,
      permission,
      dispatchPlanFingerprint,
      recordedAt: this.now(),
    });
    if (!Number.isSafeInteger(request.maxAttempts) || request.maxAttempts < 1) {
      throw new TypeError("Action execution maxAttempts must be a positive integer.");
    }
    let sandbox: SandboxExecutionResult;
    let activeDispatchPlanFingerprint = dispatchPlanFingerprint;
    while (true) {
      await ledger.claimDispatch({
        expectedRevision: ledger.getSnapshot().revision,
        claimId: this.id("dispatch-claim"),
        attemptId: this.id("attempt"),
        planFingerprint: activeDispatchPlanFingerprint,
        claimedAt: this.now(),
      });
      const attempt = ledger.getSnapshot().activeDispatchClaim!.attempt;
      const sandboxAttempt = Object.freeze({
        ...attempt,
        runId: request.runId,
        actionFingerprint: fingerprint,
        enforcement: request.enforcement,
        policyId: request.policyContext.policySnapshotId,
        authoritySnapshotId: permission.revision,
        dispatchPlanFingerprint: activeDispatchPlanFingerprint,
        actionRegistrationFingerprint: captured.registration.registrationFingerprint,
        startedAt: this.now(),
      });
      this.notify(Object.freeze({
        kind: "attempt_started" as const,
        runId: request.runId,
        actionId: request.action.id,
        attemptId: attempt.id,
        ordinal: attempt.ordinal,
        enforcement: request.enforcement,
        occurredAt: sandboxAttempt.startedAt,
      }));
      const sandboxPolicy: SandboxPolicyEnvelope = Object.freeze({
        schemaVersion: 1 as const,
        policyId: request.policyContext.policySnapshotId,
        actionFingerprint: sandboxAttempt.actionFingerprint,
        authoritySnapshotId: permission.revision,
        enforcement: request.enforcement,
        defaultDisposition: "deny" as const,
        effectFamilies: captured.registration.effectFamilies,
        resourceLimits: Object.freeze({
          maxResultBytes: captured.registration.maxPhysicalResultBytes,
        }),
        allowedSecretReferences: prepared.invocation.secretReferences,
      });
      if (!request.isProgressionBasisCurrent()) {
        return this.settlePrepared<TOutput>(
          ledger,
          request,
          captured.adapter,
          prepared,
          "invalidated",
          "agent-runtime",
          "action_progression_basis_invalidated",
        );
      }
      if (!request.authority.isBasisCurrent(authorityBasis)) {
        return this.settlePrepared<TOutput>(
          ledger,
          request,
          captured.adapter,
          prepared,
          "invalidated",
          "agent-runtime",
          "action_authority_basis_stale",
        );
      }
      sandbox = await this.dependencies.sandbox.execute({
        attempt: sandboxAttempt,
        policy: sandboxPolicy,
        executor: captured.registration.executor,
        actionRegistrationFingerprint: captured.registration.registrationFingerprint,
        invocation: prepared.invocation,
        deadlineAt: request.deadlineAt,
        interruption: request.interruption,
      });
      const remainingAttempts = request.maxAttempts - attempt.ordinal;
      if (remainingAttempts < 1 || !canConsiderRetry(sandbox)) break;
      const decision = await this.dependencies.retry.decide({
        subject: prepared.subject,
        attempt,
        result: sandbox,
        remainingAttempts,
      });
      if (decision.status !== "retry") break;
      assertReplayBasis(prepared.subject, decision.replayBasis);
      if (!Number.isSafeInteger(decision.delayMs) || decision.delayMs < 0) {
        throw new TypeError("Action Retry delay must be a non-negative integer.");
      }
      await ledger.transition({
        expectedRevision: ledger.getSnapshot().revision,
        kind: "begin_retry_delay",
      });
      const wait = await this.dependencies.retry.wait({
        delayMs: decision.delayMs,
        interruption: request.interruption,
      });
      if (wait === "interrupted" || request.interruption.signal.aborted) {
        return this.settlePrepared<TOutput>(
          ledger,
          request,
          captured.adapter,
          prepared,
          "cancelled",
          "action-execution",
          "action_retry_interrupted",
        );
      }
      await ledger.transition({
        expectedRevision: ledger.getSnapshot().revision,
        kind: "begin_revalidation",
      });
      const retryRevalidation = await captured.adapter.revalidate(prepared, prepared.assertions, {
        action: request.action,
        parentRunAction: request.parentRunAction,
        subjectRevision: prepared.subject.ref.revision,
        registration: captured.registration,
        workspace: request.securityContext.workspace,
        actor: request.securityContext.actor,
        environment: request.securityContext.environment,
        interruption: request.interruption,
        now: this.now,
      });
      if (retryRevalidation.status !== "valid") {
        return this.settlePrepared<TOutput>(
          ledger,
          request,
          captured.adapter,
          prepared,
          retryRevalidation.status === "invalidated" ? "invalidated" : retryRevalidation.status === "interrupted" ? "cancelled" : "failed",
          retryRevalidation.owner,
          retryRevalidation.code,
        );
      }
      activeDispatchPlanFingerprint = `${decision.decisionRecordId}:${this.id("dispatch-plan")}`;
      await this.dependencies.records.recordPreEffect({
        subject: prepared.subject,
        policy,
        permission,
        dispatchPlanFingerprint: activeDispatchPlanFingerprint,
        recordedAt: this.now(),
      });
    }
    const settlement = settlementFromPhysical(
      request,
      prepared,
      captured.registration.binding,
      ledger.getSnapshot().attempts,
      sandbox,
      this.id("settlement"),
      this.now(),
    );
    await ledger.settle({
      expectedRevision: ledger.getSnapshot().revision,
      settlement,
    });
    await this.dependencies.records.recordPostEffect({ settlement, sandbox });
    this.notifySettlement(request, settlement);
    const semanticResult = await captured.adapter.settle(prepared, settlement);
    return Object.freeze({ status: "settled" as const, settlement, semanticResult }) as ActionExecutionResult<TOutput>;
  }

  private async settleWithoutSubject<TOutput>(
    ledger: CanonicalActionLedger,
    request: ActionExecutionRequest,
    status: CanonicalActionSettlementStatus,
    owner: string,
    code: string,
  ): Promise<ActionExecutionResult<TOutput>> {
    const settlement = emptySettlement(
      request,
      status,
      owner,
      code,
      this.id("settlement"),
      this.now(),
    );
    await ledger.settle({ expectedRevision: ledger.getSnapshot().revision, settlement });
    await this.dependencies.records.recordPostEffect({ settlement, sandbox: null });
    this.notifySettlement(request, settlement);
    return Object.freeze({
      status: "settled" as const,
      settlement,
      semanticResult: semanticFailure(settlement, owner, code),
    }) as ActionExecutionResult<TOutput>;
  }

  private async settlePrepared<TOutput>(
    ledger: CanonicalActionLedger,
    request: ActionExecutionRequest,
    adapter: ActionAdapterImplementation["adapter"],
    prepared: PreparedAction,
    status: CanonicalActionSettlementStatus,
    owner: string,
    code: string,
  ): Promise<ActionExecutionResult<TOutput>> {
    const settlement = preparedSettlement(
      request,
      prepared,
      status,
      owner,
      code,
      this.id("settlement"),
      this.now(),
      ledger.getSnapshot().attempts,
    );
    await ledger.settle({ expectedRevision: ledger.getSnapshot().revision, settlement });
    await this.dependencies.records.recordPostEffect({ settlement, sandbox: null });
    this.notifySettlement(request, settlement);
    return Object.freeze({
      status: "settled" as const,
      settlement,
      semanticResult: await adapter.settle(prepared, settlement),
    }) as ActionExecutionResult<TOutput>;
  }

  private id(kind: string): string {
    return this.dependencies.createId?.(kind) ?? `${kind}:${this.nextId++}`;
  }

  private notifySettlement(
    request: ActionExecutionRequest,
    settlement: CanonicalActionSettlement,
  ): void {
    this.notify(Object.freeze({
      kind: "settled" as const,
      runId: request.runId,
      actionId: request.action.id,
      settlementId: settlement.ref.id,
      status: settlement.status,
      attemptCount: settlement.attempts.length,
      enforcement: request.enforcement,
      causeOwner: settlement.causeOwner,
      causeRef: settlement.causeRef,
      occurredAt: settlement.settledAt,
    }));
  }

  private notify(notification: ActionExecutionNotification): void {
    try {
      void Promise.resolve(this.dependencies.observer?.observe(notification)).catch(
        () => undefined,
      );
    } catch {
      // Observation is non-authoritative and cannot affect Action execution.
    }
  }
}

function canConsiderRetry(result: SandboxExecutionResult): boolean {
  if (result.status === "sandbox_unavailable") return result.effectState === "none";
  const outcome = result.outcome;
  return outcome.status === "failed" && outcome.effectState === "none" && outcome.failure.retryable;
}

function assertReplayBasis(
  subject: CanonicalActionSubjectRevision,
  basis: ActionReplayBasis,
): void {
  if (subject.replayBasis === "none" || subject.replayBasis !== basis.kind) {
    throw new TypeError("Action Retry decision does not match the admitted replay basis.");
  }
  if (basis.kind === "never_dispatched") {
    throw new TypeError("A dispatched Action cannot be retried as never_dispatched.");
  }
  const evidence = basis.kind === "confirmed_no_effect"
    ? basis.evidenceRef
    : basis.kind === "revalidated_observation"
      ? basis.observationRef
      : basis.idempotencyKey;
  if (typeof evidence !== "string" || evidence.trim().length === 0) {
    throw new TypeError("Action Retry requires a concrete replay-basis reference.");
  }
}

function assertPreparedCoherence(
  request: ActionExecutionRequest,
  registration: ActionRegistrationSnapshot["registrations"][number],
  prepared: PreparedAction,
): void {
  if (
    prepared.subject.ref.action.id !== request.action.id ||
    prepared.subject.operationInvocation.id !== request.binding.invocation.id ||
    prepared.subject.binding.revision !== request.binding.binding.revision ||
    prepared.subject.actor.identityId !== request.securityContext.actor.identityId ||
    prepared.subject.actor.kind !== request.securityContext.actor.kind ||
    prepared.subject.environment.environmentId !== request.securityContext.environment.environmentId ||
    prepared.subject.environment.platform !== request.securityContext.environment.platform ||
    prepared.subject.environment.configurationFingerprint !== request.securityContext.environment.configurationFingerprint ||
    (prepared.approval !== null &&
      prepared.approval.environmentId !== request.securityContext.environment.environmentId) ||
    prepared.invocation.executorId !== registration.executor.id ||
    prepared.invocation.executorVersion !== registration.executor.version ||
    prepared.invocation.contractVersion !== registration.executor.invocationContractVersion
  ) {
    throw new TypeError("Prepared canonical Action does not match its resolved Operation binding.");
  }
}

function bindingMatches(
  registration: ActionRegistrationSnapshot["registrations"][number],
  binding: ResolvedOperationBinding & { readonly kind: "direct" | "hosted" },
): boolean {
  return registration.adapter.id === binding.actionAdapterId &&
    registration.binding.revision === binding.binding.revision &&
    registration.operation.revision === binding.invocation.operation.revision &&
    registration.operation.operation.namespace === binding.invocation.operation.operation.namespace &&
    registration.operation.operation.name === binding.invocation.operation.operation.name;
}

function preparationStatus(
  input: "invalid" | "unavailable" | "failed" | "interrupted",
): CanonicalActionSettlementStatus {
  return input === "invalid" || input === "unavailable"
    ? "invalid"
    : input === "interrupted"
      ? "cancelled"
      : "failed";
}

function emptySettlement(
  request: ActionExecutionRequest,
  status: CanonicalActionSettlementStatus,
  owner: string,
  code: string,
  settlementId: string,
  settledAt: string,
): CanonicalActionSettlement {
  return Object.freeze({
    ref: Object.freeze({ action: request.action, id: settlementId }),
    action: request.action,
    subject: null,
    operationInvocation: request.binding.invocation,
    binding: request.binding.binding,
    status,
    attempts: Object.freeze([]),
    effectCertainty: "none" as const,
    completionExtent: "none" as const,
    payload: null,
    causeOwner: owner,
    causeRef: code,
    reconciliationRequired: false,
    settledAt,
  });
}

function preparedSettlement(
  request: ActionExecutionRequest,
  prepared: PreparedAction,
  status: CanonicalActionSettlementStatus,
  owner: string,
  code: string,
  settlementId: string,
  settledAt: string,
  attempts: readonly import("@agent-anything/canonical-action/subject").ActionAttemptRef[],
): CanonicalActionSettlement {
  return Object.freeze({
    ref: Object.freeze({ action: request.action, id: settlementId }),
    action: request.action,
    subject: prepared.subject.ref,
    operationInvocation: request.binding.invocation,
    binding: request.binding.binding,
    status,
    attempts: Object.freeze([...attempts]),
    effectCertainty: "none" as const,
    completionExtent: "none" as const,
    payload: null,
    causeOwner: owner,
    causeRef: code,
    reconciliationRequired: false,
    settledAt,
  });
}

function settlementFromPhysical(
  request: ActionExecutionRequest,
  prepared: PreparedAction,
  binding: import("@agent-anything/operation-catalog/identity").OperationBindingRevisionRef,
  attempts: readonly import("@agent-anything/canonical-action/subject").ActionAttemptRef[],
  result: SandboxExecutionResult,
  settlementId: string,
  settledAt: string,
): CanonicalActionSettlement {
  let status: CanonicalActionSettlementStatus;
  let effectCertainty: CanonicalActionSettlement["effectCertainty"];
  let completionExtent: CanonicalActionSettlement["completionExtent"];
  let payload: unknown = null;
  let causeOwner: string | null = null;
  let causeRef: string | null = null;
  if (result.status === "sandbox_unavailable") {
    status = result.effectState === "unknown" ? "unknown_effect" : "failed";
    effectCertainty = result.effectState === "unknown" ? "unknown" : "none";
    completionExtent = result.effectState === "unknown" ? "unknown" : "none";
    causeOwner = "sandbox";
    causeRef = result.code;
  } else {
    const outcome = result.outcome;
    if (outcome.status === "completed") {
      status = "succeeded";
      effectCertainty = outcome.effectState === "settled" ? "confirmed" : "none";
      completionExtent = "complete";
      payload = outcome.payload;
    } else if (outcome.status === "denied") {
      status = "denied";
      effectCertainty = "none";
      completionExtent = "none";
      causeOwner = "executor";
      causeRef = outcome.evidence.code;
    } else if (outcome.effectState === "unknown") {
      status = "unknown_effect";
      effectCertainty = "unknown";
      completionExtent = "unknown";
      causeOwner = "executor";
      causeRef = outcome.status === "failed" ? outcome.failure.code : outcome.evidence.code;
    } else {
      status = outcome.status === "interrupted" ? "cancelled" : outcome.status === "timed_out" ? "timed_out" : "failed";
      effectCertainty = outcome.effectState === "settled" ? "confirmed" : "none";
      completionExtent = outcome.effectState === "settled" ? "complete" : "none";
      causeOwner = "executor";
      causeRef = outcome.status === "failed" ? outcome.failure.code : outcome.evidence.code;
    }
  }
  return Object.freeze({
    ref: Object.freeze({ action: request.action, id: settlementId }),
    action: request.action,
    subject: prepared.subject.ref,
    operationInvocation: request.binding.invocation,
    binding,
    status,
    attempts: Object.freeze([...attempts]),
    effectCertainty,
    completionExtent,
    payload,
    causeOwner,
    causeRef,
    reconciliationRequired: status === "unknown_effect",
    settledAt,
  });
}

function semanticFailure(
  settlement: CanonicalActionSettlement,
  owner: string,
  code: string,
): ActionSemanticResult {
  return Object.freeze({
    operationInvocationId: settlement.operationInvocation.id,
    settlement,
    status: settlement.status === "timed_out" ? "timed_out" : settlement.status === "cancelled" ? "cancelled" : settlement.status === "denied" ? "denied" : settlement.status === "invalid" || settlement.status === "invalidated" ? "invalid" : settlement.status === "unknown_effect" ? "unknown_effect" : "failed",
    output: null,
    failure: Object.freeze({ owner, code, message: code }),
  });
}

async function actionFingerprint(subject: CanonicalActionSubjectRevision): Promise<string> {
  const { createCanonicalActionSubjectFingerprint } = await import(
    "@agent-anything/canonical-action/subject"
  );
  return createCanonicalActionSubjectFingerprint(subject);
}
