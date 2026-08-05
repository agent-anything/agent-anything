
import type { ApprovalCategory } from "./ApprovalCategory.js";
import type {
  ApprovalPayloadByCategory,
  CommandActionSummary,
  FileChangeApprovalChange,
  RemoteToolApprovalAnnotations,
  RemoteToolApprovalServer,
  RemoteToolApprovalSource,
  RemoteToolApprovalTool,
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
    case "remoteToolCall":
      return snapshotRemoteTool(input as ApprovalPayloadByCategory["remoteToolCall"]) as ApprovalPayloadByCategory[TCategory];
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

function snapshotRemoteTool(
  input: ApprovalPayloadByCategory["remoteToolCall"],
): ApprovalPayloadByCategory["remoteToolCall"] {
  assertKeys(input, [
    "source",
    "server",
    "tool",
    "safeArguments",
    "annotations",
    "supportsSessionAuthority",
  ]);
  if (!isRecord(input.source)) invalid("Remote Tool source must be an object.");
  assertKeys(input.source, [
    "kind",
    "sourceId",
    "displayName",
    "sourceRevision",
    "activationEpoch",
    "capabilityId",
  ]);
  if (
    input.source.kind !== "mcp" &&
    input.source.kind !== "plugin" &&
    input.source.kind !== "remote"
  ) {
    invalid("Remote Tool source kind is unsupported.");
  }
  if (
    input.source.sourceRevision !== null &&
    (
      typeof input.source.sourceRevision !== "string" ||
      input.source.sourceRevision.length === 0 ||
      input.source.sourceRevision !== input.source.sourceRevision.trim()
    )
  ) {
    invalid("Remote Tool source revision is invalid.");
  }
  if (
    input.source.activationEpoch !== null &&
    (
      !Number.isSafeInteger(input.source.activationEpoch) ||
      input.source.activationEpoch < 1
    )
  ) {
    invalid("Remote Tool activation epoch is invalid.");
  }
  const source: RemoteToolApprovalSource = {
    kind: input.source.kind,
    sourceId: token(input.source.sourceId, "sourceId"),
    displayName: text(input.source.displayName, "source displayName", true),
    sourceRevision: input.source.sourceRevision,
    activationEpoch: input.source.activationEpoch,
    capabilityId: token(input.source.capabilityId, "capabilityId"),
  };
  const server = snapshotRemoteServer(input.server);
  const tool = snapshotRemoteToolIdentity(input.tool);
  if (!isRecord(input.annotations)) invalid("Remote Tool annotations must be an object.");
  assertKeys(input.annotations, ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"]);
  const annotations = Object.fromEntries(
    Object.entries(input.annotations).map(([key, value]) => [key, nullableBoolean(value, key)]),
  ) as unknown as RemoteToolApprovalAnnotations;
  if (typeof input.supportsSessionAuthority !== "boolean") invalid("supportsSessionAuthority must be boolean.");
  return deepFreezeApproval({
    source,
    server,
    tool,
    safeArguments: cloneApprovalMetadata(input.safeArguments as Readonly<Record<string, unknown>>),
    annotations,
    supportsSessionAuthority: input.supportsSessionAuthority,
  });
}

function snapshotRemoteServer(input: unknown): RemoteToolApprovalServer {
  if (!isRecord(input)) invalid("Remote Tool server must be an object.");
  assertKeys(input, [
    "serverId",
    "displayName",
    "registrationFingerprint",
    "transport",
    "endpoint",
  ]);
  if (
    input.transport !== "stdio" &&
    input.transport !== "http" &&
    input.transport !== "https" &&
    input.transport !== "websocket"
  ) {
    invalid("Remote Tool server transport is unsupported.");
  }
  const endpoint = input.endpoint === null
    ? null
    : snapshotRemoteEndpoint(input.endpoint);
  if ((input.transport === "stdio") !== (endpoint === null)) {
    invalid("Remote Tool stdio transport requires no endpoint and network transports require one.");
  }
  return {
    serverId: token(input.serverId, "serverId"),
    displayName: text(input.displayName, "server displayName", true),
    registrationFingerprint: token(
      input.registrationFingerprint,
      "server registrationFingerprint",
    ),
    transport: input.transport,
    endpoint,
  };
}

function snapshotRemoteEndpoint(
  input: unknown,
): NonNullable<RemoteToolApprovalServer["endpoint"]> {
  if (!isRecord(input)) invalid("Remote Tool server endpoint must be an object.");
  assertKeys(input, ["transport", "host", "port", "applicationProtocol"]);
  if (input.transport !== "tcp" && input.transport !== "udp") {
    invalid("Remote Tool endpoint transport is unsupported.");
  }
  if (!Number.isSafeInteger(input.port) || input.port < 1 || input.port > 65_535) {
    invalid("Remote Tool endpoint port is invalid.");
  }
  return {
    transport: input.transport,
    host: text(input.host, "endpoint host"),
    port: input.port,
    applicationProtocol: nullableToken(
      input.applicationProtocol,
      "endpoint applicationProtocol",
    ),
  };
}

function snapshotRemoteToolIdentity(input: unknown): RemoteToolApprovalTool {
  if (!isRecord(input)) invalid("Remote Tool identity must be an object.");
  assertKeys(input, ["name", "displayName"]);
  return {
    name: token(input.name, "tool name"),
    displayName: text(input.displayName, "tool displayName", true),
  };
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
