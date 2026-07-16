import type { Metadata } from "@agent-anything/shared";
import type { ApprovalCategory } from "./ApprovalCategory.js";
import type {
  ApprovalPayloadByCategory,
  CommandActionSummary,
  FileChangeApprovalChange,
  McpApprovalAnnotations,
} from "./ApprovalContracts.js";
import { ApprovalContractError } from "./ApprovalContractError.js";
import type { CanonicalAdditionalPermissions } from "./PermissionDelta.js";
import { cloneApprovalMetadata, deepFreezeApproval } from "./snapshot.js";

export function snapshotApprovalPayload<TCategory extends ApprovalCategory>(
  category: TCategory,
  input: ApprovalPayloadByCategory[TCategory],
): ApprovalPayloadByCategory[TCategory] {
  if (!isRecord(input)) invalid("Approval payload must be a plain object.");
  switch (category) {
    case "commandExecution":
      return snapshotCommand(input as ApprovalPayloadByCategory["commandExecution"]) as ApprovalPayloadByCategory[TCategory];
    case "fileChange":
      return snapshotFileChange(input as ApprovalPayloadByCategory["fileChange"]) as ApprovalPayloadByCategory[TCategory];
    case "permissions":
      return snapshotPermissionsPayload(input as ApprovalPayloadByCategory["permissions"]) as ApprovalPayloadByCategory[TCategory];
    case "mcpToolCall":
      return snapshotMcp(input as ApprovalPayloadByCategory["mcpToolCall"]) as ApprovalPayloadByCategory[TCategory];
    case "skill":
      return snapshotSkill(input as ApprovalPayloadByCategory["skill"]) as ApprovalPayloadByCategory[TCategory];
    case "networkAccess":
      return snapshotNetwork(input as ApprovalPayloadByCategory["networkAccess"]) as ApprovalPayloadByCategory[TCategory];
  }
}

function snapshotCommand(
  input: ApprovalPayloadByCategory["commandExecution"],
): ApprovalPayloadByCategory["commandExecution"] {
  assertKeys(input, ["command", "safeCommandDisplay", "cwd", "cwdDisplay", "environmentId", "commandActions", "additionalPermissions"]);
  const command = nonEmptyStrings(input.command, "command");
  if (!Array.isArray(input.commandActions)) invalid("Command actions must be an array.");
  const commandActions = input.commandActions.map(snapshotCommandAction);
  return deepFreezeApproval({
    command,
    safeCommandDisplay: text(input.safeCommandDisplay, "safeCommandDisplay", true),
    cwd: text(input.cwd, "cwd"),
    cwdDisplay: text(input.cwdDisplay, "cwdDisplay", true),
    environmentId: token(input.environmentId, "environmentId"),
    commandActions,
    additionalPermissions: snapshotCanonicalPermissions(input.additionalPermissions),
  });
}

function snapshotFileChange(
  input: ApprovalPayloadByCategory["fileChange"],
): ApprovalPayloadByCategory["fileChange"] {
  assertKeys(input, ["changes", "baselineFingerprint", "additionalPermissions"]);
  if (!Array.isArray(input.changes) || input.changes.length === 0) {
    invalid("File-change approval requires at least one change.");
  }
  const changes = input.changes.map((change) => {
    if (!isRecord(change)) invalid("File-change entry must be an object.");
    assertKeys(change, ["operation", "canonicalPath", "displayPath", "destinationCanonicalPath", "destinationDisplayPath", "baselineFingerprint"]);
    if (!["create", "update", "delete", "move", "copy"].includes(change.operation)) {
      invalid("File-change operation is unsupported.");
    }
    const transfer = change.operation === "move" || change.operation === "copy";
    if (transfer !== (change.destinationCanonicalPath !== null) ||
      transfer !== (change.destinationDisplayPath !== null)) {
      invalid("File transfer payload requires both destination fields.");
    }
    return {
      operation: change.operation as FileChangeApprovalChange["operation"],
      canonicalPath: text(change.canonicalPath, "canonicalPath"),
      displayPath: text(change.displayPath, "displayPath", true),
      destinationCanonicalPath: nullableText(change.destinationCanonicalPath, "destinationCanonicalPath"),
      destinationDisplayPath: nullableText(change.destinationDisplayPath, "destinationDisplayPath", true),
      baselineFingerprint: nullableToken(change.baselineFingerprint, "baselineFingerprint"),
    };
  });
  return deepFreezeApproval({
    changes,
    baselineFingerprint: token(input.baselineFingerprint, "baselineFingerprint"),
    additionalPermissions: snapshotCanonicalPermissions(input.additionalPermissions),
  });
}

function snapshotPermissionsPayload(
  input: ApprovalPayloadByCategory["permissions"],
): ApprovalPayloadByCategory["permissions"] {
  assertKeys(input, ["permissions", "cwd", "cwdDisplay", "environmentId"]);
  return deepFreezeApproval({
    permissions: requiredPermissions(input.permissions),
    cwd: text(input.cwd, "cwd"),
    cwdDisplay: text(input.cwdDisplay, "cwdDisplay", true),
    environmentId: token(input.environmentId, "environmentId"),
  });
}

function snapshotMcp(
  input: ApprovalPayloadByCategory["mcpToolCall"],
): ApprovalPayloadByCategory["mcpToolCall"] {
  assertKeys(input, ["serverId", "serverDisplayName", "toolName", "safeArguments", "annotations", "supportsSessionAuthority"]);
  if (!isRecord(input.annotations)) invalid("MCP annotations must be an object.");
  assertKeys(input.annotations, ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"]);
  const annotations = Object.fromEntries(
    Object.entries(input.annotations).map(([key, value]) => [key, nullableBoolean(value, key)]),
  ) as unknown as McpApprovalAnnotations;
  if (typeof input.supportsSessionAuthority !== "boolean") invalid("supportsSessionAuthority must be boolean.");
  return deepFreezeApproval({
    serverId: token(input.serverId, "serverId"),
    serverDisplayName: text(input.serverDisplayName, "serverDisplayName", true),
    toolName: token(input.toolName, "toolName"),
    safeArguments: cloneApprovalMetadata(input.safeArguments as Metadata),
    annotations,
    supportsSessionAuthority: input.supportsSessionAuthority,
  });
}

function snapshotSkill(
  input: ApprovalPayloadByCategory["skill"],
): ApprovalPayloadByCategory["skill"] {
  assertKeys(input, ["skillId", "skillDisplayName", "action", "requiredPermissions"]);
  return deepFreezeApproval({
    skillId: token(input.skillId, "skillId"),
    skillDisplayName: text(input.skillDisplayName, "skillDisplayName", true),
    action: text(input.action, "action", true),
    requiredPermissions: snapshotCanonicalPermissions(input.requiredPermissions),
  });
}

function snapshotNetwork(
  input: ApprovalPayloadByCategory["networkAccess"],
): ApprovalPayloadByCategory["networkAccess"] {
  assertKeys(input, ["host", "port", "protocol", "actionSummary"]);
  if (input.port !== null && (!Number.isSafeInteger(input.port) || input.port < 1 || input.port > 65_535)) {
    invalid("Network approval port is invalid.");
  }
  return deepFreezeApproval({
    host: text(input.host, "host").toLowerCase(),
    port: input.port,
    protocol: input.protocol === null ? null : token(input.protocol.toLowerCase(), "protocol"),
    actionSummary: text(input.actionSummary, "actionSummary", true),
  });
}

function snapshotCommandAction(input: CommandActionSummary): CommandActionSummary {
  if (!isRecord(input)) invalid("Command action must be an object.");
  assertKeys(input, ["kind", "summary"]);
  if (!["read", "write", "network", "process", "unknown"].includes(input.kind)) {
    invalid("Command action kind is unsupported.");
  }
  return { kind: input.kind, summary: text(input.summary, "command action summary", true) };
}

function snapshotCanonicalPermissions(
  input: CanonicalAdditionalPermissions | null,
): CanonicalAdditionalPermissions | null {
  return input === null ? null : requiredPermissions(input);
}

function requiredPermissions(input: CanonicalAdditionalPermissions): CanonicalAdditionalPermissions {
  if (!isRecord(input)) invalid("Canonical permissions must be an object.");
  assertKeys(input, ["fileSystem", "network"], true);
  const fileSystem = input.fileSystem;
  const network = input.network;
  if (fileSystem === undefined && network === undefined) invalid("Canonical permissions cannot be empty.");
  if (fileSystem !== undefined && !isRecord(fileSystem)) invalid("Filesystem permissions are malformed.");
  if (network !== undefined && !isRecord(network)) invalid("Network permissions are malformed.");
  if (fileSystem !== undefined) assertKeys(fileSystem, ["read", "write"], true);
  if (network !== undefined) assertKeys(network, ["enabled", "domains"], true);
  const read = fileSystem?.read === undefined ? undefined : nonEmptyStrings(fileSystem.read, "filesystem read");
  const write = fileSystem?.write === undefined ? undefined : nonEmptyStrings(fileSystem.write, "filesystem write");
  if (fileSystem !== undefined && read === undefined && write === undefined) invalid("Filesystem permissions cannot be empty.");
  if (network !== undefined && network.enabled !== true) invalid("Canonical network permission must be enabled.");
  const domains = network?.domains === undefined ? undefined : nonEmptyStrings(network.domains, "network domains");
  return deepFreezeApproval({
    ...(fileSystem === undefined ? {} : { fileSystem: { ...(read ? { read } : {}), ...(write ? { write } : {}) } }),
    ...(network === undefined ? {} : { network: { enabled: true as const, ...(domains ? { domains } : {}) } }),
  });
}

function nonEmptyStrings(input: readonly string[], field: string): readonly string[] {
  if (!Array.isArray(input) || input.length === 0) invalid(`${field} must be a non-empty array.`);
  return Object.freeze(input.map((value) => text(value, field)));
}

function assertKeys(input: object, allowed: readonly string[], optional = false): void {
  const keys = Object.keys(input);
  if (keys.some((key) => !allowed.includes(key)) || (!optional && allowed.some((key) => !keys.includes(key)))) {
    invalid("Approval payload contains missing or unsupported fields.");
  }
}

function text(input: unknown, field: string, allowEmpty = false): string {
  if (typeof input !== "string" || (!allowEmpty && input.length === 0) || input.length > 32_768) {
    invalid(`${field} is invalid.`);
  }
  return input;
}

function token(input: unknown, field: string): string {
  const value = text(input, field);
  if (/\s/.test(value)) invalid(`${field} must not contain whitespace.`);
  return value;
}

function nullableText(input: unknown, field: string, allowEmpty = false): string | null {
  return input === null ? null : text(input, field, allowEmpty);
}

function nullableToken(input: unknown, field: string): string | null {
  return input === null ? null : token(input, field);
}

function nullableBoolean(input: unknown, field: string): boolean | null {
  if (input !== null && typeof input !== "boolean") invalid(`${field} must be boolean or null.`);
  return input;
}

function isRecord(input: unknown): input is Record<string, any> {
  return typeof input === "object" && input !== null && !Array.isArray(input) && Object.getPrototypeOf(input) === Object.prototype;
}

function invalid(message: string): never {
  throw new ApprovalContractError("approval_request_invalid_payload", message);
}
