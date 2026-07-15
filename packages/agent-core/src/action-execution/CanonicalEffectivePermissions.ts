import type { PermissionEnforcement } from "@agent-anything/permission/profile";
import {
  canonicalEndpointKey,
  canonicalPathTargetKey,
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

export type CanonicalPermissionScope<T> =
  | { readonly kind: "none" }
  | { readonly kind: "unrestricted" }
  | { readonly kind: "restricted"; readonly values: readonly [T, ...T[]] };

export interface CanonicalEffectivePermissions {
  readonly schemaVersion: 1;
  readonly enforcement: PermissionEnforcement;
  readonly fileSystem: {
    readonly read: CanonicalPermissionScope<CanonicalFileSystemTarget>;
    readonly write: CanonicalPermissionScope<CanonicalFileSystemTarget>;
  };
  readonly process: {
    readonly spawn: CanonicalPermissionScope<CanonicalExecutableIdentity>;
  };
  readonly network: {
    readonly connect: CanonicalPermissionScope<CanonicalNetworkEndpoint>;
  };
  readonly remoteTool: {
    readonly invoke: CanonicalPermissionScope<CanonicalRemoteToolIdentity>;
  };
}

export type CanonicalPermissionScopeInput<T> =
  | { readonly kind: "none" }
  | { readonly kind: "unrestricted" }
  | { readonly kind: "restricted"; readonly values: readonly T[] };

export interface CanonicalEffectivePermissionsInput {
  readonly enforcement: PermissionEnforcement;
  readonly fileSystem: {
    readonly read: CanonicalPermissionScopeInput<CanonicalPathIdentityInput>;
    readonly write: CanonicalPermissionScopeInput<CanonicalPathIdentityInput>;
  };
  readonly process: {
    readonly spawn: CanonicalPermissionScopeInput<CanonicalExecutableIdentityInput>;
  };
  readonly network: {
    readonly connect: CanonicalPermissionScopeInput<CanonicalNetworkEndpoint>;
  };
  readonly remoteTool: {
    readonly invoke: CanonicalPermissionScopeInput<CanonicalRemoteToolIdentity>;
  };
}

export function createCanonicalEffectivePermissions(
  input: CanonicalEffectivePermissionsInput,
): CanonicalEffectivePermissions {
  assertStrictRecord(
    input,
    "effectivePermissions",
    new Set(["enforcement", "fileSystem", "process", "network", "remoteTool"]),
    "canonical_permission_invalid",
  );
  if (input.enforcement !== "managed" && input.enforcement !== "external" && input.enforcement !== "disabled") {
    throw contractError(
      "canonical_permission_invalid",
      "Invalid permission enforcement kind.",
      "effectivePermissions.enforcement",
    );
  }
  assertStrictRecord(
    input.fileSystem,
    "effectivePermissions.fileSystem",
    new Set(["read", "write"]),
    "canonical_permission_invalid",
  );
  assertStrictRecord(
    input.process,
    "effectivePermissions.process",
    new Set(["spawn"]),
    "canonical_permission_invalid",
  );
  assertStrictRecord(
    input.network,
    "effectivePermissions.network",
    new Set(["connect"]),
    "canonical_permission_invalid",
  );
  assertStrictRecord(
    input.remoteTool,
    "effectivePermissions.remoteTool",
    new Set(["invoke"]),
    "canonical_permission_invalid",
  );

  return Object.freeze({
    schemaVersion: 1,
    enforcement: input.enforcement,
    fileSystem: Object.freeze({
      read: createScope(
        input.fileSystem.read,
        "effectivePermissions.fileSystem.read",
        createCanonicalFileSystemTarget,
        (target) => canonicalPathTargetKey(target.path),
      ),
      write: createScope(
        input.fileSystem.write,
        "effectivePermissions.fileSystem.write",
        createCanonicalFileSystemTarget,
        (target) => canonicalPathTargetKey(target.path),
      ),
    }),
    process: Object.freeze({
      spawn: createScope(
        input.process.spawn,
        "effectivePermissions.process.spawn",
        createCanonicalExecutableIdentity,
        (executable) => canonicalPathTargetKey(executable.path),
      ),
    }),
    network: Object.freeze({
      connect: createScope(
        input.network.connect,
        "effectivePermissions.network.connect",
        createCanonicalNetworkEndpoint,
        canonicalEndpointKey,
      ),
    }),
    remoteTool: Object.freeze({
      invoke: createScope(
        input.remoteTool.invoke,
        "effectivePermissions.remoteTool.invoke",
        createCanonicalRemoteToolIdentity,
        canonicalRemoteToolTargetKey,
      ),
    }),
  });
}

function createScope<TInput, TOutput>(
  input: CanonicalPermissionScopeInput<TInput>,
  path: string,
  createValue: (input: TInput) => TOutput,
  key: (value: TOutput) => string,
): CanonicalPermissionScope<TOutput> {
  if (input?.kind === "none" || input?.kind === "unrestricted") {
    assertStrictRecord(input, path, new Set(["kind"]), "canonical_permission_invalid");
    return Object.freeze({ kind: input.kind });
  }
  assertStrictRecord(input, path, new Set(["kind", "values"]), "canonical_permission_invalid");
  if (input.kind !== "restricted") {
    throw contractError("canonical_permission_invalid", "Invalid permission scope.", `${path}.kind`);
  }
  assertCanonicalArray(input.values, `${path}.values`, "canonical_permission_invalid", 4_096);
  if (input.values.length === 0) {
    throw contractError(
      "canonical_permission_invalid",
      "A restricted permission scope requires at least one value.",
      `${path}.values`,
    );
  }
  const values = input.values.map(createValue);
  values.sort((left, right) => compareCanonicalStrings(key(left), key(right)));
  for (let index = 1; index < values.length; index += 1) {
    if (key(values[index - 1]!) === key(values[index]!)) {
      throw contractError(
        "canonical_duplicate",
        `Duplicate permission target: ${key(values[index]!)}.`,
        `${path}.values`,
      );
    }
  }
  return Object.freeze({
    kind: "restricted",
    values: Object.freeze(values) as unknown as readonly [TOutput, ...TOutput[]],
  });
}
