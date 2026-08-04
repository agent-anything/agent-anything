import {
  snapshotApprovalDecisionSubmission,
  type ApprovalDecisionSubmission,
  type ApprovalSubmissionReceipt,
} from "@agent-anything/permission";
import type {
  HostActiveRun,
  HostRunCancellationInput,
  HostRunCancellationReceipt,
} from "./HostRuntime.js";
import type { HostRunProjection } from "./HostRunProjection.js";

export const HOST_COMMAND_VERSION = 1 as const;
export const HOST_COMMAND_REASON_MAX_LENGTH = 500;
export const HOST_COMMAND_RECEIPT_LIMIT = 4_096;
const HOST_COMMAND_PERMISSION_ENTRY_LIMIT = 256;
const HOST_COMMAND_PERMISSION_TEXT_MAX_LENGTH = 2_048;

export type HostCommandKind = "run.cancel" | "approval.submit";

export interface HostCommandEnvelope<
  TKind extends HostCommandKind,
  TPayload,
> {
  readonly version: typeof HOST_COMMAND_VERSION;
  readonly commandId: string;
  readonly runId: string;
  readonly kind: TKind;
  readonly payload: TPayload;
}

export interface HostRunCancellationCommandPayload {
  readonly reason: string | null;
}

export interface HostApprovalSubmissionCommandPayload {
  readonly submissionId: string;
  readonly requestId: string;
  readonly pendingVersion: number;
  readonly optionId: string;
  readonly grantedPermissions: ApprovalDecisionSubmission["grantedPermissions"];
  readonly reason: string | null;
}

export type HostRunCancellationCommand = HostCommandEnvelope<
  "run.cancel",
  HostRunCancellationCommandPayload
>;

export type HostApprovalSubmissionCommand = HostCommandEnvelope<
  "approval.submit",
  HostApprovalSubmissionCommandPayload
>;

export type HostCommand =
  | HostRunCancellationCommand
  | HostApprovalSubmissionCommand;

export type HostCommandRejectionCode =
  | "host_command_invalid"
  | "host_command_version_unsupported"
  | "host_command_kind_unsupported"
  | "host_command_kind_mismatch"
  | "host_command_id_conflict"
  | "host_command_ledger_full"
  | "host_command_run_not_active"
  | "host_command_failed";

interface HostCommandReceiptBase<TKind extends HostCommandKind> {
  readonly version: typeof HOST_COMMAND_VERSION;
  readonly commandId: string;
  readonly runId: string;
  readonly kind: TKind;
}

export interface HostRunCancellationCommandReceipt
  extends HostCommandReceiptBase<"run.cancel"> {
  readonly status: "handled";
  readonly result: HostRunCancellationReceipt;
  readonly projection: HostRunProjection;
}

export interface HostApprovalSubmissionCommandReceipt
  extends HostCommandReceiptBase<"approval.submit"> {
  readonly status: "handled";
  readonly result: ApprovalSubmissionReceipt;
  readonly projection: HostRunProjection;
}

export interface HostCommandRejectedReceipt {
  readonly version: typeof HOST_COMMAND_VERSION;
  readonly commandId: string;
  readonly runId: string;
  readonly kind: HostCommandKind | null;
  readonly status: "rejected";
  readonly code: HostCommandRejectionCode;
  readonly projection: HostRunProjection | null;
}

export type HostCommandReceipt =
  | HostRunCancellationCommandReceipt
  | HostApprovalSubmissionCommandReceipt
  | HostCommandRejectedReceipt;

export type HostCommandCancellationAttribution =
  | {
      readonly origin: "user";
      readonly reasonCode: "user_requested";
    }
  | {
      readonly origin: "host";
      readonly reasonCode: "host_requested";
    };

export interface CreateHostCommandDispatcherInput {
  readonly resolveActiveRun: (runId: string) => HostActiveRun | null;
  readonly cancellationAttribution: HostCommandCancellationAttribution;
  readonly maxReceipts?: number;
}

export interface HostCommandDispatcher {
  dispatch(
    candidate: unknown,
    expectedKind: HostCommandKind,
  ): HostCommandReceipt;
}

interface HostCommandLedgerEntry {
  readonly fingerprint: string;
  readonly receipt: HostCommandReceipt;
}

export function createHostCommandDispatcher(
  input: CreateHostCommandDispatcherInput,
): HostCommandDispatcher {
  if (typeof input.resolveActiveRun !== "function") {
    throw new TypeError("Host command dispatcher requires an active Run resolver.");
  }
  assertCancellationAttribution(input.cancellationAttribution);
  const maxReceipts = input.maxReceipts ?? HOST_COMMAND_RECEIPT_LIMIT;
  if (!Number.isSafeInteger(maxReceipts) || maxReceipts < 1) {
    throw new TypeError("Host command receipt limit must be a positive integer.");
  }
  const ledger = new Map<string, HostCommandLedgerEntry>();

  return Object.freeze({
    dispatch(
      candidate: unknown,
      expectedKind: HostCommandKind,
    ): HostCommandReceipt {
      assertHostCommandKind(expectedKind, "expected Host command kind");
      let command: HostCommand;
      try {
        command = snapshotHostCommand(candidate);
      } catch (error) {
        return rejectedReceipt(
          candidate,
          validationCode(error),
        );
      }

      const fingerprint = JSON.stringify(command);
      const previous = ledger.get(command.commandId);
      if (previous !== undefined) {
        return previous.fingerprint === fingerprint
          ? previous.receipt
          : rejectedReceipt(command, "host_command_id_conflict");
      }
      if (ledger.size >= maxReceipts) {
        return rejectedReceipt(command, "host_command_ledger_full");
      }

      let receipt: HostCommandReceipt;
      if (command.kind !== expectedKind) {
        receipt = rejectedReceipt(command, "host_command_kind_mismatch");
      } else {
        receipt = dispatchValidatedCommand(
          input,
          command,
        );
      }
      ledger.set(command.commandId, Object.freeze({ fingerprint, receipt }));
      return receipt;
    },
  });
}

export function snapshotHostCommand(candidate: unknown): HostCommand {
  assertRecord(candidate, "Host command");
  assertExactKeys(
    candidate,
    ["version", "commandId", "runId", "kind", "payload"],
    "Host command",
  );
  if (candidate.version !== HOST_COMMAND_VERSION) {
    throw new HostCommandValidationError(
      "host_command_version_unsupported",
      "Host command version is unsupported.",
    );
  }
  const commandId = identity(candidate.commandId, "Host command commandId");
  const runId = identity(candidate.runId, "Host command runId");
  assertHostCommandKind(candidate.kind, "Host command kind");

  if (candidate.kind === "run.cancel") {
    return Object.freeze({
      version: HOST_COMMAND_VERSION,
      commandId,
      runId,
      kind: candidate.kind,
      payload: snapshotCancellationPayload(candidate.payload),
    });
  }

  return Object.freeze({
    version: HOST_COMMAND_VERSION,
    commandId,
    runId,
    kind: candidate.kind,
    payload: snapshotApprovalPayload(candidate.payload, runId),
  });
}

function dispatchValidatedCommand(
  input: CreateHostCommandDispatcherInput,
  command: HostCommand,
): HostCommandReceipt {
  let activeRun: HostActiveRun | null;
  try {
    activeRun = input.resolveActiveRun(command.runId);
  } catch {
    return rejectedReceipt(command, "host_command_failed");
  }
  if (activeRun === null || activeRun.runId !== command.runId) {
    return rejectedReceipt(command, "host_command_run_not_active");
  }

  try {
    if (command.kind === "run.cancel") {
      const cancellation: HostRunCancellationInput = {
        ...input.cancellationAttribution,
        ...(command.payload.reason === null
          ? {}
          : { reason: command.payload.reason }),
      };
      return Object.freeze({
        version: HOST_COMMAND_VERSION,
        commandId: command.commandId,
        runId: command.runId,
        kind: command.kind,
        status: "handled",
        result: activeRun.cancel(cancellation),
        projection: activeRun.getProjection(),
      });
    }

    const submission: ApprovalDecisionSubmission = {
      runId: command.runId,
      ...command.payload,
    };
    return Object.freeze({
      version: HOST_COMMAND_VERSION,
      commandId: command.commandId,
      runId: command.runId,
      kind: command.kind,
      status: "handled",
      result: activeRun.submitApprovalDecision(submission),
      projection: activeRun.getProjection(),
    });
  } catch {
    return rejectedReceipt(
      command,
      "host_command_failed",
      safeProjection(activeRun),
    );
  }
}

function snapshotCancellationPayload(
  candidate: unknown,
): HostRunCancellationCommandPayload {
  assertRecord(candidate, "Host cancellation payload");
  assertExactKeys(candidate, ["reason"], "Host cancellation payload");
  return Object.freeze({
    reason: nullableReason(candidate.reason, "Host cancellation reason"),
  });
}

function snapshotApprovalPayload(
  candidate: unknown,
  runId: string,
): HostApprovalSubmissionCommandPayload {
  assertRecord(candidate, "Host approval payload");
  assertExactKeys(
    candidate,
    [
      "submissionId",
      "requestId",
      "pendingVersion",
      "optionId",
      "grantedPermissions",
      "reason",
    ],
    "Host approval payload",
  );
  assertAdditionalPermissions(candidate.grantedPermissions);
  let submission: ApprovalDecisionSubmission;
  try {
    submission = snapshotApprovalDecisionSubmission({
      runId,
      submissionId: candidate.submissionId,
      requestId: candidate.requestId,
      pendingVersion: candidate.pendingVersion,
      optionId: candidate.optionId,
      grantedPermissions: candidate.grantedPermissions,
      reason: candidate.reason,
    } as ApprovalDecisionSubmission);
  } catch {
    throw new HostCommandValidationError(
      "host_command_invalid",
      "Host approval payload is invalid.",
    );
  }
  nullableReason(submission.reason, "Host approval reason");
  return Object.freeze({
    submissionId: submission.submissionId,
    requestId: submission.requestId,
    pendingVersion: submission.pendingVersion,
    optionId: submission.optionId,
    grantedPermissions: submission.grantedPermissions,
    reason: submission.reason,
  });
}

function assertAdditionalPermissions(candidate: unknown): void {
  if (candidate === null) return;
  assertRecord(candidate, "Host approval grantedPermissions");
  assertExactSubsetKeys(
    candidate,
    ["fileSystem", "network"],
    "Host approval grantedPermissions",
  );

  if ("fileSystem" in candidate) {
    assertRecord(candidate.fileSystem, "Host approval fileSystem permissions");
    assertExactSubsetKeys(
      candidate.fileSystem,
      ["read", "write"],
      "Host approval fileSystem permissions",
    );
    if ("read" in candidate.fileSystem) {
      assertBoundedTextArray(
        candidate.fileSystem.read,
        "Host approval fileSystem read permissions",
      );
    }
    if ("write" in candidate.fileSystem) {
      assertBoundedTextArray(
        candidate.fileSystem.write,
        "Host approval fileSystem write permissions",
      );
    }
  }

  if ("network" in candidate) {
    assertRecord(candidate.network, "Host approval network permissions");
    assertExactSubsetKeys(
      candidate.network,
      ["enabled", "domains"],
      "Host approval network permissions",
    );
    if (typeof candidate.network.enabled !== "boolean") {
      throw new HostCommandValidationError(
        "host_command_invalid",
        "Host approval network enabled flag is invalid.",
      );
    }
    if ("domains" in candidate.network) {
      assertBoundedTextArray(
        candidate.network.domains,
        "Host approval network domains",
      );
    }
  }
}

function assertBoundedTextArray(candidate: unknown, field: string): void {
  if (
    !Array.isArray(candidate) ||
    candidate.length > HOST_COMMAND_PERMISSION_ENTRY_LIMIT ||
    candidate.some(
      (item) =>
        typeof item !== "string" ||
        item.length === 0 ||
        item.length > HOST_COMMAND_PERMISSION_TEXT_MAX_LENGTH,
    )
  ) {
    throw new HostCommandValidationError(
      "host_command_invalid",
      `${field} is invalid.`,
    );
  }
}

function rejectedReceipt(
  candidate: unknown,
  code: HostCommandRejectionCode,
  projection: HostRunProjection | null = null,
): HostCommandRejectedReceipt {
  const record = isRecord(candidate) ? candidate : {};
  const kind = isHostCommandKind(record.kind) ? record.kind : null;
  return Object.freeze({
    version: HOST_COMMAND_VERSION,
    commandId: typeof record.commandId === "string" ? record.commandId : "",
    runId: typeof record.runId === "string" ? record.runId : "",
    kind,
    status: "rejected",
    code,
    projection,
  });
}

function safeProjection(activeRun: HostActiveRun): HostRunProjection | null {
  try {
    return activeRun.getProjection();
  } catch {
    return null;
  }
}

function validationCode(error: unknown): HostCommandRejectionCode {
  return error instanceof HostCommandValidationError
    ? error.code
    : "host_command_invalid";
}

class HostCommandValidationError extends TypeError {
  constructor(
    readonly code: HostCommandRejectionCode,
    message: string,
  ) {
    super(message);
    this.name = "HostCommandValidationError";
  }
}

function assertCancellationAttribution(
  candidate: HostCommandCancellationAttribution,
): void {
  if (
    candidate === null ||
    typeof candidate !== "object" ||
    !(
      (candidate.origin === "user" && candidate.reasonCode === "user_requested") ||
      (candidate.origin === "host" && candidate.reasonCode === "host_requested")
    )
  ) {
    throw new TypeError("Host command cancellation attribution is invalid.");
  }
}

function assertHostCommandKind(
  value: unknown,
  field: string,
): asserts value is HostCommandKind {
  if (!isHostCommandKind(value)) {
    throw new HostCommandValidationError(
      "host_command_kind_unsupported",
      `${field} is unsupported.`,
    );
  }
}

function isHostCommandKind(value: unknown): value is HostCommandKind {
  return value === "run.cancel" || value === "approval.submit";
}

function nullableReason(value: unknown, field: string): string | null {
  if (value === null) {
    return null;
  }
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > HOST_COMMAND_REASON_MAX_LENGTH
  ) {
    throw new HostCommandValidationError(
      "host_command_invalid",
      `${field} is invalid.`,
    );
  }
  return value;
}

function identity(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    /\s/.test(value)
  ) {
    throw new HostCommandValidationError(
      "host_command_invalid",
      `${field} must be a non-empty identity.`,
    );
  }
  return value;
}

function assertRecord(
  value: unknown,
  field: string,
): asserts value is Record<string, unknown> {
  if (!isRecord(value) || Array.isArray(value)) {
    throw new HostCommandValidationError(
      "host_command_invalid",
      `${field} must be an object.`,
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function assertExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  field: string,
): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new HostCommandValidationError(
      "host_command_invalid",
      `${field} contains unsupported fields.`,
    );
  }
}

function assertExactSubsetKeys(
  value: Record<string, unknown>,
  allowedKeys: readonly string[],
  field: string,
): void {
  if (Object.keys(value).some((key) => !allowedKeys.includes(key))) {
    throw new HostCommandValidationError(
      "host_command_invalid",
      `${field} contains unsupported fields.`,
    );
  }
}
