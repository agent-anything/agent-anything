import type { IdentityKind } from "@agent-anything/agent-core/run";
import {
  AUDIT_RECORD_SCHEMA_VERSION,
  type AuditActor,
  type AuditApprovalApplicationKind,
  type AuditApprovalCategory,
  type AuditApprovalDecisionKind,
  type AuditApprovalResolutionKind,
  type AuditApprovalReviewer,
  type AuditOutcome,
  type AuditRecord,
  type AuditRecordName,
  type AuditSandboxEnforcement,
  type AuditSandboxOutcome,
  type AuditSubject,
  type CreateAuditRecordInput,
} from "./AuditRecord.js";

type RecordValue = Readonly<Record<string, unknown>>;

export function createAuditRecord<TName extends AuditRecordName>(
  input: CreateAuditRecordInput<TName>,
): AuditRecord<TName> {
  const source = record(input, "AuditRecord");
  const eventName = literal(
    source.eventName,
    auditRecordNames,
    "AuditRecord.eventName",
  );
  const base = {
    schemaVersion: AUDIT_RECORD_SCHEMA_VERSION,
    id: text(source.id, "AuditRecord.id"),
    runId: text(source.runId, "AuditRecord.runId"),
    taskId: text(source.taskId, "AuditRecord.taskId"),
    eventName,
    timestamp: timestamp(source.timestamp, "AuditRecord.timestamp"),
    actor: actor(source.actor, "AuditRecord.actor"),
    workspaceId: nullableText(source.workspaceId, "AuditRecord.workspaceId"),
    subject: subject(source.subject, "AuditRecord.subject"),
  };
  const contract = snapshotContract(eventName, source, base.runId);
  return Object.freeze({
    ...base,
    ...contract,
  }) as AuditRecord<TName>;
}

function snapshotContract(
  eventName: AuditRecordName,
  source: RecordValue,
  runId: string,
): RecordValue {
  const target = record(source.target, "AuditRecord.target");
  const payload = record(source.payload, "AuditRecord.payload");
  switch (eventName) {
    case "run.started":
      return runLifecycleContract(source, target, payload, runId, "started", "succeeded");
    case "run.succeeded":
      return runLifecycleContract(source, target, payload, runId, "succeeded", "succeeded");
    case "run.failed":
      return runLifecycleContract(source, target, payload, runId, "failed", "failed");
    case "run.cancelled":
      return runLifecycleContract(source, target, payload, runId, "cancelled", "cancelled");
    case "approval.requested":
      return Object.freeze({
        action: literal(source.action, ["approval.requested"], "AuditRecord.action"),
        target: approvalTarget(target, false),
        outcome: literal(source.outcome, ["succeeded"], "AuditRecord.outcome"),
        payload: Object.freeze({
          pendingVersion: positiveInteger(payload.pendingVersion, "payload.pendingVersion"),
          optionIds: textArray(payload.optionIds, "payload.optionIds"),
        }),
      });
    case "approval.decision_validated":
      return Object.freeze({
        action: literal(
          source.action,
          ["approval.decision_validated"],
          "AuditRecord.action",
        ),
        target: approvalTarget(target, false),
        outcome: literal(source.outcome, ["succeeded"], "AuditRecord.outcome"),
        payload: Object.freeze({
          pendingVersion: positiveInteger(payload.pendingVersion, "payload.pendingVersion"),
          optionIds: textArray(payload.optionIds, "payload.optionIds"),
          decisionKind: literal(
            payload.decisionKind,
            auditApprovalDecisionKinds,
            "payload.decisionKind",
          ),
        }),
      });
    case "approval.resolved":
      return Object.freeze({
        action: literal(source.action, ["approval.resolved"], "AuditRecord.action"),
        target: approvalTarget(target, true),
        outcome: literal(source.outcome, auditOutcomes, "AuditRecord.outcome"),
        payload: Object.freeze({
          pendingVersion: positiveInteger(payload.pendingVersion, "payload.pendingVersion"),
          reviewer: literal(
            payload.reviewer,
            auditApprovalReviewers,
            "payload.reviewer",
          ),
          resolutionKind: literal(
            payload.resolutionKind,
            auditApprovalResolutionKinds,
            "payload.resolutionKind",
          ),
          decisionKind: nullableLiteral(
            payload.decisionKind,
            auditApprovalDecisionKinds,
            "payload.decisionKind",
          ),
          applicationKind: literal(
            payload.applicationKind,
            auditApprovalApplicationKinds,
            "payload.applicationKind",
          ),
          code: nullableText(payload.code, "payload.code"),
          authorityRecordIds: textArray(
            payload.authorityRecordIds,
            "payload.authorityRecordIds",
          ),
        }),
      });
    case "action.dispatch_authorized":
      return Object.freeze({
        action: literal(
          source.action,
          ["action.dispatch_authorized"],
          "AuditRecord.action",
        ),
        target: actionTarget(target),
        outcome: literal(source.outcome, ["succeeded"], "AuditRecord.outcome"),
        payload: Object.freeze({
          authoritySnapshotId: text(
            payload.authoritySnapshotId,
            "payload.authoritySnapshotId",
          ),
          actionCoverageId: nullableText(
            payload.actionCoverageId,
            "payload.actionCoverageId",
          ),
          enforcement: literal(
            payload.enforcement,
            auditSandboxEnforcements,
            "payload.enforcement",
          ),
          attemptOrdinal: literal(
            payload.attemptOrdinal,
            [1, 2],
            "payload.attemptOrdinal",
          ),
          dispatchPlanFingerprint: text(
            payload.dispatchPlanFingerprint,
            "payload.dispatchPlanFingerprint",
          ),
        }),
      });
    case "sandbox.attempt.started":
      return Object.freeze({
        action: literal(
          source.action,
          ["sandbox.attempt.started"],
          "AuditRecord.action",
        ),
        target: sandboxAttemptTarget(target),
        outcome: literal(source.outcome, ["succeeded"], "AuditRecord.outcome"),
        payload: sandboxAttemptPayload(payload, false),
      });
    case "sandbox.attempt.resolved":
      return Object.freeze({
        action: literal(
          source.action,
          ["sandbox.attempt.resolved"],
          "AuditRecord.action",
        ),
        target: sandboxAttemptTarget(target),
        outcome: literal(
          source.outcome,
          ["succeeded", "failed", "cancelled"],
          "AuditRecord.outcome",
        ),
        payload: sandboxAttemptPayload(payload, true),
      });
  }
}

function runLifecycleContract(
  source: RecordValue,
  target: RecordValue,
  payload: RecordValue,
  runId: string,
  status: "started" | "succeeded" | "failed" | "cancelled",
  outcome: AuditOutcome,
): RecordValue {
  const targetSnapshot = Object.freeze({
    kind: literal(target.kind, ["run"], "target.kind"),
    id: text(target.id, "target.id"),
  });
  if (targetSnapshot.id !== runId) {
    throw new TypeError("AuditRecord Run target must match AuditRecord.runId.");
  }
  return Object.freeze({
    action: literal(source.action, [`runner.${status}`], "AuditRecord.action"),
    target: targetSnapshot,
    outcome: literal(source.outcome, [outcome], "AuditRecord.outcome"),
    payload: Object.freeze({
      status: literal(payload.status, [status], "payload.status"),
      activeAgentId: text(payload.activeAgentId, "payload.activeAgentId"),
      iterations: nonNegativeInteger(payload.iterations, "payload.iterations"),
      actions: nonNegativeInteger(payload.actions, "payload.actions"),
      itemCount: nonNegativeInteger(payload.itemCount, "payload.itemCount"),
    }),
  });
}

function approvalTarget(source: RecordValue, categoryNullable: boolean): RecordValue {
  const category = categoryNullable
    ? nullableLiteral(source.category, auditApprovalCategories, "target.category")
    : literal(source.category, auditApprovalCategories, "target.category");
  return Object.freeze({
    kind: literal(source.kind, ["approval_request"], "target.kind"),
    id: text(source.id, "target.id"),
    actionId: text(source.actionId, "target.actionId"),
    category,
  });
}

function actionTarget(source: RecordValue): RecordValue {
  return Object.freeze({
    kind: literal(source.kind, ["action"], "target.kind"),
    id: text(source.id, "target.id"),
    actionName: text(source.actionName, "target.actionName"),
    actionFingerprint: text(
      source.actionFingerprint,
      "target.actionFingerprint",
    ),
  });
}

function sandboxAttemptTarget(source: RecordValue): RecordValue {
  return Object.freeze({
    kind: literal(source.kind, ["sandbox_attempt"], "target.kind"),
    id: text(source.id, "target.id"),
    actionId: text(source.actionId, "target.actionId"),
  });
}

function sandboxAttemptPayload(
  source: RecordValue,
  resolved: boolean,
): RecordValue {
  const base = {
    actionFingerprint: text(source.actionFingerprint, "payload.actionFingerprint"),
    ordinal: literal(source.ordinal, [1, 2], "payload.ordinal"),
    enforcement: literal(
      source.enforcement,
      auditSandboxEnforcements,
      "payload.enforcement",
    ),
    policyId: text(source.policyId, "payload.policyId"),
    authoritySnapshotId: text(
      source.authoritySnapshotId,
      "payload.authoritySnapshotId",
    ),
    dispatchPlanFingerprint: text(
      source.dispatchPlanFingerprint,
      "payload.dispatchPlanFingerprint",
    ),
  };
  if (!resolved) {
    return Object.freeze(base);
  }
  return Object.freeze({
    ...base,
    outcome: literal(source.outcome, auditSandboxOutcomes, "payload.outcome"),
    code: nullableText(source.code, "payload.code"),
    effectState: nullableLiteral(
      source.effectState,
      ["none", "unknown"],
      "payload.effectState",
    ),
  });
}

function actor(value: unknown, name: string): AuditActor {
  const source = record(value, name);
  return Object.freeze({
    kind: identityKind(source.kind, `${name}.kind`),
    id: text(source.id, `${name}.id`),
  });
}

function subject(value: unknown, name: string): AuditSubject {
  const source = record(value, name);
  return Object.freeze({
    kind: identityKind(source.kind, `${name}.kind`),
    id: text(source.id, `${name}.id`),
  });
}

function identityKind(value: unknown, name: string): IdentityKind {
  return literal(value, ["user", "service", "anonymous"], name);
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

function nonNegativeInteger(value: unknown, name: string): number {
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new TypeError(`${name} must be a non-negative integer.`);
  }
  return value as number;
}

function positiveInteger(value: unknown, name: string): number {
  if (!Number.isInteger(value) || (value as number) <= 0) {
    throw new TypeError(`${name} must be a positive integer.`);
  }
  return value as number;
}

function textArray(value: unknown, name: string): readonly string[] {
  if (!Array.isArray(value)) {
    throw new TypeError(`${name} must be an array.`);
  }
  return Object.freeze(value.map((entry, index) => text(entry, `${name}[${index}]`)));
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

const auditRecordNames = Object.freeze([
  "run.started",
  "run.succeeded",
  "run.failed",
  "run.cancelled",
  "approval.requested",
  "approval.decision_validated",
  "approval.resolved",
  "action.dispatch_authorized",
  "sandbox.attempt.started",
  "sandbox.attempt.resolved",
] as const satisfies readonly AuditRecordName[]);

const auditOutcomes = Object.freeze([
  "succeeded",
  "failed",
  "cancelled",
] as const satisfies readonly AuditOutcome[]);

const auditApprovalCategories = Object.freeze([
  "commandExecution",
  "fileChange",
  "permissions",
  "remoteToolCall",
  "skill",
  "networkAccess",
] as const satisfies readonly AuditApprovalCategory[]);

const auditApprovalDecisionKinds = Object.freeze([
  "accept",
  "acceptForSession",
  "grantPermissions",
  "acceptWithExecpolicyAmendment",
  "applyNetworkPolicyAmendment",
  "decline",
  "cancel",
] as const satisfies readonly AuditApprovalDecisionKind[]);

const auditApprovalReviewers = Object.freeze([
  "user",
  "auto_review",
] as const satisfies readonly AuditApprovalReviewer[]);

const auditApprovalResolutionKinds = Object.freeze([
  "decision",
  "review_failure",
  "request_failure",
  "run_cancelled",
] as const satisfies readonly AuditApprovalResolutionKind[]);

const auditApprovalApplicationKinds = Object.freeze([
  "not_applicable",
  "applied",
  "not_applied",
  "interrupted",
  "outcome_unknown",
] as const satisfies readonly AuditApprovalApplicationKind[]);

const auditSandboxEnforcements = Object.freeze([
  "managed",
  "external",
  "disabled",
] as const satisfies readonly AuditSandboxEnforcement[]);

const auditSandboxOutcomes = Object.freeze([
  "executed",
  "sandbox_denied",
  "sandbox_unavailable",
  "interrupted",
  "failed",
] as const satisfies readonly AuditSandboxOutcome[]);
