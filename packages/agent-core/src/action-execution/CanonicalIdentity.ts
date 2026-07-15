import type { PermissionEnvironmentPlatform } from "@agent-anything/permission/profile";
import {
  assertCanonicalArray,
  assertStrictRecord,
  canonicalizeAbsolutePath,
  canonicalizeConcreteHost,
  canonicalPathComparisonKey,
  compareCanonicalStrings,
  contractError,
  validateDigest,
  validatePlatform,
  validatePort,
  validateToken,
} from "./ActionContractValidation.js";

export interface CanonicalPathIdentity {
  readonly platform: PermissionEnvironmentPlatform;
  readonly canonicalPath: string;
  readonly comparisonKey: string;
  readonly resolvedPath: string | null;
  readonly resolvedComparisonKey: string | null;
  readonly workspaceRootId: string | null;
  readonly resolutionFingerprint: string;
}

export interface CanonicalPathIdentityInput {
  readonly platform: PermissionEnvironmentPlatform;
  readonly path: string;
  readonly resolvedPath: string | null;
  readonly workspaceRootId: string | null;
  readonly resolutionFingerprint: string;
}

export interface CanonicalWorkspaceRootIdentity extends CanonicalPathIdentity {
  readonly rootId: string;
}

export interface CanonicalWorkspaceRootIdentityInput {
  readonly rootId: string;
  readonly platform: PermissionEnvironmentPlatform;
  readonly path: string;
  readonly resolvedPath: string;
  readonly resolutionFingerprint: string;
}

export interface CanonicalWorkspaceIdentity {
  readonly workspaceId: string;
  readonly roots: readonly [
    CanonicalWorkspaceRootIdentity,
    ...CanonicalWorkspaceRootIdentity[],
  ];
}

export interface CanonicalWorkspaceIdentityInput {
  readonly workspaceId: string;
  readonly roots: readonly CanonicalWorkspaceRootIdentityInput[];
}

export type CanonicalActorKind = "user" | "service" | "anonymous";

export interface CanonicalActorIdentity {
  readonly identityId: string;
  readonly kind: CanonicalActorKind;
}

export interface CanonicalEnvironmentIdentity {
  readonly environmentId: string;
  readonly platform: PermissionEnvironmentPlatform;
  readonly configurationFingerprint: string;
}

export interface CanonicalEnvironmentIdentityInput {
  readonly environmentId: string;
  readonly platform: PermissionEnvironmentPlatform;
  readonly configurationFingerprint: string;
}

export interface CanonicalFileSystemTarget {
  readonly path: CanonicalPathIdentity;
}

export type FileSystemObjectIdentity =
  | {
      readonly kind: "win32";
      readonly volumeId: string;
      readonly fileId: string;
    }
  | {
      readonly kind: "posix";
      readonly deviceId: string;
      readonly inode: string;
    };

export type FileBaseline =
  | { readonly kind: "absent" }
  | {
      readonly kind: "present";
      readonly entryKind: "file" | "directory" | "other";
      readonly objectIdentity: FileSystemObjectIdentity;
      readonly contentDigest: string | null;
    };

export interface CanonicalExecutableIdentity {
  readonly path: CanonicalPathIdentity;
  readonly baseline: FileBaseline & { readonly kind: "present"; readonly entryKind: "file" };
}

export interface CanonicalExecutableIdentityInput {
  readonly path: CanonicalPathIdentityInput;
  readonly baseline: FileBaseline;
}

export type CanonicalNetworkTransport = "tcp" | "udp";

export interface CanonicalNetworkEndpoint {
  readonly transport: CanonicalNetworkTransport;
  readonly host: string;
  readonly port: number;
  readonly applicationProtocol: string | null;
}

export type CanonicalRemoteTransport = "stdio" | "http" | "https" | "websocket";

export interface CanonicalRemoteServerIdentity {
  readonly serverId: string;
  readonly registrationFingerprint: string;
  readonly transport: CanonicalRemoteTransport;
  readonly endpoint: CanonicalNetworkEndpoint | null;
}

export interface CanonicalRemoteToolIdentity {
  readonly server: CanonicalRemoteServerIdentity;
  readonly toolName: string;
}

export function createCanonicalPathIdentity(
  input: CanonicalPathIdentityInput,
): CanonicalPathIdentity {
  assertStrictRecord(
    input,
    "pathIdentity",
    new Set(["platform", "path", "resolvedPath", "workspaceRootId", "resolutionFingerprint"]),
    "canonical_path_invalid",
  );
  const platform = validatePlatform(input.platform, "pathIdentity.platform");
  const canonicalPath = canonicalizeAbsolutePath(input.path, platform, "pathIdentity.path");
  const resolvedPath = input.resolvedPath === null
    ? null
    : canonicalizeAbsolutePath(input.resolvedPath, platform, "pathIdentity.resolvedPath");
  const workspaceRootId = input.workspaceRootId === null
    ? null
    : validateToken(input.workspaceRootId, "pathIdentity.workspaceRootId");
  return Object.freeze({
    platform,
    canonicalPath,
    comparisonKey: canonicalPathComparisonKey(canonicalPath, platform),
    resolvedPath,
    resolvedComparisonKey: resolvedPath === null
      ? null
      : canonicalPathComparisonKey(resolvedPath, platform),
    workspaceRootId,
    resolutionFingerprint: validateDigest(
      input.resolutionFingerprint,
      "pathIdentity.resolutionFingerprint",
    ),
  });
}

export function createCanonicalWorkspaceIdentity(
  input: CanonicalWorkspaceIdentityInput,
): CanonicalWorkspaceIdentity {
  assertStrictRecord(
    input,
    "workspace",
    new Set(["workspaceId", "roots"]),
    "canonical_contract_invalid",
  );
  const workspaceId = validateToken(input.workspaceId, "workspace.workspaceId");
  assertCanonicalArray(input.roots, "workspace.roots", "canonical_contract_invalid", 256);
  if (input.roots.length === 0) {
    throw contractError(
      "canonical_contract_invalid",
      "A canonical workspace requires at least one root.",
      "workspace.roots",
    );
  }
  const roots = input.roots.map((root, index) => createWorkspaceRoot(root, `workspace.roots[${index}]`));
  roots.sort((left, right) => compareCanonicalStrings(left.rootId, right.rootId));
  rejectDuplicates(roots, (root) => root.rootId, "workspace.roots", "root id");
  rejectDuplicates(
    roots,
    canonicalPathTargetKey,
    "workspace.roots",
    "root path",
  );
  return Object.freeze({
    workspaceId,
    roots: Object.freeze(roots) as unknown as CanonicalWorkspaceIdentity["roots"],
  });
}

export function createCanonicalActorIdentity(
  input: CanonicalActorIdentity,
): CanonicalActorIdentity {
  assertStrictRecord(
    input,
    "actor",
    new Set(["identityId", "kind"]),
    "canonical_contract_invalid",
  );
  if (input.kind !== "user" && input.kind !== "service" && input.kind !== "anonymous") {
    throw contractError("canonical_contract_invalid", "Invalid actor kind.", "actor.kind");
  }
  return Object.freeze({
    identityId: validateToken(input.identityId, "actor.identityId"),
    kind: input.kind,
  });
}

export function createCanonicalWorkspaceRootIdentity(
  input: CanonicalWorkspaceRootIdentityInput,
): CanonicalWorkspaceRootIdentity {
  return createWorkspaceRoot(input, "workspaceRoot");
}

export function createCanonicalEnvironmentIdentity(
  input: CanonicalEnvironmentIdentityInput,
): CanonicalEnvironmentIdentity {
  assertStrictRecord(
    input,
    "environment",
    new Set(["environmentId", "platform", "configurationFingerprint"]),
    "canonical_contract_invalid",
  );
  return Object.freeze({
    environmentId: validateToken(input.environmentId, "environment.environmentId"),
    platform: validatePlatform(input.platform, "environment.platform"),
    configurationFingerprint: validateDigest(
      input.configurationFingerprint,
      "environment.configurationFingerprint",
    ),
  });
}

export function createCanonicalFileSystemTarget(
  input: CanonicalPathIdentityInput,
): CanonicalFileSystemTarget {
  return Object.freeze({ path: createCanonicalPathIdentity(input) });
}

export function createFileBaseline(input: FileBaseline): FileBaseline {
  if (input?.kind === "absent") {
    assertStrictRecord(input, "baseline", new Set(["kind"]), "canonical_contract_invalid");
    return Object.freeze({ kind: "absent" });
  }
  assertStrictRecord(
    input,
    "baseline",
    new Set(["kind", "entryKind", "objectIdentity", "contentDigest"]),
    "canonical_contract_invalid",
  );
  if (input.kind !== "present") {
    throw contractError("canonical_contract_invalid", "Invalid file baseline kind.", "baseline.kind");
  }
  if (input.entryKind !== "file" && input.entryKind !== "directory" && input.entryKind !== "other") {
    throw contractError(
      "canonical_contract_invalid",
      "Invalid file baseline entry kind.",
      "baseline.entryKind",
    );
  }
  const contentDigest = input.contentDigest === null
    ? null
    : validateDigest(input.contentDigest, "baseline.contentDigest");
  if (input.entryKind === "file" && contentDigest === null) {
    throw contractError(
      "canonical_contract_invalid",
      "A present file baseline requires a content digest.",
      "baseline.contentDigest",
    );
  }
  if (input.entryKind !== "file" && contentDigest !== null) {
    throw contractError(
      "canonical_contract_invalid",
      "Only file baselines may carry a content digest.",
      "baseline.contentDigest",
    );
  }
  return Object.freeze({
    kind: "present",
    entryKind: input.entryKind,
    objectIdentity: createFileSystemObjectIdentity(input.objectIdentity),
    contentDigest,
  });
}

export function createCanonicalExecutableIdentity(input: {
  readonly path: CanonicalPathIdentityInput;
  readonly baseline: FileBaseline;
}): CanonicalExecutableIdentity {
  assertStrictRecord(
    input,
    "executable",
    new Set(["path", "baseline"]),
    "canonical_contract_invalid",
  );
  const path = createCanonicalPathIdentity(input.path);
  const baseline = createFileBaseline(input.baseline);
  if (baseline.kind !== "present" || baseline.entryKind !== "file") {
    throw contractError(
      "canonical_contract_invalid",
      "An executable requires a present file baseline.",
      "executable.baseline",
    );
  }
  return Object.freeze({
    path,
    baseline: Object.freeze({
      kind: "present" as const,
      entryKind: "file" as const,
      objectIdentity: baseline.objectIdentity,
      contentDigest: baseline.contentDigest,
    }),
  });
}

export function createCanonicalNetworkEndpoint(
  input: CanonicalNetworkEndpoint,
): CanonicalNetworkEndpoint {
  assertStrictRecord(
    input,
    "endpoint",
    new Set(["transport", "host", "port", "applicationProtocol"]),
    "canonical_endpoint_invalid",
  );
  if (input.transport !== "tcp" && input.transport !== "udp") {
    throw contractError("canonical_endpoint_invalid", "Invalid network transport.", "endpoint.transport");
  }
  return Object.freeze({
    transport: input.transport,
    host: canonicalizeConcreteHost(input.host, "endpoint.host"),
    port: validatePort(input.port, "endpoint.port"),
    applicationProtocol: input.applicationProtocol === null
      ? null
      : validateToken(input.applicationProtocol.toLowerCase(), "endpoint.applicationProtocol"),
  });
}

export function createCanonicalRemoteServerIdentity(
  input: CanonicalRemoteServerIdentity,
): CanonicalRemoteServerIdentity {
  assertStrictRecord(
    input,
    "remoteServer",
    new Set(["serverId", "registrationFingerprint", "transport", "endpoint"]),
    "canonical_contract_invalid",
  );
  if (
    input.transport !== "stdio" &&
    input.transport !== "http" &&
    input.transport !== "https" &&
    input.transport !== "websocket"
  ) {
    throw contractError("canonical_contract_invalid", "Invalid remote transport.", "remoteServer.transport");
  }
  if ((input.transport === "stdio") !== (input.endpoint === null)) {
    throw contractError(
      "canonical_contract_invalid",
      "stdio requires no endpoint and network transports require one endpoint.",
      "remoteServer.endpoint",
    );
  }
  return Object.freeze({
    serverId: validateToken(input.serverId, "remoteServer.serverId"),
    registrationFingerprint: validateToken(
      input.registrationFingerprint,
      "remoteServer.registrationFingerprint",
      "canonical_token_invalid",
      4_096,
    ),
    transport: input.transport,
    endpoint: input.endpoint === null ? null : createCanonicalNetworkEndpoint(input.endpoint),
  });
}

export function createCanonicalRemoteToolIdentity(
  input: CanonicalRemoteToolIdentity,
): CanonicalRemoteToolIdentity {
  assertStrictRecord(
    input,
    "remoteTool",
    new Set(["server", "toolName"]),
    "canonical_contract_invalid",
  );
  return Object.freeze({
    server: createCanonicalRemoteServerIdentity(input.server),
    toolName: validateToken(input.toolName, "remoteTool.toolName"),
  });
}

export function canonicalPathIdentityKey(identity: CanonicalPathIdentity): string {
  return `${identity.platform}:${identity.comparisonKey}:${identity.resolvedComparisonKey ?? ""}:${identity.resolutionFingerprint}`;
}

export function canonicalPathTargetKey(identity: CanonicalPathIdentity): string {
  return `${identity.platform}:${identity.resolvedComparisonKey ?? identity.comparisonKey}`;
}

export function canonicalEndpointKey(endpoint: CanonicalNetworkEndpoint): string {
  return `${endpoint.transport}:${endpoint.host}:${endpoint.port}:${endpoint.applicationProtocol ?? ""}`;
}

export function canonicalRemoteToolKey(target: CanonicalRemoteToolIdentity): string {
  return `${target.server.serverId}:${target.server.registrationFingerprint}:${target.toolName}`;
}

export function canonicalRemoteToolTargetKey(target: CanonicalRemoteToolIdentity): string {
  return `${target.server.serverId}:${target.toolName}`;
}

function createWorkspaceRoot(
  input: CanonicalWorkspaceRootIdentityInput,
  pathPrefix: string,
): CanonicalWorkspaceRootIdentity {
  assertStrictRecord(
    input,
    pathPrefix,
    new Set(["rootId", "platform", "path", "resolvedPath", "resolutionFingerprint"]),
    "canonical_contract_invalid",
  );
  const rootId = validateToken(input.rootId, `${pathPrefix}.rootId`);
  const path = createCanonicalPathIdentity({
    platform: input.platform,
    path: input.path,
    resolvedPath: input.resolvedPath,
    workspaceRootId: rootId,
    resolutionFingerprint: input.resolutionFingerprint,
  });
  return Object.freeze({ rootId, ...path });
}

function createFileSystemObjectIdentity(
  input: FileSystemObjectIdentity,
): FileSystemObjectIdentity {
  if (input?.kind === "win32") {
    assertStrictRecord(
      input,
      "baseline.objectIdentity",
      new Set(["kind", "volumeId", "fileId"]),
      "canonical_contract_invalid",
    );
    return Object.freeze({
      kind: "win32",
      volumeId: validateToken(input.volumeId, "baseline.objectIdentity.volumeId"),
      fileId: validateToken(input.fileId, "baseline.objectIdentity.fileId"),
    });
  }
  assertStrictRecord(
    input,
    "baseline.objectIdentity",
    new Set(["kind", "deviceId", "inode"]),
    "canonical_contract_invalid",
  );
  if (input.kind !== "posix") {
    throw contractError(
      "canonical_contract_invalid",
      "Invalid filesystem object identity kind.",
      "baseline.objectIdentity.kind",
    );
  }
  return Object.freeze({
    kind: "posix",
    deviceId: validateToken(input.deviceId, "baseline.objectIdentity.deviceId"),
    inode: validateToken(input.inode, "baseline.objectIdentity.inode"),
  });
}

function rejectDuplicates<T>(
  values: readonly T[],
  key: (value: T) => string,
  path: string,
  label: string,
): void {
  const seen = new Set<string>();
  for (const value of values) {
    const candidate = key(value);
    if (seen.has(candidate)) {
      throw contractError("canonical_duplicate", `Duplicate ${label}: ${candidate}.`, path);
    }
    seen.add(candidate);
  }
}
