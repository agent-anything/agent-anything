import {
  snapshotInteractionRequestRef,
  type InteractionRequestRef,
} from "@agent-anything/interaction/protocol";
import type { InteractionSubmissionOutcome } from "@agent-anything/interaction/coordination";
import type {
  HostActiveRun,
  HostInteractionSubmission,
  HostRunCancellationInput,
  HostRunCancellationReceipt,
} from "../run/HostRunManager.js";
import type { HostRunProjection } from "../projection/HostRunProjection.js";

export const HOST_COMMAND_VERSION = 1 as const;
export const HOST_COMMAND_REASON_MAX_LENGTH = 500;
export const HOST_COMMAND_RECEIPT_LIMIT = 4_096;
export const HOST_INTERACTION_PAYLOAD_MAX_BYTES = 262_144;

export type HostCommandKind = "run.cancel" | "interaction.submit";

export interface HostCommandEnvelope<TKind extends HostCommandKind, TPayload> {
  readonly version: typeof HOST_COMMAND_VERSION;
  readonly commandId: string;
  readonly runId: string;
  readonly kind: TKind;
  readonly payload: TPayload;
}

export interface HostRunCancellationCommandPayload {
  readonly reason: string | null;
}

export interface HostInteractionSubmissionCommandPayload {
  readonly request: InteractionRequestRef;
  readonly submissionId: string;
  readonly payload: unknown;
}

export type HostRunCancellationCommand = HostCommandEnvelope<
  "run.cancel",
  HostRunCancellationCommandPayload
>;

export type HostInteractionSubmissionCommand = HostCommandEnvelope<
  "interaction.submit",
  HostInteractionSubmissionCommandPayload
>;

export type HostCommand = HostRunCancellationCommand | HostInteractionSubmissionCommand;

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

export interface HostInteractionSubmissionCommandReceipt
  extends HostCommandReceiptBase<"interaction.submit"> {
  readonly status: "handled";
  readonly result: InteractionSubmissionOutcome;
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
  | HostInteractionSubmissionCommandReceipt
  | HostCommandRejectedReceipt;

export type HostCommandCancellationAttribution =
  | { readonly origin: "user"; readonly reasonCode: "user_requested" }
  | { readonly origin: "host"; readonly reasonCode: "host_requested" };

export interface CreateHostCommandDispatcherInput {
  readonly resolveActiveRun: (runId: string) => HostActiveRun | null;
  readonly cancellationAttribution: HostCommandCancellationAttribution;
  readonly maxReceipts?: number;
}

export interface HostCommandDispatcher {
  dispatch(candidate: unknown, expectedKind: HostCommandKind): HostCommandReceipt;
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
    dispatch(candidate: unknown, expectedKind: HostCommandKind): HostCommandReceipt {
      assertHostCommandKind(expectedKind, "expected Host command kind");
      let command: HostCommand;
      try {
        command = snapshotHostCommand(candidate);
      } catch (error) {
        return rejectedReceipt(candidate, validationCode(error));
      }
      const fingerprint = canonicalString(command);
      const previous = ledger.get(command.commandId);
      if (previous !== undefined) {
        return previous.fingerprint === fingerprint
          ? previous.receipt
          : rejectedReceipt(command, "host_command_id_conflict");
      }
      if (ledger.size >= maxReceipts) {
        return rejectedReceipt(command, "host_command_ledger_full");
      }
      const receipt = command.kind === expectedKind
        ? dispatchValidatedCommand(input, command)
        : rejectedReceipt(command, "host_command_kind_mismatch");
      ledger.set(command.commandId, Object.freeze({ fingerprint, receipt }));
      return receipt;
    },
  });
}

export function snapshotHostCommand(candidate: unknown): HostCommand {
  assertRecord(candidate, "Host command");
  assertExactKeys(candidate, ["version", "commandId", "runId", "kind", "payload"], "Host command");
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
      kind: "run.cancel" as const,
      payload: snapshotCancellationPayload(candidate.payload),
    });
  }
  return Object.freeze({
    version: HOST_COMMAND_VERSION,
    commandId,
    runId,
    kind: "interaction.submit" as const,
    payload: snapshotInteractionPayload(candidate.payload),
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
        ...(command.payload.reason === null ? {} : { reason: command.payload.reason }),
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
    const submission: HostInteractionSubmission = command.payload;
    return Object.freeze({
      version: HOST_COMMAND_VERSION,
      commandId: command.commandId,
      runId: command.runId,
      kind: command.kind,
      status: "handled",
      result: activeRun.submitInteraction(submission),
      projection: activeRun.getProjection(),
    });
  } catch {
    return rejectedReceipt(command, "host_command_failed", safeProjection(activeRun));
  }
}

function snapshotCancellationPayload(candidate: unknown): HostRunCancellationCommandPayload {
  assertRecord(candidate, "Host cancellation payload");
  assertExactKeys(candidate, ["reason"], "Host cancellation payload");
  return Object.freeze({ reason: nullableReason(candidate.reason, "Host cancellation reason") });
}

function snapshotInteractionPayload(candidate: unknown): HostInteractionSubmissionCommandPayload {
  assertRecord(candidate, "Host Interaction payload");
  assertExactKeys(candidate, ["request", "submissionId", "payload"], "Host Interaction payload");
  const payload = canonicalValue(candidate.payload);
  if (new TextEncoder().encode(JSON.stringify(payload)).byteLength > HOST_INTERACTION_PAYLOAD_MAX_BYTES) {
    throw new HostCommandValidationError(
      "host_command_invalid",
      "Host Interaction payload exceeds the configured limit.",
    );
  }
  try {
    return Object.freeze({
      request: snapshotInteractionRequestRef(candidate.request as InteractionRequestRef),
      submissionId: identity(candidate.submissionId, "Host Interaction submissionId"),
      payload: deepFreeze(payload),
    });
  } catch {
    throw new HostCommandValidationError(
      "host_command_invalid",
      "Host Interaction payload is invalid.",
    );
  }
}

function rejectedReceipt(
  candidate: unknown,
  code: HostCommandRejectionCode,
  projection: HostRunProjection | null = null,
): HostCommandRejectedReceipt {
  const record = isRecord(candidate) ? candidate : {};
  return Object.freeze({
    version: HOST_COMMAND_VERSION,
    commandId: typeof record.commandId === "string" ? record.commandId : "",
    runId: typeof record.runId === "string" ? record.runId : "",
    kind: isHostCommandKind(record.kind) ? record.kind : null,
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
  return error instanceof HostCommandValidationError ? error.code : "host_command_invalid";
}

class HostCommandValidationError extends TypeError {
  constructor(readonly code: HostCommandRejectionCode, message: string) {
    super(message);
    this.name = "HostCommandValidationError";
  }
}

function assertCancellationAttribution(candidate: HostCommandCancellationAttribution): void {
  if (
    candidate === null || typeof candidate !== "object" ||
    !(
      candidate.origin === "user" && candidate.reasonCode === "user_requested" ||
      candidate.origin === "host" && candidate.reasonCode === "host_requested"
    )
  ) throw new TypeError("Host command cancellation attribution is invalid.");
}

function assertHostCommandKind(value: unknown, field: string): asserts value is HostCommandKind {
  if (!isHostCommandKind(value)) {
    throw new HostCommandValidationError(
      "host_command_kind_unsupported",
      `${field} is unsupported.`,
    );
  }
}

function isHostCommandKind(value: unknown): value is HostCommandKind {
  return value === "run.cancel" || value === "interaction.submit";
}

function nullableReason(value: unknown, field: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || value.length === 0 || value.length > HOST_COMMAND_REASON_MAX_LENGTH) {
    throw new HostCommandValidationError("host_command_invalid", `${field} is invalid.`);
  }
  return value;
}

function identity(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0 || /\s/.test(value)) {
    throw new HostCommandValidationError(
      "host_command_invalid",
      `${field} must be a non-empty identity.`,
    );
  }
  return value;
}

function assertRecord(value: unknown, field: string): asserts value is Record<string, unknown> {
  if (!isRecord(value) || Array.isArray(value)) {
    throw new HostCommandValidationError("host_command_invalid", `${field} must be an object.`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function assertExactKeys(value: Record<string, unknown>, keys: readonly string[], field: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new HostCommandValidationError(
      "host_command_invalid",
      `${field} contains unsupported fields.`,
    );
  }
}

function canonicalString(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (isRecord(value) && !Array.isArray(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalValue(child)]),
    );
  }
  if (
    value === null || typeof value === "string" || typeof value === "boolean" ||
    typeof value === "number" && Number.isFinite(value)
  ) return value;
  throw new HostCommandValidationError("host_command_invalid", "Host command contains non-canonical data.");
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}
