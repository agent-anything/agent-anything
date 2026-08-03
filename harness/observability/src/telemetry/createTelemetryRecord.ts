import {
  TELEMETRY_RECORD_SCHEMA_VERSION,
  type CreateTelemetryRecordInput,
  type TelemetryApprovalApplicationKind,
  type TelemetryApprovalDecisionKind,
  type TelemetryApprovalResolutionKind,
  type TelemetryApprovalReviewer,
  type TelemetryRecord,
  type TelemetryRecordName,
  type TelemetrySandboxEnforcement,
  type TelemetrySandboxOutcome,
} from "./TelemetryRecord.js";

type RecordValue = Readonly<Record<string, unknown>>;

export function createTelemetryRecord<TName extends TelemetryRecordName>(
  input: CreateTelemetryRecordInput<TName>,
): TelemetryRecord<TName> {
  const source = record(input, "TelemetryRecord");
  const eventName = literal(
    source.eventName,
    telemetryRecordNames,
    "TelemetryRecord.eventName",
  );
  const base = {
    schemaVersion: TELEMETRY_RECORD_SCHEMA_VERSION,
    id: text(source.id, "TelemetryRecord.id"),
    runId: text(source.runId, "TelemetryRecord.runId"),
    taskId: text(source.taskId, "TelemetryRecord.taskId"),
    eventName,
    timestamp: timestamp(source.timestamp, "TelemetryRecord.timestamp"),
  };
  return Object.freeze({
    ...base,
    ...snapshotMeasurements(eventName, source),
  }) as TelemetryRecord<TName>;
}

function snapshotMeasurements(
  eventName: TelemetryRecordName,
  source: RecordValue,
): RecordValue {
  const counters = record(source.counters, "TelemetryRecord.counters");
  const dimensions = record(source.dimensions, "TelemetryRecord.dimensions");
  switch (eventName) {
    case "runner.run.started":
      return runLifecycleMeasurements(source, counters, dimensions, "started");
    case "runner.run.succeeded":
      return runLifecycleMeasurements(source, counters, dimensions, "succeeded");
    case "runner.run.blocked":
      return runLifecycleMeasurements(source, counters, dimensions, "blocked");
    case "runner.run.failed":
      return runLifecycleMeasurements(source, counters, dimensions, "failed");
    case "runner.run.cancelled":
      return runLifecycleMeasurements(source, counters, dimensions, "cancelled");
    case "runner.approval.resolved":
      if (source.durationMs !== null) {
        throw new TypeError(
          "TelemetryRecord.durationMs must be null for runner.approval.resolved.",
        );
      }
      return Object.freeze({
        durationMs: null,
        counters: Object.freeze({
          requests: nonNegativeInteger(counters.requests, "counters.requests"),
          consecutiveDeclines: nonNegativeInteger(
            counters.consecutiveDeclines,
            "counters.consecutiveDeclines",
          ),
          consecutiveReviewFailures: nonNegativeInteger(
            counters.consecutiveReviewFailures,
            "counters.consecutiveReviewFailures",
          ),
          authorityRecords: nonNegativeInteger(
            counters.authorityRecords,
            "counters.authorityRecords",
          ),
        }),
        dimensions: Object.freeze({
          reviewer: literal(
            dimensions.reviewer,
            telemetryApprovalReviewers,
            "dimensions.reviewer",
          ),
          resolutionKind: literal(
            dimensions.resolutionKind,
            telemetryApprovalResolutionKinds,
            "dimensions.resolutionKind",
          ),
          decisionKind: nullableLiteral(
            dimensions.decisionKind,
            telemetryApprovalDecisionKinds,
            "dimensions.decisionKind",
          ),
          applicationKind: literal(
            dimensions.applicationKind,
            telemetryApprovalApplicationKinds,
            "dimensions.applicationKind",
          ),
          code: nullableText(dimensions.code, "dimensions.code"),
        }),
      });
    case "runner.sandbox.attempt.started":
      if (source.durationMs !== 0) {
        throw new TypeError(
          "TelemetryRecord.durationMs must be zero for a started Sandbox attempt.",
        );
      }
      return Object.freeze({
        durationMs: 0,
        counters: sandboxAttemptCounters(counters),
        dimensions: Object.freeze({
          phase: literal(dimensions.phase, ["started"], "dimensions.phase"),
          enforcement: literal(
            dimensions.enforcement,
            telemetrySandboxEnforcements,
            "dimensions.enforcement",
          ),
          outcome: literal(dimensions.outcome, ["started"], "dimensions.outcome"),
        }),
      });
    case "runner.sandbox.attempt.resolved":
      return Object.freeze({
        durationMs: nonNegativeNumber(source.durationMs, "TelemetryRecord.durationMs"),
        counters: sandboxAttemptCounters(counters),
        dimensions: Object.freeze({
          phase: literal(dimensions.phase, ["resolved"], "dimensions.phase"),
          enforcement: literal(
            dimensions.enforcement,
            telemetrySandboxEnforcements,
            "dimensions.enforcement",
          ),
          outcome: literal(
            dimensions.outcome,
            telemetrySandboxOutcomes,
            "dimensions.outcome",
          ),
        }),
      });
  }
}

function runLifecycleMeasurements(
  source: RecordValue,
  counters: RecordValue,
  dimensions: RecordValue,
  status: "started" | "succeeded" | "blocked" | "failed" | "cancelled",
): RecordValue {
  return Object.freeze({
    durationMs: nonNegativeNumber(source.durationMs, "TelemetryRecord.durationMs"),
    counters: Object.freeze({
      iterations: nonNegativeInteger(counters.iterations, "counters.iterations"),
      actions: nonNegativeInteger(counters.actions, "counters.actions"),
      items: nonNegativeInteger(counters.items, "counters.items"),
    }),
    dimensions: Object.freeze({
      status: literal(dimensions.status, [status], "dimensions.status"),
      agentId: text(dimensions.agentId, "dimensions.agentId"),
    }),
  });
}

function sandboxAttemptCounters(source: RecordValue): RecordValue {
  return Object.freeze({
    ordinal: literal(source.ordinal, [1, 2], "counters.ordinal"),
  });
}

function record(value: unknown, name: string): RecordValue {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object.`);
  }
  return value as RecordValue;
}

function text(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${name} must be a non-empty string.`);
  }
  return value;
}

function nullableText(value: unknown, name: string): string | null {
  return value === null ? null : text(value, name);
}

function timestamp(value: unknown, name: string): string {
  const result = text(value, name);
  if (!Number.isFinite(Date.parse(result))) {
    throw new TypeError(`${name} must be a valid ISO date-time string.`);
  }
  return result;
}

function nonNegativeNumber(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative finite number.`);
  }
  return value;
}

function nonNegativeInteger(value: unknown, name: string): number {
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new TypeError(`${name} must be a non-negative integer.`);
  }
  return value as number;
}

function literal<T extends string | number>(
  value: unknown,
  allowed: readonly T[],
  name: string,
): T {
  if (!allowed.includes(value as T)) {
    throw new TypeError(`${name} is unsupported.`);
  }
  return value as T;
}

function nullableLiteral<T extends string | number>(
  value: unknown,
  allowed: readonly T[],
  name: string,
): T | null {
  return value === null ? null : literal(value, allowed, name);
}

const telemetryRecordNames = Object.freeze([
  "runner.run.started",
  "runner.run.succeeded",
  "runner.run.blocked",
  "runner.run.failed",
  "runner.run.cancelled",
  "runner.approval.resolved",
  "runner.sandbox.attempt.started",
  "runner.sandbox.attempt.resolved",
] as const satisfies readonly TelemetryRecordName[]);

const telemetryApprovalReviewers = Object.freeze([
  "user",
  "auto_review",
] as const satisfies readonly TelemetryApprovalReviewer[]);

const telemetryApprovalResolutionKinds = Object.freeze([
  "decision",
  "review_failure",
  "request_failure",
  "run_cancelled",
] as const satisfies readonly TelemetryApprovalResolutionKind[]);

const telemetryApprovalDecisionKinds = Object.freeze([
  "accept",
  "acceptForSession",
  "grantPermissions",
  "acceptWithExecpolicyAmendment",
  "applyNetworkPolicyAmendment",
  "decline",
  "cancel",
] as const satisfies readonly TelemetryApprovalDecisionKind[]);

const telemetryApprovalApplicationKinds = Object.freeze([
  "not_applicable",
  "applied",
  "not_applied",
  "interrupted",
  "outcome_unknown",
] as const satisfies readonly TelemetryApprovalApplicationKind[]);

const telemetrySandboxEnforcements = Object.freeze([
  "managed",
  "external",
  "disabled",
] as const satisfies readonly TelemetrySandboxEnforcement[]);

const telemetrySandboxOutcomes = Object.freeze([
  "executed",
  "sandbox_denied",
  "sandbox_unavailable",
  "interrupted",
  "failed",
] as const satisfies readonly TelemetrySandboxOutcome[]);
