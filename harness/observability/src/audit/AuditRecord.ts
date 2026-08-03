import type {
  IdentityKind,
  ISODateTimeString,
} from "@agent-anything/foundation";

export const AUDIT_RECORD_SCHEMA_VERSION = 1 as const;

export type AuditOutcome = "succeeded" | "failed" | "blocked" | "cancelled";

export type AuditRecordName =
  | "run.started"
  | "run.succeeded"
  | "run.blocked"
  | "run.failed"
  | "run.cancelled"
  | "approval.requested"
  | "approval.decision_validated"
  | "approval.resolved"
  | "action.dispatch_authorized"
  | "sandbox.attempt.started"
  | "sandbox.attempt.resolved";

export type AuditApprovalCategory =
  | "commandExecution"
  | "fileChange"
  | "permissions"
  | "remoteToolCall"
  | "skill"
  | "networkAccess";

export type AuditApprovalDecisionKind =
  | "accept"
  | "acceptForSession"
  | "grantPermissions"
  | "acceptWithExecpolicyAmendment"
  | "applyNetworkPolicyAmendment"
  | "decline"
  | "cancel";

export type AuditApprovalReviewer = "user" | "auto_review";

export type AuditApprovalResolutionKind =
  | "decision"
  | "review_failure"
  | "request_failure"
  | "run_cancelled";

export type AuditApprovalApplicationKind =
  | "not_applicable"
  | "applied"
  | "not_applied"
  | "interrupted"
  | "outcome_unknown";

export type AuditSandboxEnforcement = "managed" | "external" | "disabled";

export type AuditSandboxOutcome =
  | "executed"
  | "sandbox_denied"
  | "sandbox_unavailable"
  | "interrupted"
  | "failed";

export interface AuditActor {
  readonly kind: IdentityKind;
  readonly id: string;
}

export interface AuditSubject {
  readonly kind: IdentityKind;
  readonly id: string;
}

export interface AuditRunTarget {
  readonly kind: "run";
  readonly id: string;
}

export interface AuditApprovalTarget {
  readonly kind: "approval_request";
  readonly id: string;
  readonly actionId: string;
  readonly category: AuditApprovalCategory | null;
}

export interface AuditActionTarget {
  readonly kind: "action";
  readonly id: string;
  readonly actionName: string;
  readonly actionFingerprint: string;
}

export interface AuditSandboxAttemptTarget {
  readonly kind: "sandbox_attempt";
  readonly id: string;
  readonly actionId: string;
}

export interface AuditRunLifecyclePayload<
  TStatus extends "started" | "succeeded" | "blocked" | "failed" | "cancelled",
> {
  readonly status: TStatus;
  readonly activeAgentId: string;
  readonly iterations: number;
  readonly actions: number;
  readonly itemCount: number;
}

export interface AuditApprovalRequestedPayload {
  readonly pendingVersion: number;
  readonly optionIds: readonly string[];
}

export interface AuditApprovalDecisionValidatedPayload {
  readonly pendingVersion: number;
  readonly optionIds: readonly string[];
  readonly decisionKind: AuditApprovalDecisionKind;
}

export interface AuditApprovalResolvedPayload {
  readonly pendingVersion: number;
  readonly reviewer: AuditApprovalReviewer;
  readonly resolutionKind: AuditApprovalResolutionKind;
  readonly decisionKind: AuditApprovalDecisionKind | null;
  readonly applicationKind: AuditApprovalApplicationKind;
  readonly code: string | null;
  readonly authorityRecordIds: readonly string[];
}

export interface AuditActionDispatchAuthorizedPayload {
  readonly authoritySnapshotId: string;
  readonly actionCoverageId: string | null;
  readonly enforcement: AuditSandboxEnforcement;
  readonly attemptOrdinal: 1 | 2;
  readonly dispatchPlanFingerprint: string;
}

export interface AuditSandboxAttemptStartedPayload {
  readonly actionFingerprint: string;
  readonly ordinal: 1 | 2;
  readonly enforcement: AuditSandboxEnforcement;
  readonly policyId: string;
  readonly authoritySnapshotId: string;
  readonly dispatchPlanFingerprint: string;
}

export interface AuditSandboxAttemptResolvedPayload
  extends AuditSandboxAttemptStartedPayload {
  readonly outcome: AuditSandboxOutcome;
  readonly code: string | null;
  readonly effectState: "none" | "unknown" | null;
}

interface AuditRecordContractMap {
  readonly "run.started": {
    readonly action: "runner.started";
    readonly target: AuditRunTarget;
    readonly outcome: "succeeded";
    readonly payload: AuditRunLifecyclePayload<"started">;
  };
  readonly "run.succeeded": {
    readonly action: "runner.succeeded";
    readonly target: AuditRunTarget;
    readonly outcome: "succeeded";
    readonly payload: AuditRunLifecyclePayload<"succeeded">;
  };
  readonly "run.blocked": {
    readonly action: "runner.blocked";
    readonly target: AuditRunTarget;
    readonly outcome: "blocked";
    readonly payload: AuditRunLifecyclePayload<"blocked">;
  };
  readonly "run.failed": {
    readonly action: "runner.failed";
    readonly target: AuditRunTarget;
    readonly outcome: "failed";
    readonly payload: AuditRunLifecyclePayload<"failed">;
  };
  readonly "run.cancelled": {
    readonly action: "runner.cancelled";
    readonly target: AuditRunTarget;
    readonly outcome: "cancelled";
    readonly payload: AuditRunLifecyclePayload<"cancelled">;
  };
  readonly "approval.requested": {
    readonly action: "approval.requested";
    readonly target: AuditApprovalTarget;
    readonly outcome: "succeeded";
    readonly payload: AuditApprovalRequestedPayload;
  };
  readonly "approval.decision_validated": {
    readonly action: "approval.decision_validated";
    readonly target: AuditApprovalTarget;
    readonly outcome: "succeeded";
    readonly payload: AuditApprovalDecisionValidatedPayload;
  };
  readonly "approval.resolved": {
    readonly action: "approval.resolved";
    readonly target: AuditApprovalTarget;
    readonly outcome: AuditOutcome;
    readonly payload: AuditApprovalResolvedPayload;
  };
  readonly "action.dispatch_authorized": {
    readonly action: "action.dispatch_authorized";
    readonly target: AuditActionTarget;
    readonly outcome: "succeeded";
    readonly payload: AuditActionDispatchAuthorizedPayload;
  };
  readonly "sandbox.attempt.started": {
    readonly action: "sandbox.attempt.started";
    readonly target: AuditSandboxAttemptTarget;
    readonly outcome: "succeeded";
    readonly payload: AuditSandboxAttemptStartedPayload;
  };
  readonly "sandbox.attempt.resolved": {
    readonly action: "sandbox.attempt.resolved";
    readonly target: AuditSandboxAttemptTarget;
    readonly outcome: "succeeded" | "failed" | "cancelled";
    readonly payload: AuditSandboxAttemptResolvedPayload;
  };
}

export type AuditActionByName = {
  readonly [TName in AuditRecordName]:
    AuditRecordContractMap[TName]["action"];
};

export type AuditTargetByName = {
  readonly [TName in AuditRecordName]:
    AuditRecordContractMap[TName]["target"];
};

export type AuditOutcomeByName = {
  readonly [TName in AuditRecordName]:
    AuditRecordContractMap[TName]["outcome"];
};

export type AuditPayloadByName = {
  readonly [TName in AuditRecordName]:
    AuditRecordContractMap[TName]["payload"];
};

interface AuditRecordEnvelope<TName extends AuditRecordName> {
  readonly schemaVersion: typeof AUDIT_RECORD_SCHEMA_VERSION;
  readonly id: string;
  readonly runId: string;
  readonly taskId: string;
  readonly eventName: TName;
  readonly timestamp: ISODateTimeString;
  readonly actor: AuditActor;
  readonly workspaceId: string | null;
  readonly subject: AuditSubject;
}

export type AuditRecord<TName extends AuditRecordName = AuditRecordName> = {
  readonly [TCurrentName in TName]:
    AuditRecordEnvelope<TCurrentName> & {
      readonly action: AuditActionByName[TCurrentName];
      readonly target: AuditTargetByName[TCurrentName];
      readonly outcome: AuditOutcomeByName[TCurrentName];
      readonly payload: AuditPayloadByName[TCurrentName];
    };
}[TName];

export type CreateAuditRecordInput<
  TName extends AuditRecordName = AuditRecordName,
> = {
  readonly [TCurrentName in TName]:
    Omit<AuditRecord<TCurrentName>, "schemaVersion">;
}[TName];
