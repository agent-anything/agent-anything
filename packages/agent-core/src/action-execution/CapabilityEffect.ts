import {
  canonicalEndpointKey,
  canonicalPathIdentityKey,
  canonicalPathTargetKey,
  canonicalRemoteToolKey,
  canonicalRemoteToolTargetKey,
  createCanonicalExecutableIdentity,
  createCanonicalFileSystemTarget,
  createCanonicalNetworkEndpoint,
  createCanonicalRemoteToolIdentity,
  type CanonicalExecutableIdentity,
  type CanonicalExecutableIdentityInput,
  type CanonicalFileSystemTarget,
  type CanonicalNetworkEndpoint,
  type CanonicalPathIdentityInput,
  type CanonicalRemoteToolIdentity,
} from "./CanonicalIdentity.js";
import {
  assertCanonicalArray,
  assertStrictRecord,
  compareCanonicalStrings,
  contractError,
} from "./ActionContractValidation.js";

export interface FileSystemEffect {
  readonly schemaVersion: 1;
  readonly kind: "file_system";
  readonly operation: "read" | "write";
  readonly targets: readonly [CanonicalFileSystemTarget, ...CanonicalFileSystemTarget[]];
}

export interface ProcessSpawnEffect {
  readonly schemaVersion: 1;
  readonly kind: "process";
  readonly operation: "spawn";
  readonly executable: CanonicalExecutableIdentity;
}

export interface NetworkConnectEffect {
  readonly schemaVersion: 1;
  readonly kind: "network";
  readonly operation: "connect";
  readonly endpoints: readonly [CanonicalNetworkEndpoint, ...CanonicalNetworkEndpoint[]];
}

export interface RemoteToolInvokeEffect {
  readonly schemaVersion: 1;
  readonly kind: "remote_tool";
  readonly operation: "invoke";
  readonly target: CanonicalRemoteToolIdentity;
}

export type CapabilityEffect =
  | FileSystemEffect
  | ProcessSpawnEffect
  | NetworkConnectEffect
  | RemoteToolInvokeEffect;

export type ActionEffectSet =
  | { readonly kind: "effect_free" }
  | {
      readonly kind: "effects";
      readonly values: readonly [CapabilityEffect, ...CapabilityEffect[]];
    };

export type CapabilityEffectInput =
  | {
      readonly kind: "file_system";
      readonly operation: "read" | "write";
      readonly targets: readonly CanonicalPathIdentityInput[];
    }
  | {
      readonly kind: "process";
      readonly operation: "spawn";
      readonly executable: CanonicalExecutableIdentityInput;
    }
  | {
      readonly kind: "network";
      readonly operation: "connect";
      readonly endpoints: readonly CanonicalNetworkEndpoint[];
    }
  | {
      readonly kind: "remote_tool";
      readonly operation: "invoke";
      readonly target: CanonicalRemoteToolIdentity;
    };

export type ActionEffectSetInput =
  | { readonly kind: "effect_free" }
  | { readonly kind: "effects"; readonly values: readonly CapabilityEffectInput[] };

export function createActionEffectSet(input: ActionEffectSetInput): ActionEffectSet {
  if (input?.kind === "effect_free") {
    assertStrictRecord(input, "effectSet", new Set(["kind"]), "canonical_effect_invalid");
    return Object.freeze({ kind: "effect_free" });
  }
  assertStrictRecord(
    input,
    "effectSet",
    new Set(["kind", "values"]),
    "canonical_effect_invalid",
  );
  if (input.kind !== "effects") {
    throw contractError("canonical_effect_invalid", "Unknown Action effect-set kind.", "effectSet.kind");
  }
  assertCanonicalArray(input.values, "effectSet.values", "canonical_effect_invalid", 1_024);
  if (input.values.length === 0) {
    throw contractError(
      "canonical_effect_invalid",
      "An effects set requires at least one CapabilityEffect.",
      "effectSet.values",
    );
  }

  const keyed = input.values.map((effect, index) => {
    const value = createCapabilityEffect(effect, index);
    return { key: capabilityEffectKey(value), value };
  });
  rejectOverlappingEffectTargets(keyed.map(({ value }) => value));
  keyed.sort((left, right) => compareCanonicalStrings(left.key, right.key));
  for (let index = 1; index < keyed.length; index += 1) {
    if (keyed[index - 1]!.key === keyed[index]!.key) {
      throw contractError(
        "canonical_duplicate",
        `Duplicate CapabilityEffect: ${keyed[index]!.key}.`,
        "effectSet.values",
      );
    }
  }
  return Object.freeze({
    kind: "effects",
    values: Object.freeze(keyed.map(({ value }) => value)) as unknown as readonly [
      CapabilityEffect,
      ...CapabilityEffect[],
    ],
  });
}

export function capabilityEffectKey(effect: CapabilityEffect): string {
  switch (effect.kind) {
    case "file_system":
      return `file_system:${effect.operation}:${effect.targets
        .map((target) => canonicalPathIdentityKey(target.path))
        .join("|")}`;
    case "process":
      return `process:spawn:${canonicalPathIdentityKey(effect.executable.path)}:${effect.executable.baseline.contentDigest}`;
    case "network":
      return `network:connect:${effect.endpoints.map(canonicalEndpointKey).join("|")}`;
    case "remote_tool":
      return `remote_tool:invoke:${canonicalRemoteToolKey(effect.target)}`;
  }
}

function createCapabilityEffect(
  input: CapabilityEffectInput,
  index: number,
): CapabilityEffect {
  const path = `effectSet.values[${index}]`;
  if (input?.kind === "file_system") {
    assertStrictRecord(
      input,
      path,
      new Set(["kind", "operation", "targets"]),
      "canonical_effect_invalid",
    );
    if (input.operation !== "read" && input.operation !== "write") {
      throw contractError("canonical_effect_invalid", "Invalid filesystem effect operation.", `${path}.operation`);
    }
    assertCanonicalArray(input.targets, `${path}.targets`, "canonical_effect_invalid", 4_096);
    if (input.targets.length === 0) {
      throw contractError("canonical_effect_invalid", "Filesystem effects require targets.", `${path}.targets`);
    }
    const targets = input.targets.map(createCanonicalFileSystemTarget);
    targets.sort((left, right) => compareCanonicalStrings(
      canonicalPathTargetKey(left.path),
      canonicalPathTargetKey(right.path),
    ));
    rejectDuplicateKeys(targets.map((target) => canonicalPathTargetKey(target.path)), `${path}.targets`);
    return Object.freeze({
      schemaVersion: 1,
      kind: "file_system",
      operation: input.operation,
      targets: Object.freeze(targets) as unknown as FileSystemEffect["targets"],
    });
  }
  if (input?.kind === "process") {
    assertStrictRecord(
      input,
      path,
      new Set(["kind", "operation", "executable"]),
      "canonical_effect_invalid",
    );
    if (input.operation !== "spawn") {
      throw contractError("canonical_effect_invalid", "Invalid process effect operation.", `${path}.operation`);
    }
    return Object.freeze({
      schemaVersion: 1,
      kind: "process",
      operation: "spawn",
      executable: createCanonicalExecutableIdentity(input.executable),
    });
  }
  if (input?.kind === "network") {
    assertStrictRecord(
      input,
      path,
      new Set(["kind", "operation", "endpoints"]),
      "canonical_effect_invalid",
    );
    if (input.operation !== "connect") {
      throw contractError("canonical_effect_invalid", "Invalid network effect operation.", `${path}.operation`);
    }
    assertCanonicalArray(input.endpoints, `${path}.endpoints`, "canonical_effect_invalid", 1_024);
    if (input.endpoints.length === 0) {
      throw contractError("canonical_effect_invalid", "Network effects require endpoints.", `${path}.endpoints`);
    }
    const endpoints = input.endpoints.map(createCanonicalNetworkEndpoint);
    endpoints.sort((left, right) => compareCanonicalStrings(
      canonicalEndpointKey(left),
      canonicalEndpointKey(right),
    ));
    rejectDuplicateKeys(endpoints.map(canonicalEndpointKey), `${path}.endpoints`);
    return Object.freeze({
      schemaVersion: 1,
      kind: "network",
      operation: "connect",
      endpoints: Object.freeze(endpoints) as unknown as NetworkConnectEffect["endpoints"],
    });
  }
  if (input?.kind === "remote_tool") {
    assertStrictRecord(
      input,
      path,
      new Set(["kind", "operation", "target"]),
      "canonical_effect_invalid",
    );
    if (input.operation !== "invoke") {
      throw contractError("canonical_effect_invalid", "Invalid remote Tool effect operation.", `${path}.operation`);
    }
    return Object.freeze({
      schemaVersion: 1,
      kind: "remote_tool",
      operation: "invoke",
      target: createCanonicalRemoteToolIdentity(input.target),
    });
  }
  throw contractError("canonical_effect_invalid", "Unknown CapabilityEffect kind.", `${path}.kind`);
}

function rejectDuplicateKeys(keys: readonly string[], path: string): void {
  for (let index = 1; index < keys.length; index += 1) {
    if (keys[index - 1] === keys[index]) {
      throw contractError("canonical_duplicate", `Duplicate canonical target: ${keys[index]}.`, path);
    }
  }
}

function rejectOverlappingEffectTargets(effects: readonly CapabilityEffect[]): void {
  const claims = new Set<string>();
  const add = (claim: string): void => {
    if (claims.has(claim)) {
      throw contractError(
        "canonical_duplicate",
        `CapabilityEffect target is declared more than once: ${claim}.`,
        "effectSet.values",
      );
    }
    claims.add(claim);
  };

  for (const effect of effects) {
    switch (effect.kind) {
      case "file_system":
        for (const target of effect.targets) {
          add(`file_system:${effect.operation}:${canonicalPathTargetKey(target.path)}`);
        }
        break;
      case "process":
        add(`process:spawn:${canonicalPathTargetKey(effect.executable.path)}`);
        break;
      case "network":
        for (const endpoint of effect.endpoints) {
          add(`network:connect:${canonicalEndpointKey(endpoint)}`);
        }
        break;
      case "remote_tool":
        add(`remote_tool:invoke:${canonicalRemoteToolTargetKey(effect.target)}`);
        break;
    }
  }
}
