

export const TELEMETRY_RECORD_SCHEMA_VERSION = 1 as const;

export type TelemetryRecordName =
  | "runner.run.started"
  | "runner.run.succeeded"
  | "runner.run.failed"
  | "runner.run.cancelled"
  | "runner.approval.resolved"
  | "runner.sandbox.attempt.started"
  | "runner.sandbox.attempt.resolved";

export type TelemetryRunStatus =
  | "started"
  | "succeeded"
  | "failed"
  | "cancelled";

export type TelemetryApprovalReviewer = "user" | "auto_review";

export type TelemetryApprovalResolutionKind =
  | "decision"
  | "review_failure"
  | "request_failure"
  | "run_cancelled";

export type TelemetryApprovalDecisionKind =
  | "accept"
  | "acceptForSession"
  | "grantPermissions"
  | "acceptWithExecpolicyAmendment"
  | "applyNetworkPolicyAmendment"
  | "decline"
  | "cancel";

export type TelemetryApprovalApplicationKind =
  | "not_applicable"
  | "applied"
  | "not_applied"
  | "interrupted"
  | "outcome_unknown";

export type TelemetrySandboxEnforcement = "managed" | "external" | "disabled";

export type TelemetrySandboxOutcome =
  | "executed"
  | "sandbox_denied"
  | "sandbox_unavailable"
  | "interrupted"
  | "failed";

export interface RunLifecycleTelemetryCounters {
  readonly iterations: number;
  readonly actions: number;
  readonly items: number;
}

export interface RunLifecycleTelemetryDimensions<
  TStatus extends TelemetryRunStatus,
> {
  readonly status: TStatus;
  readonly agentId: string;
}

export interface ApprovalResolvedTelemetryCounters {
  readonly requests: number;
  readonly consecutiveDeclines: number;
  readonly consecutiveReviewFailures: number;
  readonly authorityRecords: number;
}

export interface ApprovalResolvedTelemetryDimensions {
  readonly reviewer: TelemetryApprovalReviewer;
  readonly resolutionKind: TelemetryApprovalResolutionKind;
  readonly decisionKind: TelemetryApprovalDecisionKind | null;
  readonly applicationKind: TelemetryApprovalApplicationKind;
  readonly code: string | null;
}

export interface SandboxAttemptTelemetryCounters {
  readonly ordinal: 1 | 2;
}

export interface SandboxAttemptStartedTelemetryDimensions {
  readonly phase: "started";
  readonly enforcement: TelemetrySandboxEnforcement;
  readonly outcome: "started";
}

export interface SandboxAttemptResolvedTelemetryDimensions {
  readonly phase: "resolved";
  readonly enforcement: TelemetrySandboxEnforcement;
  readonly outcome: TelemetrySandboxOutcome;
}

interface TelemetryRecordContractMap {
  readonly "runner.run.started": {
    readonly durationMs: number;
    readonly counters: RunLifecycleTelemetryCounters;
    readonly dimensions: RunLifecycleTelemetryDimensions<"started">;
  };
  readonly "runner.run.succeeded": {
    readonly durationMs: number;
    readonly counters: RunLifecycleTelemetryCounters;
    readonly dimensions: RunLifecycleTelemetryDimensions<"succeeded">;
  };
  readonly "runner.run.failed": {
    readonly durationMs: number;
    readonly counters: RunLifecycleTelemetryCounters;
    readonly dimensions: RunLifecycleTelemetryDimensions<"failed">;
  };
  readonly "runner.run.cancelled": {
    readonly durationMs: number;
    readonly counters: RunLifecycleTelemetryCounters;
    readonly dimensions: RunLifecycleTelemetryDimensions<"cancelled">;
  };
  readonly "runner.approval.resolved": {
    readonly durationMs: null;
    readonly counters: ApprovalResolvedTelemetryCounters;
    readonly dimensions: ApprovalResolvedTelemetryDimensions;
  };
  readonly "runner.sandbox.attempt.started": {
    readonly durationMs: 0;
    readonly counters: SandboxAttemptTelemetryCounters;
    readonly dimensions: SandboxAttemptStartedTelemetryDimensions;
  };
  readonly "runner.sandbox.attempt.resolved": {
    readonly durationMs: number;
    readonly counters: SandboxAttemptTelemetryCounters;
    readonly dimensions: SandboxAttemptResolvedTelemetryDimensions;
  };
}

export type TelemetryDurationByName = {
  readonly [TName in TelemetryRecordName]:
    TelemetryRecordContractMap[TName]["durationMs"];
};

export type TelemetryCountersByName = {
  readonly [TName in TelemetryRecordName]:
    TelemetryRecordContractMap[TName]["counters"];
};

export type TelemetryDimensionsByName = {
  readonly [TName in TelemetryRecordName]:
    TelemetryRecordContractMap[TName]["dimensions"];
};

interface TelemetryRecordEnvelope<TName extends TelemetryRecordName> {
  readonly schemaVersion: typeof TELEMETRY_RECORD_SCHEMA_VERSION;
  readonly id: string;
  readonly runId: string;
  readonly taskId: string;
  readonly eventName: TName;
  readonly timestamp: string;
}

export type TelemetryRecord<
  TName extends TelemetryRecordName = TelemetryRecordName,
> = {
  readonly [TCurrentName in TName]: TelemetryRecordEnvelope<TCurrentName> & {
    readonly durationMs: TelemetryDurationByName[TCurrentName];
    readonly counters: TelemetryCountersByName[TCurrentName];
    readonly dimensions: TelemetryDimensionsByName[TCurrentName];
  };
}[TName];

export type CreateTelemetryRecordInput<
  TName extends TelemetryRecordName = TelemetryRecordName,
> = {
  readonly [TCurrentName in TName]:
    Omit<TelemetryRecord<TCurrentName>, "schemaVersion">;
}[TName];
