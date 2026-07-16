import type { CanonicalActionOperation } from "./CanonicalActionOperation.js";
import {
  canonicalEndpointKey,
  canonicalPathIdentityKey,
  canonicalPathTargetKey,
  type CanonicalExecutableIdentity,
  type CanonicalPathIdentity,
  type CanonicalRemoteServerIdentity,
  type CanonicalRemoteToolIdentity,
  type FileBaseline,
} from "./CanonicalIdentity.js";
import type { ActionEffectSet } from "./CapabilityEffect.js";
import type { TargetStateAssertion } from "./TargetStateAssertion.js";
import { contractError } from "./ActionContractValidation.js";

export interface AssertCanonicalActionCoherenceInput {
  readonly operation: CanonicalActionOperation;
  readonly effectSet: ActionEffectSet;
  readonly targetAssertions: readonly TargetStateAssertion[];
}

export function assertCanonicalActionCoherence(
  input: AssertCanonicalActionCoherenceInput,
): void {
  const requiredEffects = operationEffectKeys(input.operation);
  const actualEffects = effectKeys(input.effectSet);
  for (const required of requiredEffects) {
    if (!actualEffects.has(required)) {
      throw contractError(
        "canonical_effect_invalid",
        `Canonical Action operation has no matching primary CapabilityEffect: ${required}.`,
        "effectSet",
      );
    }
  }

  const pathClaims = new Map<string, string>();
  const baselineClaims = new Map<string, string>();
  const remoteServerClaims = new Map<string, string>();
  collectOperationClaims(input.operation, pathClaims, baselineClaims, remoteServerClaims);
  collectEffectClaims(input.effectSet, pathClaims, baselineClaims, remoteServerClaims);
  collectAssertionClaims(
    input.targetAssertions,
    pathClaims,
    baselineClaims,
    remoteServerClaims,
  );
}

function operationEffectKeys(operation: CanonicalActionOperation): ReadonlySet<string> {
  const keys = new Set<string>();
  switch (operation.kind) {
    case "file_system":
      for (const entry of operation.operations) {
        if ("target" in entry) {
          keys.add(fileEffectKey(
            entry.operation === "read" || entry.operation === "list" || entry.operation === "search"
              ? "read"
              : "write",
            entry.target.path,
          ));
        } else if (entry.operation === "copy") {
          keys.add(fileEffectKey("read", entry.source.path));
          keys.add(fileEffectKey("write", entry.destination.path));
        } else {
          keys.add(fileEffectKey("write", entry.source.path));
          keys.add(fileEffectKey("write", entry.destination.path));
        }
      }
      break;
    case "process":
      keys.add(`process:spawn:${executableKey(operation.executable)}`);
      break;
    case "network":
      keys.add(`network:connect:${canonicalEndpointKey(operation.endpoint)}`);
      break;
    case "remote_tool":
      keys.add(`remote_tool:invoke:${remoteToolIdentityKey(operation.target)}`);
      break;
    case "skill":
      break;
  }
  return keys;
}

function effectKeys(effectSet: ActionEffectSet): ReadonlySet<string> {
  const keys = new Set<string>();
  if (effectSet.kind === "effect_free") return keys;
  for (const effect of effectSet.values) {
    switch (effect.kind) {
      case "file_system":
        for (const target of effect.targets) {
          keys.add(fileEffectKey(effect.operation, target.path));
        }
        break;
      case "process":
        keys.add(`process:spawn:${executableKey(effect.executable)}`);
        break;
      case "network":
        for (const endpoint of effect.endpoints) {
          keys.add(`network:connect:${canonicalEndpointKey(endpoint)}`);
        }
        break;
      case "remote_tool":
        keys.add(`remote_tool:invoke:${remoteToolIdentityKey(effect.target)}`);
        break;
    }
  }
  return keys;
}

function collectOperationClaims(
  operation: CanonicalActionOperation,
  paths: Map<string, string>,
  baselines: Map<string, string>,
  servers: Map<string, string>,
): void {
  switch (operation.kind) {
    case "file_system":
      for (const entry of operation.operations) {
        if ("target" in entry) {
          addPathClaim(paths, entry.target.path);
        } else {
          addPathClaim(paths, entry.source.path);
          addPathClaim(paths, entry.destination.path);
        }
      }
      break;
    case "process":
      addExecutableClaims(paths, baselines, operation.executable);
      addPathClaim(paths, operation.cwd);
      break;
    case "network":
      break;
    case "remote_tool":
      addRemoteServerClaim(servers, operation.target.server);
      break;
    case "skill":
      break;
  }
}

function collectEffectClaims(
  effectSet: ActionEffectSet,
  paths: Map<string, string>,
  baselines: Map<string, string>,
  servers: Map<string, string>,
): void {
  if (effectSet.kind === "effect_free") return;
  for (const effect of effectSet.values) {
    switch (effect.kind) {
      case "file_system":
        for (const target of effect.targets) addPathClaim(paths, target.path);
        break;
      case "process":
        addExecutableClaims(paths, baselines, effect.executable);
        break;
      case "network":
        break;
      case "remote_tool":
        addRemoteServerClaim(servers, effect.target.server);
        break;
    }
  }
}

function collectAssertionClaims(
  assertions: readonly TargetStateAssertion[],
  paths: Map<string, string>,
  baselines: Map<string, string>,
  servers: Map<string, string>,
): void {
  for (const assertion of assertions) {
    switch (assertion.kind) {
      case "workspace_root_identity":
      case "canonical_path_identity":
        addPathClaim(paths, assertion.expected);
        break;
      case "file_baseline":
        addPathClaim(paths, assertion.path);
        addBaselineClaim(baselines, assertion.path, assertion.expected);
        break;
      case "executable_identity":
        addExecutableClaims(paths, baselines, assertion.expected);
        break;
      case "remote_server_identity":
        addRemoteServerClaim(servers, assertion.expected);
        break;
      case "environment_identity":
      case "adapter_registration":
      case "executor_registration":
        break;
    }
  }
}

function addExecutableClaims(
  paths: Map<string, string>,
  baselines: Map<string, string>,
  executable: CanonicalExecutableIdentity,
): void {
  addPathClaim(paths, executable.path);
  addBaselineClaim(baselines, executable.path, executable.baseline);
}

function addPathClaim(claims: Map<string, string>, identity: CanonicalPathIdentity): void {
  addClaim(
    claims,
    canonicalPathTargetKey(identity),
    canonicalPathIdentityKey(identity),
    "filesystem target",
  );
}

function addBaselineClaim(
  claims: Map<string, string>,
  path: CanonicalPathIdentity,
  baseline: FileBaseline,
): void {
  addClaim(claims, canonicalPathTargetKey(path), baselineKey(baseline), "file baseline");
}

function addRemoteServerClaim(
  claims: Map<string, string>,
  server: CanonicalRemoteServerIdentity,
): void {
  addClaim(claims, server.serverId, remoteServerIdentityKey(server), "remote server");
}

function addClaim(
  claims: Map<string, string>,
  targetKey: string,
  identityKey: string,
  label: string,
): void {
  const existing = claims.get(targetKey);
  if (existing !== undefined && existing !== identityKey) {
    throw contractError(
      "canonical_contract_invalid",
      `Canonical Action contains conflicting ${label} identities for ${targetKey}.`,
      "subject",
    );
  }
  claims.set(targetKey, identityKey);
}

function fileEffectKey(
  operation: "read" | "write",
  path: CanonicalPathIdentity,
): string {
  return `file_system:${operation}:${canonicalPathIdentityKey(path)}`;
}

function executableKey(executable: CanonicalExecutableIdentity): string {
  return `${canonicalPathIdentityKey(executable.path)}:${baselineKey(executable.baseline)}`;
}

function baselineKey(baseline: FileBaseline): string {
  if (baseline.kind === "absent") return "absent";
  const objectIdentity = baseline.objectIdentity.kind === "win32"
    ? `win32:${baseline.objectIdentity.volumeId}:${baseline.objectIdentity.fileId}`
    : `posix:${baseline.objectIdentity.deviceId}:${baseline.objectIdentity.inode}`;
  return `present:${baseline.entryKind}:${objectIdentity}:${baseline.contentDigest ?? ""}`;
}

function remoteToolIdentityKey(target: CanonicalRemoteToolIdentity): string {
  return `${remoteServerIdentityKey(target.server)}:${target.toolName}`;
}

function remoteServerIdentityKey(server: CanonicalRemoteServerIdentity): string {
  return `${server.serverId}:${server.registrationFingerprint}:${server.transport}:${
    server.endpoint === null ? "" : canonicalEndpointKey(server.endpoint)
  }`;
}
