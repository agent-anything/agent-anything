import type { InvocationInterruptionRef, Metadata } from "@agent-anything/shared";
import type {
  AdditionalPermissions,
  CanonicalAdditionalPermissions,
} from "./PermissionDelta.js";
import type {
  ApprovalDecisionKind,
  ApprovalDecisionOptionProjection,
  ApprovalDecisionSubmission,
  CommandActionSummary,
  FileChangeApprovalChange,
  ApprovalReviewFailure,
  ApprovalReviewInput,
  ApprovalReviewPayloadByCategory,
  ApprovalReviewRequest,
} from "./ApprovalContracts.js";
import type {
  ApprovalReviewerDescriptor,
  ApprovalsReviewer,
} from "./ApprovalPolicy.js";
import { ApprovalContractError } from "./ApprovalContractError.js";
import {
  cloneApprovalMetadata,
  deepFreezeApproval,
} from "./snapshot.js";

const DECISION_KINDS: readonly ApprovalDecisionKind[] = [
  "accept",
  "acceptForSession",
  "grantPermissions",
  "acceptWithExecpolicyAmendment",
  "applyNetworkPolicyAmendment",
  "decline",
  "cancel",
];

const REVIEW_FAILURE_CODES: readonly ApprovalReviewFailure["code"][] = [
  "approval_reviewer_unavailable",
  "approval_review_timeout",
  "approval_review_failed",
  "approval_review_malformed",
  "approval_review_retry_exhausted",
];

export function snapshotApprovalReviewerDescriptor(
  descriptor: ApprovalReviewerDescriptor,
  expectedKind?: ApprovalsReviewer,
): ApprovalReviewerDescriptor {
  if (!isRecord(descriptor)) invalid("Approval reviewer descriptor must be an object.");
  assertIdentity(descriptor.id, "reviewer id");
  if (descriptor.kind !== "user" && descriptor.kind !== "auto_review") {
    invalid("Approval reviewer kind is unsupported.");
  }
  if (expectedKind !== undefined && descriptor.kind !== expectedKind) {
    invalid(`Approval reviewer kind must be '${expectedKind}'.`);
  }
  assertNonEmptyText(descriptor.displayName, "reviewer displayName");
  assertNonEmptyText(descriptor.source, "reviewer source");
  return deepFreezeApproval({
    id: descriptor.id,
    kind: descriptor.kind,
    displayName: descriptor.displayName,
    source: descriptor.source,
    metadata: cloneApprovalMetadata(descriptor.metadata),
  });
}

export function snapshotApprovalReviewInput(
  input: ApprovalReviewInput,
): ApprovalReviewInput {
  if (!isRecord(input)) invalid("Approval review input must be an object.");
  assertPositiveInteger(input.pendingVersion, "pendingVersion");
  const request = snapshotReviewRequest(input.request);
  const context = input.context;
  if (!isRecord(context) || !isRecord(context.currentAuthority)) {
    invalid("Approval review context is malformed.");
  }
  if (
    context.workspaceTrustState !== null &&
    context.workspaceTrustState !== "trusted" &&
    context.workspaceTrustState !== "restricted" &&
    context.workspaceTrustState !== "unknown"
  ) {
    invalid("Approval review workspace trust state is unsupported.");
  }
  if (!["allow", "prompt", "forbidden", "none"].includes(context.ruleOutcome)) {
    invalid("Approval review Rule outcome is unsupported.");
  }
  for (const field of ["fileSystemRead", "fileSystemWrite", "network"] as const) {
    if (typeof context.currentAuthority[field] !== "boolean") {
      invalid(`Approval review authority ${field} must be boolean.`);
    }
  }
  return deepFreezeApproval({
    request,
    pendingVersion: input.pendingVersion,
    context: {
      workspaceTrustState: context.workspaceTrustState,
      ruleOutcome: context.ruleOutcome,
      currentAuthority: {
        fileSystemRead: context.currentAuthority.fileSystemRead,
        fileSystemWrite: context.currentAuthority.fileSystemWrite,
        network: context.currentAuthority.network,
      },
      annotations: cloneApprovalMetadata(context.annotations),
    },
  });
}

export function snapshotApprovalDecisionSubmission(
  submission: ApprovalDecisionSubmission,
): ApprovalDecisionSubmission {
  if (!isRecord(submission)) invalid("Approval submission must be an object.");
  assertIdentity(submission.submissionId, "submission id");
  assertIdentity(submission.runId, "submission run id");
  assertIdentity(submission.requestId, "submission request id");
  assertPositiveInteger(submission.pendingVersion, "submission pendingVersion");
  assertIdentity(submission.optionId, "submission option id");
  if (submission.reason !== null && typeof submission.reason !== "string") {
    invalid("Approval submission reason must be text or null.");
  }
  return deepFreezeApproval({
    submissionId: submission.submissionId,
    runId: submission.runId,
    requestId: submission.requestId,
    pendingVersion: submission.pendingVersion,
    optionId: submission.optionId,
    grantedPermissions: snapshotAdditionalPermissions(submission.grantedPermissions),
    reason: submission.reason,
  });
}

export function snapshotApprovalReviewFailure(
  failure: ApprovalReviewFailure,
): ApprovalReviewFailure {
  if (!isRecord(failure) || !REVIEW_FAILURE_CODES.includes(failure.code)) {
    invalid("Approval review failure is malformed.");
  }
  assertNonEmptyText(failure.message, "review failure message");
  if (typeof failure.retryable !== "boolean") {
    invalid("Approval review failure retryable must be boolean.");
  }
  return deepFreezeApproval({
    code: failure.code,
    message: failure.message,
    retryable: failure.retryable,
    metadata: cloneApprovalMetadata(failure.metadata),
  });
}

export function snapshotApprovalInterruption(
  interruption: InvocationInterruptionRef,
): InvocationInterruptionRef {
  if (!isRecord(interruption)) invalid("Approval interruption is malformed.");
  if (interruption.kind === "run_cancellation") {
    if (!isRecord(interruption.cancellation)) invalid("Run cancellation is malformed.");
    assertIdentity(interruption.cancellation.runId, "cancellation run id");
    assertIdentity(interruption.cancellation.requestId, "cancellation request id");
    return Object.freeze({
      kind: "run_cancellation",
      cancellation: Object.freeze({
        runId: interruption.cancellation.runId,
        requestId: interruption.cancellation.requestId,
      }),
    });
  }
  if (interruption.kind === "operation_deadline") {
    if (!isRecord(interruption.deadline)) invalid("Operation deadline is malformed.");
    assertIdentity(interruption.deadline.operationId, "deadline operation id");
    assertDateTime(interruption.deadline.deadlineAt, "deadlineAt");
    return Object.freeze({
      kind: "operation_deadline",
      deadline: Object.freeze({ ...interruption.deadline }),
    });
  }
  return invalid("Approval interruption kind is unsupported.");
}

function snapshotReviewRequest(request: ApprovalReviewRequest): ApprovalReviewRequest {
  if (!isRecord(request) || !isRecord(request.subject)) {
    invalid("Approval review request is malformed.");
  }
  assertIdentity(request.id, "review request id");
  assertIdentity(request.runId, "review run id");
  assertIdentity(request.actionId, "review action id");
  assertIdentity(request.actionFingerprint, "review action fingerprint");
  assertIdentity(request.subject.environmentId, "review environment id");
  if (
    request.subject.runId !== request.runId ||
    request.subject.actionId !== request.actionId ||
    request.subject.actionFingerprint !== request.actionFingerprint
  ) {
    invalid("Approval review subject correlation is inconsistent.");
  }
  assertNonNegativeInteger(
    request.subject.applicabilityKeyCount,
    "subject applicabilityKeyCount",
  );
  assertNonEmptyText(request.reason, "review reason");
  assertDateTime(request.createdAt, "review createdAt");
  assertDateTime(request.deadlineAt, "review deadlineAt");
  if (Date.parse(request.deadlineAt) <= Date.parse(request.createdAt)) {
    invalid("Approval review deadline must be later than createdAt.");
  }
  if (!Array.isArray(request.decisionOptions) || request.decisionOptions.length === 0) {
    invalid("Approval review request requires decision options.");
  }
  const optionIds = new Set<string>();
  const decisionOptions = request.decisionOptions.map((option) => {
    const snapshot = snapshotDecisionOption(option);
    if (!isCompatibleProjectedOption(request.category, snapshot)) {
      invalid(`Approval option '${snapshot.id}' is incompatible with '${request.category}'.`);
    }
    if (optionIds.has(snapshot.id)) invalid(`Approval option '${snapshot.id}' is duplicated.`);
    optionIds.add(snapshot.id);
    return snapshot;
  }) as [ApprovalDecisionOptionProjection, ...ApprovalDecisionOptionProjection[]];

  return deepFreezeApproval({
    id: request.id,
    runId: request.runId,
    actionId: request.actionId,
    actionFingerprint: request.actionFingerprint,
    category: request.category,
    reason: request.reason,
    subject: {
      runId: request.subject.runId,
      actionId: request.subject.actionId,
      actionFingerprint: request.subject.actionFingerprint,
      environmentId: request.subject.environmentId,
      applicabilityKeyCount: request.subject.applicabilityKeyCount,
    },
    payload: snapshotReviewPayload(request),
    decisionOptions,
    createdAt: request.createdAt,
    deadlineAt: request.deadlineAt,
  } as ApprovalReviewRequest);
}

function snapshotDecisionOption(
  option: ApprovalDecisionOptionProjection,
): ApprovalDecisionOptionProjection {
  if (!isRecord(option)) invalid("Approval decision option is malformed.");
  assertIdentity(option.id, "option id");
  if (!DECISION_KINDS.includes(option.kind)) invalid("Approval option kind is unsupported.");
  if (
    option.scope !== null &&
    option.scope !== "action" &&
    option.scope !== "run" &&
    option.scope !== "session" &&
    option.scope !== "persistent"
  ) {
    invalid("Approval option scope is unsupported.");
  }
  assertNonEmptyText(option.label, "option label");
  if (option.description !== null && typeof option.description !== "string") {
    invalid("Approval option description must be text or null.");
  }
  return Object.freeze({
    id: option.id,
    kind: option.kind,
    scope: option.scope,
    label: option.label,
    description: option.description,
  });
}

function snapshotReviewPayload(
  request: ApprovalReviewRequest,
): ApprovalReviewPayloadByCategory[keyof ApprovalReviewPayloadByCategory] {
  if (!isRecord(request.payload)) invalid("Approval review payload must be an object.");
  switch (request.category) {
    case "commandExecution": {
      const payload = request.payload as ApprovalReviewPayloadByCategory["commandExecution"];
      assertText(payload.commandDisplay, "commandDisplay");
      assertText(payload.cwdDisplay, "cwdDisplay");
      if (!Array.isArray(payload.commandActions)) invalid("commandActions must be an array.");
      return {
        commandDisplay: payload.commandDisplay,
        cwdDisplay: payload.cwdDisplay,
        commandActions: payload.commandActions.map((action) => {
          if (
            !isRecord(action) ||
            typeof action.kind !== "string" ||
            !["read", "write", "network", "process", "unknown"].includes(action.kind)
          ) {
            return invalid("Command action summary is malformed.");
          }
          assertNonEmptyText(action.summary, "command action summary");
          return {
            kind: action.kind as CommandActionSummary["kind"],
            summary: action.summary,
          };
        }),
        additionalPermissions: snapshotCanonicalPermissions(payload.additionalPermissions),
      };
    }
    case "fileChange": {
      const payload = request.payload as ApprovalReviewPayloadByCategory["fileChange"];
      if (!Array.isArray(payload.changes) || payload.changes.length === 0) {
        invalid("File change review requires changes.");
      }
      assertIdentity(payload.baselineFingerprint, "file change baseline fingerprint");
      return {
        changes: payload.changes.map((change) => {
          if (
            !isRecord(change) ||
            typeof change.operation !== "string" ||
            !["create", "update", "delete", "move", "copy"].includes(change.operation)
          ) {
            return invalid("File change review entry is malformed.");
          }
          assertText(change.displayPath, "file change displayPath");
          if (change.destinationDisplayPath !== null) {
            assertText(change.destinationDisplayPath, "file change destinationDisplayPath");
          }
          return {
            operation: change.operation as FileChangeApprovalChange["operation"],
            displayPath: change.displayPath,
            destinationDisplayPath: change.destinationDisplayPath,
          };
        }),
        baselineFingerprint: payload.baselineFingerprint,
        additionalPermissions: snapshotCanonicalPermissions(payload.additionalPermissions),
      };
    }
    case "permissions": {
      const payload = request.payload as ApprovalReviewPayloadByCategory["permissions"];
      assertText(payload.cwdDisplay, "permissions cwdDisplay");
      assertIdentity(payload.environmentId, "permissions environmentId");
      return {
        permissions: snapshotCanonicalPermissions(payload.permissions, false)!,
        cwdDisplay: payload.cwdDisplay,
        environmentId: payload.environmentId,
      };
    }
    case "mcpToolCall": {
      const payload = request.payload as ApprovalReviewPayloadByCategory["mcpToolCall"];
      assertIdentity(payload.serverId, "MCP server id");
      assertNonEmptyText(payload.serverDisplayName, "MCP server displayName");
      assertIdentity(payload.toolName, "MCP tool name");
      if (!isRecord(payload.annotations)) invalid("MCP annotations are malformed.");
      return {
        serverId: payload.serverId,
        serverDisplayName: payload.serverDisplayName,
        toolName: payload.toolName,
        safeArguments: cloneApprovalMetadata(payload.safeArguments as Metadata),
        annotations: {
          readOnlyHint: snapshotNullableBoolean(payload.annotations.readOnlyHint, "readOnlyHint"),
          destructiveHint: snapshotNullableBoolean(payload.annotations.destructiveHint, "destructiveHint"),
          idempotentHint: snapshotNullableBoolean(payload.annotations.idempotentHint, "idempotentHint"),
          openWorldHint: snapshotNullableBoolean(payload.annotations.openWorldHint, "openWorldHint"),
        },
        supportsSessionAuthority: assertBoolean(payload.supportsSessionAuthority, "supportsSessionAuthority"),
      };
    }
    case "skill": {
      const payload = request.payload as ApprovalReviewPayloadByCategory["skill"];
      assertIdentity(payload.skillId, "skill id");
      assertNonEmptyText(payload.skillDisplayName, "skill displayName");
      assertNonEmptyText(payload.action, "skill action");
      return {
        skillId: payload.skillId,
        skillDisplayName: payload.skillDisplayName,
        action: payload.action,
        requiredPermissions: snapshotCanonicalPermissions(payload.requiredPermissions),
      };
    }
    case "networkAccess": {
      const payload = request.payload as ApprovalReviewPayloadByCategory["networkAccess"];
      assertNonEmptyText(payload.host, "network host");
      if (payload.port !== null && (!Number.isSafeInteger(payload.port) || payload.port < 1 || payload.port > 65_535)) {
        invalid("Network port is invalid.");
      }
      if (payload.protocol !== null) assertNonEmptyText(payload.protocol, "network protocol");
      assertNonEmptyText(payload.actionSummary, "network action summary");
      return {
        host: payload.host,
        port: payload.port,
        protocol: payload.protocol,
        actionSummary: payload.actionSummary,
      };
    }
    default:
      return invalid("Approval review category is unsupported.");
  }
}

function snapshotCanonicalPermissions(
  permissions: unknown,
  nullable = true,
): CanonicalAdditionalPermissions | null {
  if (permissions === null && nullable) return null;
  const snapshot = snapshotAdditionalPermissions(
    permissions as AdditionalPermissions,
  ) as CanonicalAdditionalPermissions;
  if (snapshot.network !== undefined && snapshot.network.enabled !== true) {
    invalid("Canonical additional permissions cannot contain disabled network state.");
  }
  return snapshot;
}

function isCompatibleProjectedOption(
  category: ApprovalReviewRequest["category"],
  option: ApprovalDecisionOptionProjection,
): boolean {
  switch (option.kind) {
    case "accept":
      return category !== "permissions" && option.scope === "action";
    case "acceptForSession":
      return category !== "permissions" && option.scope === "session";
    case "grantPermissions":
      return (
        category === "permissions" ||
        category === "commandExecution" ||
        category === "fileChange" ||
        category === "skill" ||
        category === "networkAccess"
      ) && (option.scope === "run" || option.scope === "session");
    case "acceptWithExecpolicyAmendment":
      return category === "commandExecution" && option.scope === "persistent";
    case "applyNetworkPolicyAmendment":
      return (
        category === "commandExecution" || category === "networkAccess"
      ) && option.scope === "persistent";
    case "decline":
    case "cancel":
      return option.scope === null;
  }
}

function snapshotAdditionalPermissions(
  permissions: AdditionalPermissions | null,
): AdditionalPermissions | null {
  if (permissions === null) return null;
  if (!isRecord(permissions)) invalid("Additional permissions must be an object or null.");
  const fileSystem = permissions.fileSystem;
  const network = permissions.network;
  if (fileSystem !== undefined && !isRecord(fileSystem)) {
    invalid("Additional filesystem permissions are malformed.");
  }
  if (network !== undefined && !isRecord(network)) {
    invalid("Additional network permissions are malformed.");
  }
  const typedFileSystem = fileSystem as AdditionalPermissions["fileSystem"];
  const typedNetwork = network as AdditionalPermissions["network"];
  const read = snapshotStringSet(typedFileSystem?.read, "filesystem read permissions");
  const write = snapshotStringSet(typedFileSystem?.write, "filesystem write permissions");
  const domains = snapshotStringSet(typedNetwork?.domains, "network domains");
  if (network !== undefined && typeof network.enabled !== "boolean") {
    invalid("Additional network enabled must be boolean.");
  }
  return deepFreezeApproval({
    ...(fileSystem === undefined
      ? {}
      : {
          fileSystem: {
            ...(read === undefined ? {} : { read }),
            ...(write === undefined ? {} : { write }),
          },
        }),
    ...(network === undefined
      ? {}
      : {
          network: {
            enabled: typedNetwork!.enabled,
            ...(domains === undefined ? {} : { domains }),
          },
        }),
  });
}

function snapshotStringSet(
  values: readonly string[] | undefined,
  field: string,
): readonly string[] | undefined {
  if (values === undefined) return undefined;
  if (!Array.isArray(values)) invalid(`${field} must be an array.`);
  for (const value of values) assertNonEmptyText(value, field);
  return Object.freeze([...new Set(values)].sort((left, right) => left.localeCompare(right)));
}

function snapshotNullableBoolean(value: unknown, field: string): boolean | null {
  if (value !== null && typeof value !== "boolean") invalid(`${field} must be boolean or null.`);
  return value;
}

function assertBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") invalid(`${field} must be boolean.`);
  return value;
}

function assertIdentity(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || /\s/.test(value)) {
    invalid(`Approval ${field} is invalid.`);
  }
}

function assertNonEmptyText(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) invalid(`Approval ${field} must not be empty.`);
}

function assertText(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string") invalid(`Approval ${field} must be text.`);
}

function assertPositiveInteger(value: unknown, field: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) invalid(`Approval ${field} must be positive.`);
}

function assertNonNegativeInteger(value: unknown, field: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) invalid(`Approval ${field} must be non-negative.`);
}

function assertDateTime(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    invalid(`Approval ${field} must be a date-time string.`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(message: string): never {
  throw new ApprovalContractError("approval_request_invalid_subject", message);
}
