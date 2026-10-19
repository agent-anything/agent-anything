import type { ResolvedOperationBinding } from "@agent-anything/operation-catalog/binding";
import type { ActionRegistration } from "@agent-anything/canonical-action/registration";
import type { CanonicalActionRef } from "@agent-anything/canonical-action/subject";
import type { CanonicalActionSettlement } from "@agent-anything/canonical-action/settlement";
import type { ActionPolicyAssessment } from "@agent-anything/governance/policy";
import type { ActionPermissionAssessment } from "@agent-anything/permission/authority";
import type { PreparedAction } from "../registration/ActionAdapter.js";
import type { SandboxExecutionRequest, SandboxExecutionResult } from "../sandbox/SandboxContracts.js";

export interface ActionPreparationRecord {
  readonly runId: string;
  readonly prepared: PreparedAction;
  readonly binding: ResolvedOperationBinding & { readonly kind: "direct" | "hosted" };
  readonly registration: ActionRegistration;
  readonly policy: ActionPolicyAssessment;
  readonly permission: ActionPermissionAssessment;
  readonly dispatchPlanFingerprint: string;
  readonly recordedAt: string;
  readonly limits: {readonly maxAttempts: number; readonly deadlineAt: string};
}

/** Intent means dispatch may happen, not that the external resource received it. */
export interface ActionDispatchIntent {
  readonly preparationRecordId: string;
  readonly ledger: import("@agent-anything/canonical-action/lifecycle").CanonicalActionState;
  readonly request: Omit<SandboxExecutionRequest, "executionFlow" | "interruption">;
}

export interface ActionAttemptResultRecord {
  readonly intentRecordId: string;
  readonly result: SandboxExecutionResult;
  readonly recordedAt: string;
  readonly reconciliation?: {readonly evidenceRefs: readonly string[]};
}

export interface ActionRetryRecord {
  readonly intentRecordId: string;
  readonly runId: string;
  readonly action: CanonicalActionRef;
  readonly attempt: import("@agent-anything/canonical-action/subject").ActionAttemptRef;
  readonly decision: import("./ActionExecutionCoordinator.js").ActionRetryDecision;
  readonly decidedAt: string;
  readonly notBefore: string | null;
  readonly remainingAttempts: number;
  readonly limits: ActionPreparationRecord["limits"];
}

export interface ActionSettlementRecord {
  readonly runId: string;
  readonly binding: ResolvedOperationBinding & {readonly kind: "direct" | "hosted"};
  readonly settlement: CanonicalActionSettlement;
  readonly sandbox: SandboxExecutionResult | null;
  readonly prepared: PreparedAction | null;
  readonly preparationFailure?: {readonly owner: string; readonly code: string; readonly message: string};
  readonly reconciliation?: {
    readonly intentRecordId: string;
    readonly status: "settled" | "unknown";
    readonly evidenceRefs: readonly string[];
    readonly code: string | null;
  };
}

export interface ActionRecordReceipt { readonly recordId: string }

/** Acknowledgement is an owner commit barrier, never an observer notification. */
export interface ActionRecordPort {
  recordPreEffect(input: ActionPreparationRecord): Promise<ActionRecordReceipt>;
  recordDispatchIntent(input: ActionDispatchIntent): Promise<ActionRecordReceipt>;
  recordAttemptResult(input: ActionAttemptResultRecord): Promise<ActionRecordReceipt>;
  recordRetry(input: ActionRetryRecord): Promise<ActionRecordReceipt>;
  recordPostEffect(input: ActionSettlementRecord): Promise<ActionRecordReceipt>;
}

export interface ActionRecoveryRecords {
  readonly preparations: readonly { readonly recordId: string; readonly value: ActionPreparationRecord }[];
  readonly attempts: readonly {
    readonly recordId: string;
    readonly intent: ActionDispatchIntent;
    readonly result: ActionAttemptResultRecord | null;
    readonly retry: ActionRetryRecord | null;
  }[];
  readonly settlement: ActionSettlementRecord | null;
}

/** Missing records alone do not authorize replay. Reconciliation belongs to the executor owner. */
export interface ActionRecoveryRecordPort {
  readAction(input: { readonly runId: string; readonly action: CanonicalActionRef }): Promise<ActionRecoveryRecords>;
}

export interface ActionAttemptReconciliationPort {
  /** Observe retained/external evidence only; never execute a replacement attempt. */
  reconcile(input: {
    readonly intent: ActionDispatchIntent;
    readonly preparation: ActionPreparationRecord;
  }): Promise<
    | {readonly status: "settled"; readonly result: SandboxExecutionResult; readonly evidenceRefs: readonly string[]}
    | {readonly status: "unknown"; readonly code: string; readonly evidenceRefs: readonly string[]}
  >;
}

export class ActionRecoveryError extends Error {
  constructor(readonly actionId: string, readonly code: string) {
    super(`Action recovery cannot proceed: ${code}.`);
    this.name = "ActionRecoveryError";
  }
}

export class ActionRecordCommitError extends Error {
  constructor(
    readonly stage: "preparation" | "dispatch_intent" | "attempt_result" | "retry" | "settlement",
    readonly actionId: string,
    readonly attemptId: string | null,
    cause: unknown,
  ) {
    super(`Action ${stage} record was not acknowledged.`, { cause });
    this.name = "ActionRecordCommitError";
  }
}
