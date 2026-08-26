import { createHash } from "node:crypto";
import {
  HELARC_PRODUCT_COMMAND_RECEIPT_LIMIT,
  HELARC_PRODUCT_COMMAND_VERSION,
  type HelarcProductCommand,
  type HelarcProductCommandEnvelope,
  type HelarcProductCommandKind,
  type HelarcProductCommandPayloadMap,
  type HelarcProductCommandRejectionCode,
} from "../shared/HelarcDesktopCommand.js";
import type {
  HelarcProductCommandReceipt,
  HelarcProductCommandResultMap,
} from "../shared/HelarcDesktopApi.js";

const IDENTITY_MAX_LENGTH = 256;
const TASK_TEXT_MAX_LENGTH = 100_000;
const DISPLAY_NAME_MAX_LENGTH = 200;
const BASE_URL_MAX_LENGTH = 2_048;
const MODEL_MAX_LENGTH = 512;
const API_KEY_MAX_LENGTH = 16_384;

export type HelarcProductCommandHandlers = {
  readonly [TKind in HelarcProductCommandKind]: (
    payload: HelarcProductCommandPayloadMap[TKind],
  ) =>
    | HelarcProductCommandResultMap[TKind]
    | Promise<HelarcProductCommandResultMap[TKind]>;
};

export interface CreateHelarcProductCommandDispatcherInput {
  readonly handlers: HelarcProductCommandHandlers;
  readonly maxReceipts?: number;
}

export interface HelarcProductCommandDispatcher {
  dispatch<TKind extends HelarcProductCommandKind>(
    candidate: unknown,
    expectedKind: TKind,
  ): Promise<HelarcProductCommandReceipt<TKind>>;
}

interface ProductCommandLedgerEntry {
  readonly fingerprint: string;
  readonly receipt: Promise<HelarcProductCommandReceipt<HelarcProductCommandKind>>;
}

export function createHelarcProductCommandDispatcher(
  input: CreateHelarcProductCommandDispatcherInput,
): HelarcProductCommandDispatcher {
  assertHandlers(input.handlers);
  const maxReceipts = input.maxReceipts ?? HELARC_PRODUCT_COMMAND_RECEIPT_LIMIT;
  if (!Number.isSafeInteger(maxReceipts) || maxReceipts < 1) {
    throw new TypeError("Helarc Product command receipt limit must be a positive integer.");
  }
  const ledger = new Map<string, ProductCommandLedgerEntry>();

  return Object.freeze({
    dispatch<TKind extends HelarcProductCommandKind>(
      candidate: unknown,
      expectedKind: TKind,
    ): Promise<HelarcProductCommandReceipt<TKind>> {
      assertProductCommandKind(expectedKind, "expected Helarc Product command kind");
      let command: HelarcProductCommand;
      try {
        command = snapshotHelarcProductCommand(candidate);
      } catch (error) {
        return Promise.resolve(
          rejectedReceipt(candidate, verificationCode(error)),
        ) as Promise<HelarcProductCommandReceipt<TKind>>;
      }

      const fingerprint = digestCommand(command);
      const previous = ledger.get(command.commandId);
      if (previous !== undefined) {
        return previous.fingerprint === fingerprint
          ? previous.receipt as Promise<HelarcProductCommandReceipt<TKind>>
          : Promise.resolve(
              rejectedReceipt(command, "helarc_product_command_id_conflict"),
            ) as Promise<HelarcProductCommandReceipt<TKind>>;
      }
      if (ledger.size >= maxReceipts) {
        return Promise.resolve(
          rejectedReceipt(command, "helarc_product_command_ledger_full"),
        ) as Promise<HelarcProductCommandReceipt<TKind>>;
      }

      const receipt = command.kind === expectedKind
        ? dispatchValidatedCommand(input.handlers, command)
        : Promise.resolve(
            rejectedReceipt(command, "helarc_product_command_kind_mismatch"),
          );
      ledger.set(command.commandId, Object.freeze({ fingerprint, receipt }));
      return receipt as Promise<HelarcProductCommandReceipt<TKind>>;
    },
  });
}

export function snapshotHelarcProductCommand(candidate: unknown): HelarcProductCommand {
  assertRecord(candidate, "Helarc Product command");
  assertExactKeys(
    candidate,
    ["version", "commandId", "kind", "payload"],
    "Helarc Product command",
  );
  if (candidate.version !== HELARC_PRODUCT_COMMAND_VERSION) {
    throw new ProductCommandValidationError(
      "helarc_product_command_version_unsupported",
      "Helarc Product command version is unsupported.",
    );
  }
  const commandId = identity(candidate.commandId, "Helarc Product command commandId");
  assertProductCommandKind(candidate.kind, "Helarc Product command kind");

  switch (candidate.kind) {
    case "workspace.choose":
      return envelope(commandId, candidate.kind, snapshotEmptyPayload(candidate.payload));
    case "workspace.select":
      return envelope(commandId, candidate.kind, snapshotWorkspaceSelection(candidate.payload));
    case "provider.save":
      return envelope(commandId, candidate.kind, snapshotProviderSave(candidate.payload));
    case "run.start":
      return envelope(commandId, candidate.kind, snapshotRunStart(candidate.payload));
    case "thread.open":
      return envelope(commandId, candidate.kind, snapshotThreadOpen(candidate.payload));
  }
}

function dispatchValidatedCommand(
  handlers: HelarcProductCommandHandlers,
  command: HelarcProductCommand,
): Promise<HelarcProductCommandReceipt<HelarcProductCommandKind>> {
  return Promise.resolve()
    .then(async () => {
      const result = await invokeHandler(handlers, command);
      return deepFreeze({
        version: HELARC_PRODUCT_COMMAND_VERSION,
        commandId: command.commandId,
        kind: command.kind,
        status: "handled" as const,
        result,
      }) as HelarcProductCommandReceipt<HelarcProductCommandKind>;
    })
    .catch(() => rejectedReceipt(command, "helarc_product_command_failed"));
}

function invokeHandler(
  handlers: HelarcProductCommandHandlers,
  command: HelarcProductCommand,
): Promise<HelarcProductCommandResultMap[HelarcProductCommandKind]>
  | HelarcProductCommandResultMap[HelarcProductCommandKind] {
  switch (command.kind) {
    case "workspace.choose":
      return handlers[command.kind](command.payload);
    case "workspace.select":
      return handlers[command.kind](command.payload);
    case "provider.save":
      return handlers[command.kind](command.payload);
    case "run.start":
      return handlers[command.kind](command.payload);
    case "thread.open":
      return handlers[command.kind](command.payload);
  }
}

function envelope<TKind extends HelarcProductCommandKind>(
  commandId: string,
  kind: TKind,
  payload: HelarcProductCommandPayloadMap[TKind],
): HelarcProductCommandEnvelope<TKind> {
  return Object.freeze({
    version: HELARC_PRODUCT_COMMAND_VERSION,
    commandId,
    kind,
    payload,
  });
}

function snapshotEmptyPayload(candidate: unknown): Record<string, never> {
  assertRecord(candidate, "Workspace choice payload");
  assertExactKeys(candidate, [], "Workspace choice payload");
  return Object.freeze({});
}

function snapshotWorkspaceSelection(
  candidate: unknown,
): HelarcProductCommandPayloadMap["workspace.select"] {
  assertRecord(candidate, "Workspace selection payload");
  assertExactKeys(candidate, ["profileId"], "Workspace selection payload");
  return Object.freeze({
    profileId: identity(candidate.profileId, "Workspace profile id"),
  });
}

function snapshotProviderSave(
  candidate: unknown,
): HelarcProductCommandPayloadMap["provider.save"] {
  assertRecord(candidate, "Provider save payload");
  assertExactKeys(
    candidate,
    [
      "providerKind",
      "displayName",
      "baseUrl",
      "model",
      "timeoutMs",
      "apiKeyUpdate",
      "apiKey",
    ],
    "Provider save payload",
  );
  if (
    candidate.providerKind !== "openai-compatible" &&
    candidate.providerKind !== "ollama"
  ) {
    invalid("Provider kind is invalid.");
  }
  if (
    candidate.apiKeyUpdate !== "keep" &&
    candidate.apiKeyUpdate !== "set" &&
    candidate.apiKeyUpdate !== "clear"
  ) {
    invalid("Provider credential update is invalid.");
  }
  if (!Number.isSafeInteger(candidate.timeoutMs) || (candidate.timeoutMs as number) < 1_000) {
    invalid("Provider timeout must be a safe integer of at least 1000 milliseconds.");
  }
  return Object.freeze({
    providerKind: candidate.providerKind,
    displayName: boundedText(candidate.displayName, "Provider display name", DISPLAY_NAME_MAX_LENGTH),
    baseUrl: boundedText(candidate.baseUrl, "Provider base URL", BASE_URL_MAX_LENGTH),
    model: boundedText(candidate.model, "Provider model", MODEL_MAX_LENGTH),
    timeoutMs: candidate.timeoutMs as number,
    apiKeyUpdate: candidate.apiKeyUpdate,
    apiKey: boundedString(candidate.apiKey, "Provider API key", API_KEY_MAX_LENGTH),
  });
}

function snapshotRunStart(
  candidate: unknown,
): HelarcProductCommandPayloadMap["run.start"] {
  assertRecord(candidate, "Run start payload");
  assertExactKeys(candidate, ["taskText", "target"], "Run start payload");
  return Object.freeze({
    taskText: boundedText(candidate.taskText, "Run Task text", TASK_TEXT_MAX_LENGTH),
    target: snapshotRunStartTarget(candidate.target),
  });
}

function snapshotRunStartTarget(
  candidate: unknown,
): HelarcProductCommandPayloadMap["run.start"]["target"] {
  assertRecord(candidate, "Run start target");
  if (candidate.kind === "new_thread") {
    assertExactKeys(candidate, ["kind"], "New Thread start target");
    return Object.freeze({ kind: "new_thread" });
  }
  if (candidate.kind === "continue_thread") {
    assertExactKeys(candidate, ["kind", "threadId"], "Continued Thread start target");
    return Object.freeze({
      kind: "continue_thread",
      threadId: identity(candidate.threadId, "Continued Thread id"),
    });
  }
  invalid("Run start target kind is invalid.");
}

function snapshotThreadOpen(
  candidate: unknown,
): HelarcProductCommandPayloadMap["thread.open"] {
  assertRecord(candidate, "Thread open payload");
  assertExactKeys(candidate, ["threadId"], "Thread open payload");
  return Object.freeze({
    threadId: identity(candidate.threadId, "Thread id"),
  });
}

function rejectedReceipt(
  candidate: unknown,
  code: HelarcProductCommandRejectionCode,
): HelarcProductCommandReceipt<HelarcProductCommandKind> {
  const record = isRecord(candidate) ? candidate : {};
  return Object.freeze({
    version: HELARC_PRODUCT_COMMAND_VERSION,
    commandId: typeof record.commandId === "string" ? record.commandId : "",
    kind: isProductCommandKind(record.kind) ? record.kind : null,
    status: "rejected",
    code,
  });
}

function digestCommand(command: HelarcProductCommand): string {
  return createHash("sha256")
    .update(JSON.stringify(command), "utf8")
    .digest("hex");
}

function verificationCode(error: unknown): HelarcProductCommandRejectionCode {
  return error instanceof ProductCommandValidationError
    ? error.code
    : "helarc_product_command_invalid";
}

class ProductCommandValidationError extends TypeError {
  constructor(
    readonly code: HelarcProductCommandRejectionCode,
    message: string,
  ) {
    super(message);
    this.name = "ProductCommandValidationError";
  }
}

function assertHandlers(handlers: HelarcProductCommandHandlers): void {
  if (!isRecord(handlers)) {
    throw new TypeError("Helarc Product command handlers are required.");
  }
  for (const kind of PRODUCT_COMMAND_KINDS) {
    if (typeof handlers[kind] !== "function") {
      throw new TypeError(`Helarc Product command handler '${kind}' is required.`);
    }
  }
}

const PRODUCT_COMMAND_KINDS = [
  "workspace.choose",
  "workspace.select",
  "provider.save",
  "run.start",
  "thread.open",
] as const satisfies readonly HelarcProductCommandKind[];

function assertProductCommandKind(
  value: unknown,
  field: string,
): asserts value is HelarcProductCommandKind {
  if (!isProductCommandKind(value)) {
    throw new ProductCommandValidationError(
      "helarc_product_command_kind_unsupported",
      `${field} is unsupported.`,
    );
  }
}

function isProductCommandKind(value: unknown): value is HelarcProductCommandKind {
  return typeof value === "string" &&
    PRODUCT_COMMAND_KINDS.includes(value as HelarcProductCommandKind);
}

function identity(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > IDENTITY_MAX_LENGTH ||
    /\s/.test(value)
  ) {
    invalid(`${field} is invalid.`);
  }
  return value;
}

function boundedText(value: unknown, field: string, maxLength: number): string {
  const text = boundedString(value, field, maxLength);
  if (text.trim().length === 0) {
    invalid(`${field} must not be empty.`);
  }
  return text;
}

function boundedString(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string" || value.length > maxLength) {
    invalid(`${field} is invalid.`);
  }
  return value;
}

function assertRecord(
  value: unknown,
  field: string,
): asserts value is Record<string, unknown> {
  if (!isRecord(value) || Array.isArray(value)) {
    invalid(`${field} must be an object.`);
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
    invalid(`${field} contains unsupported fields.`);
  }
}

function invalid(message: string): never {
  throw new ProductCommandValidationError(
    "helarc_product_command_invalid",
    message,
  );
}

function deepFreeze<TValue>(value: TValue): TValue {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) {
    deepFreeze(child);
  }
  return Object.freeze(value);
}
