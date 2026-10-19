import type { InvocationInterruptionContext } from "@agent-anything/agent-core/control";
import { ExecutionFlowPath, type ExecutionFlowContext } from "@agent-anything/observability/execution-flow";
import { ACTION_EXECUTION_FLOW } from "./ActionExecutionFlow.js";
import type { ResolvedOperationBinding } from "@agent-anything/operation-catalog/binding";
import { readOperationLimitFailureDetail, type OperationLimitFailureDetail } from "@agent-anything/operation-catalog/result";
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
import { ActionRecordCommitError, ActionRecoveryError, type ActionRetryRecord, type ActionRecordPort, type ActionRecordReceipt,
  type ActionRecoveryRecordPort, type ActionAttemptReconciliationPort } from "./ActionRecordPort.js";
export type { ActionRecordPort } from "./ActionRecordPort.js";

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
        readonly status: "denied" | "cancelled" | "expired" | "invalidated";
        readonly code: string;
      }
    | { readonly status: "limit_exceeded"; readonly code: string; readonly detail: OperationLimitFailureDetail }
    | { readonly status: "failed" | "interrupted" | "unknown_effect"; readonly code: string }
  >;
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
  readonly executionFlow?: ExecutionFlowContext;
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

export type ActionRecoveryResult<TOutput = unknown> =
  | ActionExecutionResult<TOutput>
  | {readonly status: "no_dispatch_record"; readonly prepared: PreparedAction | null};

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
  /** Must allocate unused identities across owner restarts, not reset a local counter. */
  readonly createId?: (kind: string) => string;
}

export type ActionExecutionNotification =
  | {
      readonly kind: "prepared";
      readonly runId: string;
      readonly actionId: string;
      readonly parentRunAction: RunActionRef | null;
      readonly subject: CanonicalActionSubjectRevision;
      readonly occurredAt: string | null;
    }
  | {
      readonly kind: "assessment";
      readonly runId: string;
      readonly actionId: string;
      readonly policyStatus: ActionPolicyAssessment["status"];
      readonly permissionStatus: ActionPermissionAssessment["status"] | null;
      readonly policy: ActionPolicyAssessment;
      readonly permission: ActionPermissionAssessment | null;
      readonly occurredAt: string | null;
    }
  | {
      readonly kind: "attempt_settled";
      readonly runId: string;
      readonly actionId: string;
      readonly attemptId: string;
      readonly result: SandboxExecutionResult;
      readonly occurredAt: string | null;
    }
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

  constructor(private readonly dependencies: ActionExecutionCoordinatorDependencies) {
    this.adapters = createActionAdapterImplementationSnapshot(
      dependencies.registrations,
      dependencies.adapters,
    );
    this.now = dependencies.now ?? (() => new Date().toISOString());
  }

  /** Reconcile before continuing; a new Attempt requires its own retained retry admission. */
  async recover<TRequest, TOutput>(request: ActionExecutionRequest<TRequest>, recovery: {
    readonly records: ActionRecoveryRecordPort;
    readonly attempts: ActionAttemptReconciliationPort | null;
  }): Promise<ActionRecoveryResult<TOutput>> {
    const flow = new ExecutionFlowPath(ACTION_EXECUTION_FLOW, request.executionFlow ?? {}, request.runId,
      [{owner: "action-execution", kind: "action", id: request.action.id, revision: null}]);
    const step = flow.advance("recover", {actionId: request.action.id});
    const reject = (code: string): never => {throw new ActionRecoveryError(request.action.id, code);};
    try {
      const records = structuredClone(await recovery.records.readAction({runId: request.runId, action: request.action}));
      const captured = this.adapters.find(request.binding.actionAdapterId);
      const unpreparedFailure = records.settlement?.prepared === null &&
        records.preparedAction === null && records.preparations.length === 0 && records.attempts.length === 0;
      if ((!captured || !bindingMatches(captured.registration, request.binding)) &&
          !unpreparedFailure) reject("action_recovery_binding_unavailable");
      const adapter = captured!;
      const preparations = new Map(records.preparations.map(entry => [entry.recordId, entry.value]));
      if (preparations.size !== records.preparations.length) reject("action_recovery_records_invalid");
      for (const preparation of [...preparations.values(), ...(records.preparedAction ? [records.preparedAction] : [])]) {
        if (preparation.runId !== request.runId ||
            preparation.limits.maxAttempts !== request.maxAttempts || preparation.limits.deadlineAt !== request.deadlineAt ||
            !sameRetainedValue(preparation.binding, request.binding) ||
            !sameRetainedValue(preparation.registration, adapter.registration)) reject("action_recovery_binding_changed");
        assertPreparedCoherence(request, adapter.registration, preparation.prepared);
        if (records.preparedAction && !sameRetainedValue(preparation.prepared, records.preparedAction.prepared)) {
          reject("action_recovery_preparation_changed");
        }
      }
      const attemptIds = new Set<string>();
      for (const [index, attempt] of records.attempts.entries()) {
        const preparation = preparations.get(attempt.intent.preparationRecordId);
        const dispatch = attempt.intent.request;
        if (!preparation || dispatch.attempt.runId !== request.runId ||
            dispatch.attempt.action.id !== request.action.id || dispatch.attempt.ordinal !== index + 1 ||
            attemptIds.has(dispatch.attempt.id) ||
            !sameRetainedValue(dispatch.invocation, preparation.prepared.invocation) ||
            dispatch.actionRegistrationFingerprint !== adapter.registration.registrationFingerprint ||
            (attempt.result !== null && (attempt.result.intentRecordId !== attempt.recordId ||
              !sameRetainedValue(attempt.result.result.attempt, dispatch.attempt))) ||
            (index < records.attempts.length - 1 && attempt.result === null)) reject("action_recovery_records_invalid");
        attemptIds.add(dispatch.attempt.id);
        const ledger = CanonicalActionLedger.restoreDispatch(attempt.intent.ledger);
        if (!sameRetainedValue(ledger.getSnapshot().attempts, records.attempts.slice(0, index + 1).map(entry => ({
          id: entry.intent.request.attempt.id, action: entry.intent.request.attempt.action, ordinal: entry.intent.request.attempt.ordinal,
        }))) || !sameRetainedValue(ledger.getSnapshot().subjects.at(-1), preparation!.prepared.subject) ||
            !sameRetainedValue(ledger.getSnapshot().parentRunAction, request.parentRunAction)) reject("action_recovery_records_invalid");
        if (attempt.retry !== null) {
          if (!attempt.result || !canConsiderRetry(attempt.result.result)) reject("action_recovery_retry_invalid");
          this.validateRetryRecord(request, attempt.retry, attempt.recordId, dispatch.attempt, preparation!.prepared);
        }
        if (index < records.attempts.length - 1 && attempt.retry?.decision.status !== "retry") reject("action_recovery_retry_missing");
      }
      step.check("records", "passed", {preparations: preparations.size, attempts: records.attempts.length});
      const saved = records.settlement;
      if (saved !== null) {
        if (saved.runId !== request.runId || !sameRetainedValue(saved.binding, request.binding) ||
            !sameRetainedValue(saved.settlement.action, request.action) ||
            !sameRetainedValue(saved.settlement.operationInvocation, request.binding.invocation) ||
            !sameRetainedValue(saved.settlement.binding, request.binding.binding)) reject("action_recovery_settlement_invalid");
        if (saved.prepared !== null) assertPreparedCoherence(request, adapter.registration, saved.prepared);
        step.check("reconciliation", "not_applicable", {reason: "settlement_retained"});
        const semanticResult = saved.prepared === null
          ? semanticFailure(saved.settlement, saved.preparationFailure?.owner ?? reject("action_recovery_failure_missing"),
            saved.preparationFailure!.code, saved.preparationFailure!.message)
          : await adapter.adapter.settle(saved.prepared, saved.settlement);
        flow.advance("settlement", {reused: true, settlementId: saved.settlement.ref.id});
        flow.close("returned");
        return {status: "settled", settlement: saved.settlement, semanticResult} as ActionRecoveryResult<TOutput>;
      }
      const last = records.attempts.at(-1);
      if (!last) {
        const prepared = records.preparedAction?.prepared ?? records.preparations.at(-1)?.value.prepared;
        if (prepared) {
          step.check("reconciliation", "passed", {reason: "prepared_subject_retained"});
          const ledger = new CanonicalActionLedger(request.action, request.parentRunAction);
          await ledger.transition({expectedRevision: 0, kind: "begin_preparation"});
          await ledger.transition({expectedRevision: ledger.getSnapshot().revision, kind: "record_subject", subject: prepared.subject});
          const result = await this.executeWithFlow<TRequest, TOutput>(request, flow, {ledger, prepared});
          if (result.status === "settled") flow.advance("settlement", {status: result.settlement.status});
          flow.close(result.status === "pending_interaction" ? "yielded" : "returned");
          return result;
        }
        step.check("reconciliation", "not_applicable", {reason: "no_dispatch_record"});
        flow.close("yielded");
        // The caller still needs a complete mandatory dispatch path before authorizing execution.
        return {status: "no_dispatch_record", prepared: records.preparations.at(-1)?.value.prepared ?? null};
      }
      const preparation = preparations.get(last.intent.preparationRecordId)!;
      let sandbox = last.result?.result;
      let reconciliation: import("./ActionRecordPort.js").ActionSettlementRecord["reconciliation"];
      const attempts = records.attempts.map(attempt => ({id: attempt.intent.request.attempt.id,
        action: attempt.intent.request.attempt.action, ordinal: attempt.intent.request.attempt.ordinal}));
      if (!sandbox) {
        const finding = recovery.attempts === null ? {status: "unknown" as const,
          code: "action_interrupted_outcome_unknown", evidenceRefs: []} : await recovery.attempts.reconcile({
            intent: last.intent, preparation});
        reconciliation = {intentRecordId: last.recordId, status: finding.status,
          evidenceRefs: finding.evidenceRefs, code: finding.status === "unknown" ? finding.code : null};
        step.check("reconciliation", finding.status === "settled" ? "passed" : "not_satisfied",
          {status: finding.status, evidenceCount: finding.evidenceRefs.length});
        step.output(flow.material("Attempt reconciliation", "assessed", reconciliation, "execution"));
        if (finding.status === "settled") {
          if (finding.evidenceRefs.length === 0 || finding.evidenceRefs.some(ref => !ref.trim()) ||
              !sameRetainedValue(finding.result.attempt, last.intent.request.attempt)) reject("action_recovery_evidence_invalid");
          sandbox = finding.result;
        } else {
          if (!finding.code.trim()) reject("action_recovery_evidence_invalid");
          const settlement: CanonicalActionSettlement = {
            ...preparedSettlement(request, preparation.prepared, "unknown_effect", "action-execution", finding.code,
              `${request.action.id}:recovered_settlement`, this.now(), attempts),
            effectCertainty: "unknown", completionExtent: "unknown", reconciliationRequired: true,
          };
          await this.record("settlement", request.action.id, null, () => this.dependencies.records.recordPostEffect({
            runId: request.runId, binding: request.binding, settlement, sandbox: null, prepared: preparation.prepared, reconciliation}));
          const semanticResult = await adapter.adapter.settle(preparation.prepared, settlement);
          flow.advance("settlement", {reused: false, settlementId: settlement.ref.id, outcome: "unknown_effect"});
          flow.close("returned");
          return {status: "settled", settlement, semanticResult} as ActionRecoveryResult<TOutput>;
        }
        await this.record("attempt_result", request.action.id, sandbox.attempt.id, () => this.dependencies.records.recordAttemptResult({
          intentRecordId: last.recordId, result: sandbox!, recordedAt: this.now(),
          reconciliation: {evidenceRefs: finding.evidenceRefs}}));
      } else step.check("reconciliation", "passed", {reason: "physical_result_retained"});
      if (canConsiderRetry(sandbox) && records.attempts.length < request.maxAttempts) {
        const retry = last.retry ?? await this.decideAndRecordRetry(request, preparation.prepared, sandbox, last.recordId);
        const retryStep = flow.advance("retry", {retained: last.retry !== null, remainingAttempts: retry.remainingAttempts});
        retryStep.output(flow.material("Retained Action retry decision", "acknowledged", retry, "execution"));
        retryStep.check("replay_basis", retry.decision.status === "retry" ? "passed" : "not_applicable");
        if (retry.decision.status === "retry") {
          const ledger = CanonicalActionLedger.restoreDispatch(last.intent.ledger);
          await ledger.transition({expectedRevision: ledger.getSnapshot().revision, kind: "begin_retry_delay"});
          const interrupted = await this.waitForRetry(request, retry, flow);
          if (interrupted !== null) {
            const result = await this.settlePrepared<TOutput>(ledger, request, adapter.adapter, preparation.prepared,
              interrupted === "cancelled" ? "cancelled" : "failed", "action-execution", interrupted === "cancelled" ? "action_retry_interrupted" : "action_deadline_exceeded");
            flow.advance("settlement", {status: result.status === "settled" ? result.settlement.status : result.status});
            flow.close("returned");
            return result;
          }
          const result = await this.executeWithFlow<TRequest, TOutput>(request, flow, {ledger, prepared: preparation.prepared});
          if (result.status === "settled") flow.advance("settlement", {status: result.settlement.status});
          flow.close(result.status === "pending_interaction" ? "yielded" : "returned");
          return result;
        }
      }
      const settlement = settlementFromPhysical(request, preparation.prepared, adapter.registration.binding,
        attempts, sandbox,
        `${request.action.id}:recovered_settlement`, this.now());
      await this.record("settlement", request.action.id, null, () => this.dependencies.records.recordPostEffect({
        runId: request.runId, binding: request.binding, settlement, sandbox, prepared: preparation.prepared,
        ...(reconciliation ? {reconciliation} : {})}));
      const semanticResult = await adapter.adapter.settle(preparation.prepared, settlement);
      flow.advance("settlement", {reused: false, settlementId: settlement.ref.id});
      flow.close("returned");
      return {status: "settled", settlement, semanticResult} as ActionRecoveryResult<TOutput>;
    } catch (error) {flow.close("failed"); throw error;}
  }

  async execute<TRequest, TOutput>(
    request: ActionExecutionRequest<TRequest>,
  ): Promise<ActionExecutionResult<TOutput>> {
    const flow = new ExecutionFlowPath(ACTION_EXECUTION_FLOW, request.executionFlow ?? {}, request.runId, [{owner:"action-execution",kind:"action",id:request.action.id,revision:null}]);
    try {
      const result = await this.executeWithFlow<TRequest,TOutput>(request, flow);
      flow.advance("settlement", {status:result.status === "settled" ? result.settlement.status : result.status})
        .output(flow.material("Action execution result", "settled", result, "execution"));
      flow.close(result.status === "pending_interaction" ? "yielded" : result.settlement.status === "failed" ? "failed" : "returned");
      return result;
    } catch (error) { flow.close(request.interruption.signal.aborted ? "cancelled" : "failed"); throw error; }
  }

  private async executeWithFlow<TRequest, TOutput>(
    request: ActionExecutionRequest<TRequest>,
    flow: ExecutionFlowPath,
    resumed?: {readonly ledger: CanonicalActionLedger; readonly prepared: PreparedAction},
  ): Promise<ActionExecutionResult<TOutput>> {
    if (!Number.isSafeInteger(request.maxAttempts) || request.maxAttempts < 1 || !Number.isFinite(Date.parse(request.deadlineAt))) {
      throw new TypeError("Action execution requires valid original attempt and deadline limits.");
    }
    const preparationStep = flow.advance(resumed ? "restore_prepared" : "prepare", {actionId: request.action.id, enforcement: request.enforcement},
      [flow.material("Action binding", "received", {action: request.action, parentRunAction: request.parentRunAction, binding: request.binding}, "execution")]);
    const ledger = resumed?.ledger ?? new CanonicalActionLedger(request.action, request.parentRunAction);
    if (!resumed) await ledger.transition({ expectedRevision: 0, kind: "begin_preparation" });
    const captured = this.adapters.find(request.binding.actionAdapterId);
    preparationStep.check("adapter", captured !== undefined && bindingMatches(captured.registration, request.binding) ? "passed" : "not_satisfied");
    if (captured === undefined || !bindingMatches(captured.registration, request.binding)) {
      preparationStep.check("prepared_subject", "not_evaluated", {reason: "adapter_unavailable"});
      return this.settleWithoutSubject<TOutput>(
        ledger,
        request,
        "invalid",
        "action-execution",
        "action_adapter_unavailable",
        "No matching Action adapter is available; the requested operation was not executed.",
      );
    }

    const preparedResult = resumed ? {status: "prepared" as const, prepared: resumed.prepared} : await captured.adapter.prepare(request.binding, {
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
      preparationStep.check("prepared_subject", "not_satisfied", {status:preparedResult.status});
      return this.settleWithoutSubject<TOutput>(
        ledger,
        request,
        preparationStatus(preparedResult.status),
        preparedResult.owner,
        preparedResult.code,
        preparedResult.message,
      );
    }
    const prepared = preparedResult.prepared;
    const preparedRef = flow.material("Prepared Action", "prepared", {subject: prepared.subject, invocation: prepared.invocation,
      assertions: prepared.assertions, approval: prepared.approval, safeSummary: prepared.safeSummary}, "execution");
    preparationStep.output(preparedRef);
    assertPreparedCoherence(request, captured.registration, prepared);
    if (!resumed) await this.record("prepared_action", request.action.id, null, () => this.dependencies.records.recordPreparedAction({
      runId: request.runId, binding: request.binding, registration: captured.registration, prepared,
      limits: {maxAttempts: request.maxAttempts, deadlineAt: request.deadlineAt}, recordedAt: this.now(),
    }));
    preparationStep.check("retention", "passed", {reused: resumed !== undefined});
    preparationStep.check("prepared_subject", "passed", {actionId:prepared.subject.ref.action.id, revision:prepared.subject.ref.revision});
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
    if (!resumed) await ledger.transition({
      expectedRevision: ledger.getSnapshot().revision,
      kind: "record_subject",
      subject: prepared.subject,
    });
    await ledger.transition({
      expectedRevision: ledger.getSnapshot().revision,
      kind: "begin_assessment",
    });

    this.notify(Object.freeze({ kind: "prepared", runId: request.runId,
      actionId: request.action.id, parentRunAction: request.parentRunAction,
      subject: prepared.subject, occurredAt: null }));
    const policyStep = flow.advance("policy", {policySnapshotId:request.policyContext.policySnapshotId}, [preparedRef]);
    const policy = await this.dependencies.policy.evaluate({
      checkId: this.id("policy"),
      subject: prepared.subject,
      context: request.policyContext,
    });
    policyStep.check("policy", ["denied","failed","interrupted"].includes(policy.status) ? "not_satisfied" : "passed", {status:policy.status,checkId:policy.checkId});
    const policyRef = flow.material("Governance assessment", "assessed", policy, "execution");
    policyStep.output(policyRef);
    this.notify(Object.freeze({ kind: "assessment", runId: request.runId,
      actionId: request.action.id, policyStatus: policy.status, permissionStatus: null, policy, permission: null, occurredAt: policy.decidedAt }));
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
    let permissionStep = flow.advance("permission", {}, [preparedRef, policyRef]);
    let permission = await this.dependencies.permission.assess({
      assessmentId: this.id("permission"),
      actionFingerprint: fingerprint,
      subject: prepared.subject,
      requirement,
      reviewCauses,
      context: request.permissionContext(),
      interruption: request.interruption,
    });
    this.notify(Object.freeze({ kind: "assessment", runId: request.runId,
      actionId: request.action.id, policyStatus: policy.status, permissionStatus: permission.status, policy, permission, occurredAt: permission.assessedAt }));
    let permissionRef = flow.material("Permission assessment", "assessed", permission, "execution");
    permissionStep.output(permissionRef);
    if (permission.status === "approval_required") {
      permissionStep.check("permission", "not_satisfied", {status:permission.status});
      const approvalStep = flow.advance("approval", {}, [preparedRef, permissionRef]);
      if (this.dependencies.approval === null) {
        approvalStep.check("approval", "not_evaluated", {reason: "external_interaction_required"});
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
      approvalStep.check("approval", approval.status === "applied" ? "passed" : "not_satisfied", {status:approval.status});
      const approvalRef = flow.material("Approval resolution", "resolved", approval, "execution");
      approvalStep.output(approvalRef);
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
          approval.status === "limit_exceeded" ? approval.detail : undefined,
        );
      }
      await ledger.transition({
        expectedRevision: ledger.getSnapshot().revision,
        kind: "begin_assessment",
      });
      permissionStep = flow.advance("permission", {reassessment:true}, [preparedRef, policyRef, approvalRef]);
      permission = await this.dependencies.permission.assess({
        assessmentId: this.id("permission-reassessment"),
        actionFingerprint: fingerprint,
        subject: prepared.subject,
        requirement,
        reviewCauses,
        context: request.permissionContext(),
        interruption: request.interruption,
      });
      this.notify(Object.freeze({ kind: "assessment", runId: request.runId,
        actionId: request.action.id, policyStatus: policy.status, permissionStatus: permission.status, policy, permission, occurredAt: permission.assessedAt }));
      permissionRef = flow.material("Permission reassessment", "assessed", permission, "execution");
      permissionStep.output(permissionRef);
    }
    permissionStep.check("permission", permission.status === "authorized" ? "passed" : "not_satisfied", {status:permission.status});
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
    const revalidationStep = flow.advance("revalidate", {}, [preparedRef, permissionRef]);
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
    revalidationStep.check("baseline", revalidation.status === "valid" ? "passed" : "not_satisfied", {status:revalidation.status});
    revalidationStep.output(flow.material("Action revalidation", "checked", revalidation, "execution"));
    if (revalidation.status !== "valid") {
      revalidationStep.check("authority", "not_evaluated", {reason: "baseline_not_valid"});
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
      revalidationStep.check("authority", "not_evaluated", {reason: "progression_basis_invalidated"});
      return this.settlePrepared<TOutput>(ledger, request, captured.adapter, prepared, "invalidated", "agent-runtime", "action_progression_basis_invalidated");
    }
    const authorityCurrent = request.authority.isBasisCurrent(authorityBasis);
    revalidationStep.check("authority", authorityCurrent ? "passed" : "not_satisfied", {authorityRevision: authorityBasis.authorityRevision});
    if (!authorityCurrent) {
      return this.settlePrepared<TOutput>(ledger, request, captured.adapter, prepared, "invalidated", "agent-runtime", "action_authority_basis_stale");
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

    const dispatchPlanFingerprint = `${request.action.id}:${ledger.getSnapshot().attempts.length}:${this.id("dispatch-plan")}`;
    flow.advance("record", {dispatchPlanFingerprint}, [preparedRef, policyRef, permissionRef]);
    let preparationReceipt = await this.record("preparation", request.action.id, null, () => this.dependencies.records.recordPreEffect({
      runId: request.runId,
      prepared,
      binding: request.binding,
      registration: captured.registration,
      policy,
      permission,
      dispatchPlanFingerprint,
      recordedAt: this.now(),
      limits: {maxAttempts: request.maxAttempts, deadlineAt: request.deadlineAt},
    }));
    if (!Number.isSafeInteger(request.maxAttempts) || request.maxAttempts < 1) {
      throw new TypeError("Action execution maxAttempts must be a positive integer.");
    }
    let sandbox: SandboxExecutionResult;
    let activeDispatchPlanFingerprint = dispatchPlanFingerprint;
    while (true) {
      if (request.interruption.signal.aborted || Date.parse(this.now()) >= Date.parse(request.deadlineAt)) {
        return this.settlePrepared<TOutput>(ledger, request, captured.adapter, prepared,
          request.interruption.signal.aborted ? "cancelled" : "failed", "action-execution",
          request.interruption.signal.aborted ? "action_retry_interrupted" : "action_deadline_exceeded");
      }
      const dispatchStep = flow.advance("sandbox", {executorId:captured.registration.executor.id});
      await ledger.claimDispatch({
        expectedRevision: ledger.getSnapshot().revision,
        claimId: this.id("dispatch-claim"),
        attemptId: `${request.action.id}:attempt:${ledger.getSnapshot().attempts.length + 1}`,
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
      dispatchStep.check("progression_basis", "passed");
      dispatchStep.check("authority_basis", "passed", {authorityRevision:authorityBasis.authorityRevision});
      const dispatchRequest = {
        executionLifetime: captured.registration.executionLifetime,
        attempt: sandboxAttempt,
        policy: sandboxPolicy,
        executor: captured.registration.executor,
        actionRegistrationFingerprint: captured.registration.registrationFingerprint,
        invocation: prepared.invocation,
        deadlineAt: request.deadlineAt,
      };
      const intent = await this.record("dispatch_intent", request.action.id, attempt.id,
        () => this.dependencies.records.recordDispatchIntent({
          preparationRecordId: preparationReceipt.recordId,
          ledger: ledger.getSnapshot(),
          request: dispatchRequest,
        }));
      // Persistence can yield; recheck admission before crossing the effectful interface.
      if (!request.isProgressionBasisCurrent() || !request.authority.isBasisCurrent(authorityBasis)) {
        return this.settlePrepared<TOutput>(ledger, request, captured.adapter, prepared,
          "invalidated", "agent-runtime", "action_dispatch_basis_stale");
      }
      if (request.interruption.signal.aborted || Date.parse(this.now()) >= Date.parse(request.deadlineAt)) {
        return this.settlePrepared<TOutput>(ledger, request, captured.adapter, prepared,
          request.interruption.signal.aborted ? "cancelled" : "failed", "action-execution",
          request.interruption.signal.aborted ? "action_dispatch_interrupted" : "action_deadline_exceeded");
      }
      this.notify(Object.freeze({
        kind: "attempt_started" as const,
        runId: request.runId,
        actionId: request.action.id,
        attemptId: attempt.id,
        ordinal: attempt.ordinal,
        enforcement: request.enforcement,
        occurredAt: sandboxAttempt.startedAt,
      }));
      sandbox = await this.dependencies.sandbox.execute({
        ...dispatchRequest,
        executionFlow: flow.callContext,
        interruption: request.interruption,
      });
      await this.record("attempt_result", request.action.id, attempt.id,
        () => this.dependencies.records.recordAttemptResult({
          intentRecordId: intent.recordId, result: sandbox, recordedAt: this.now(),
        }));
      this.notify(Object.freeze({ kind: "attempt_settled", runId: request.runId,
        actionId: request.action.id, attemptId: attempt.id, result: sandbox,
        occurredAt: sandbox.status === "settled" ? sandbox.enforcementEvidence.settledAt : null }));
      const remainingAttempts = request.maxAttempts - attempt.ordinal;
      const sandboxRef = flow.material("Sandbox execution result", "settled", sandbox, "execution");
      dispatchStep.output(sandboxRef);
      if (remainingAttempts < 1 || !canConsiderRetry(sandbox)) break;
      const retryStep = flow.advance("retry", {remainingAttempts}, [sandboxRef]);
      const retry = await this.decideAndRecordRetry(request, prepared, sandbox, intent.recordId);
      const decision = retry.decision;
      retryStep.output(flow.material("Action retry decision", "decided", decision, "execution"));
      if (decision.status !== "retry") {
        retryStep.check("replay_basis", "not_applicable", {reason: "retry_not_requested"});
        break;
      }
      retryStep.check("replay_basis", "passed", {decisionRecordId:decision.decisionRecordId});
      await ledger.transition({
        expectedRevision: ledger.getSnapshot().revision,
        kind: "begin_retry_delay",
      });
      const interrupted = await this.waitForRetry(request, retry, flow);
      if (interrupted !== null) {
        return this.settlePrepared<TOutput>(
          ledger,
          request,
          captured.adapter,
          prepared,
          interrupted === "cancelled" ? "cancelled" : "failed",
          "action-execution",
          interrupted === "cancelled" ? "action_retry_interrupted" : "action_deadline_exceeded",
        );
      }
      await ledger.transition({
        expectedRevision: ledger.getSnapshot().revision,
        kind: "begin_revalidation",
      });
      const retryValidationStep = flow.advance("revalidate");
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
      retryValidationStep.check("baseline", retryRevalidation.status === "valid" ? "passed" : "not_satisfied", {status:retryRevalidation.status});
      retryValidationStep.check("authority", "not_evaluated", {reason: "authority_checked_at_dispatch"});
      retryValidationStep.output(flow.material("Retry Action revalidation", "checked", retryRevalidation, "execution"));
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
      flow.advance("record", {dispatchPlanFingerprint:activeDispatchPlanFingerprint});
      preparationReceipt = await this.record("preparation", request.action.id, null, () => this.dependencies.records.recordPreEffect({
        runId: request.runId,
        prepared,
        binding: request.binding,
        registration: captured.registration,
        policy,
        permission,
        dispatchPlanFingerprint: activeDispatchPlanFingerprint,
        recordedAt: this.now(),
        limits: {maxAttempts: request.maxAttempts, deadlineAt: request.deadlineAt},
      }));
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
    await this.record("settlement", request.action.id, null,
      () => this.dependencies.records.recordPostEffect({ runId: request.runId, binding: request.binding, settlement, sandbox, prepared }));
    this.notifySettlement(request, settlement);
    const semanticResult = await captured.adapter.settle(prepared, settlement);
    return Object.freeze({ status: "settled" as const, settlement, semanticResult }) as ActionExecutionResult<TOutput>;
  }

  private async decideAndRecordRetry(
    request: ActionExecutionRequest, prepared: PreparedAction, result: SandboxExecutionResult, intentRecordId: string,
  ): Promise<ActionRetryRecord> {
    const attempt = {id: result.attempt.id, action: result.attempt.action, ordinal: result.attempt.ordinal};
    const remainingAttempts = request.maxAttempts - attempt.ordinal;
    const decision = structuredClone(await this.dependencies.retry.decide({subject: prepared.subject, attempt, result, remainingAttempts}));
    const decidedAt = this.now();
    const notBeforeMs = decision.status === "retry" ? Date.parse(decidedAt) + decision.delayMs : null;
    if (notBeforeMs !== null && (!Number.isSafeInteger(notBeforeMs) || Math.abs(notBeforeMs) > 8.64e15)) {
      throw new TypeError("Action retry time is invalid.");
    }
    const retry: ActionRetryRecord = {intentRecordId, runId: request.runId, action: request.action, attempt, decision,
      decidedAt, notBefore: notBeforeMs === null ? null : new Date(notBeforeMs).toISOString(), remainingAttempts,
      limits: {maxAttempts: request.maxAttempts, deadlineAt: request.deadlineAt}};
    this.validateRetryRecord(request, retry, intentRecordId, attempt, prepared);
    await this.record("retry", request.action.id, attempt.id, () => this.dependencies.records.recordRetry(structuredClone(retry)));
    return retry;
  }

  private validateRetryRecord(
    request: ActionExecutionRequest, retry: ActionRetryRecord, intentRecordId: string,
    attempt: import("@agent-anything/canonical-action/subject").ActionAttemptRef, prepared: PreparedAction,
  ): void {
    if (retry.intentRecordId !== intentRecordId || retry.runId !== request.runId || retry.action.id !== request.action.id ||
        !sameRetainedValue(retry.attempt, {id: attempt.id, action: attempt.action, ordinal: attempt.ordinal}) ||
        retry.limits.maxAttempts !== request.maxAttempts || retry.limits.deadlineAt !== request.deadlineAt ||
        !Number.isSafeInteger(retry.remainingAttempts) || retry.remainingAttempts < 1 ||
        retry.remainingAttempts !== request.maxAttempts - attempt.ordinal || !Number.isFinite(Date.parse(retry.decidedAt))) {
      throw new ActionRecoveryError(request.action.id, "action_retry_record_invalid");
    }
    if (retry.decision.status === "retry") {
      const decision = retry.decision;
      assertReplayBasis(prepared.subject, decision.replayBasis);
      if (!Number.isSafeInteger(decision.delayMs) || decision.delayMs < 0 || !decision.decisionRecordId.trim() ||
          retry.notBefore === null || Date.parse(retry.notBefore) !== Date.parse(retry.decidedAt) + decision.delayMs) {
        throw new ActionRecoveryError(request.action.id, "action_retry_record_invalid");
      }
    } else if (retry.decision.status !== "stop" || !retry.decision.code.trim() || retry.notBefore !== null) {
      throw new ActionRecoveryError(request.action.id, "action_retry_record_invalid");
    }
  }

  private async waitForRetry(request: ActionExecutionRequest, retry: ActionRetryRecord, flow: ExecutionFlowPath): Promise<"cancelled" | "deadline" | null> {
    if (request.interruption.signal.aborted) return "cancelled";
    const now = Date.parse(this.now());
    const notBefore = Date.parse(retry.notBefore!);
    if (now >= Date.parse(request.deadlineAt) || notBefore >= Date.parse(request.deadlineAt)) return "deadline";
    const delayMs = Math.max(0, notBefore - now);
    flow.advance("retry_wait", {delayMs, notBefore: retry.notBefore});
    const wait = await this.dependencies.retry.wait({delayMs, interruption: request.interruption});
    if (wait === "interrupted" || request.interruption.signal.aborted) return "cancelled";
    return Date.parse(this.now()) >= Date.parse(request.deadlineAt) ? "deadline" : null;
  }

  private async settleWithoutSubject<TOutput>(
    ledger: CanonicalActionLedger,
    request: ActionExecutionRequest,
    status: CanonicalActionSettlementStatus,
    owner: string,
    code: string,
    message: string,
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
    await this.record("settlement", request.action.id, null,
      () => this.dependencies.records.recordPostEffect({ runId: request.runId, binding: request.binding, settlement, sandbox: null, prepared: null,
        preparationFailure: {owner, code, message} }));
    this.notifySettlement(request, settlement);
    return Object.freeze({
      status: "settled" as const,
      settlement,
      semanticResult: semanticFailure(settlement, owner, code, message),
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
    failureDetail?: OperationLimitFailureDetail,
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
      failureDetail,
    );
    await ledger.settle({ expectedRevision: ledger.getSnapshot().revision, settlement });
    await this.record("settlement", request.action.id, null,
      () => this.dependencies.records.recordPostEffect({ runId: request.runId, binding: request.binding, settlement, sandbox: null, prepared }));
    this.notifySettlement(request, settlement);
    return Object.freeze({
      status: "settled" as const,
      settlement,
      semanticResult: await adapter.settle(prepared, settlement),
    }) as ActionExecutionResult<TOutput>;
  }

  private async record(
    stage: ActionRecordCommitError["stage"], actionId: string, attemptId: string | null,
    commit: () => Promise<ActionRecordReceipt>,
  ): Promise<ActionRecordReceipt> {
    try {
      const receipt = await commit();
      if (typeof receipt?.recordId !== "string" || receipt.recordId.trim().length === 0) {
        throw new TypeError("An Action record acknowledgement requires its committed record identity.");
      }
      return receipt;
    }
    catch (cause) { throw new ActionRecordCommitError(stage, actionId, attemptId, cause); }
  }

  private id(kind: string): string {
    return this.dependencies.createId?.(kind) ?? `${kind}:${globalThis.crypto.randomUUID()}`;
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
    !sameRetainedValue(prepared.subject.parentRunAction, request.parentRunAction) ||
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
  failureDetail?: OperationLimitFailureDetail,
): CanonicalActionSettlement {
  const detail = readOperationLimitFailureDetail(failureDetail);
  if (failureDetail !== undefined && (detail === null || attempts.length !== 0)) {
    throw new TypeError("Approval quota rejection requires valid detail and no dispatched attempts.");
  }
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
    ...(detail === null ? {} : { failureDetail: detail }),
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
  message: string,
): ActionSemanticResult {
  return Object.freeze({
    operationInvocationId: settlement.operationInvocation.id,
    settlement,
    status: settlement.status === "timed_out" ? "timed_out" : settlement.status === "cancelled" ? "cancelled" : settlement.status === "denied" ? "denied" : settlement.status === "invalid" || settlement.status === "invalidated" ? "invalid" : settlement.status === "unknown_effect" ? "unknown_effect" : "failed",
    output: null,
    failure: Object.freeze({ owner, code, message }),
  });
}

async function actionFingerprint(subject: CanonicalActionSubjectRevision): Promise<string> {
  const { createCanonicalActionSubjectFingerprint } = await import(
    "@agent-anything/canonical-action/subject"
  );
  return createCanonicalActionSubjectFingerprint(subject);
}

function sameRetainedValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object" ||
      Array.isArray(left) !== Array.isArray(right)) return false;
  const a = left as Record<string, unknown>;
  const b = right as Record<string, unknown>;
  return Object.keys(a).length === Object.keys(b).length &&
    Object.keys(a).every(key => Object.hasOwn(b, key) && sameRetainedValue(a[key], b[key]));
}
