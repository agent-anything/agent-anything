import type {
  ActionAdapterDescriptor,
  ActionExecutorDescriptor,
} from "./ActionRegistration.js";
import {
  canonicalPathTargetKey,
  createCanonicalEnvironmentIdentity,
  createCanonicalExecutableIdentity,
  createCanonicalPathIdentity,
  createCanonicalRemoteServerIdentity,
  createCanonicalWorkspaceRootIdentity,
  createFileBaseline,
  type CanonicalEnvironmentIdentity,
  type CanonicalEnvironmentIdentityInput,
  type CanonicalExecutableIdentity,
  type CanonicalExecutableIdentityInput,
  type CanonicalPathIdentity,
  type CanonicalPathIdentityInput,
  type CanonicalRemoteServerIdentity,
  type CanonicalWorkspaceRootIdentity,
  type CanonicalWorkspaceRootIdentityInput,
  type FileBaseline,
} from "./CanonicalIdentity.js";
import {
  assertCanonicalArray,
  assertStrictRecord,
  compareCanonicalStrings,
  contractError,
  validateToken,
} from "./ActionContractValidation.js";

export interface WorkspaceRootIdentityAssertion {
  readonly schemaVersion: 1;
  readonly kind: "workspace_root_identity";
  readonly expected: CanonicalWorkspaceRootIdentity;
}

export interface CanonicalPathIdentityAssertion {
  readonly schemaVersion: 1;
  readonly kind: "canonical_path_identity";
  readonly expected: CanonicalPathIdentity;
}

export interface FileBaselineAssertion {
  readonly schemaVersion: 1;
  readonly kind: "file_baseline";
  readonly path: CanonicalPathIdentity;
  readonly expected: FileBaseline;
}

export interface ExecutableIdentityAssertion {
  readonly schemaVersion: 1;
  readonly kind: "executable_identity";
  readonly expected: CanonicalExecutableIdentity;
}

export interface EnvironmentIdentityAssertion {
  readonly schemaVersion: 1;
  readonly kind: "environment_identity";
  readonly expected: CanonicalEnvironmentIdentity;
}

export interface AdapterRegistrationAssertion {
  readonly schemaVersion: 1;
  readonly kind: "adapter_registration";
  readonly expected: ActionAdapterDescriptor;
  readonly registrationFingerprint: string;
}

export interface ExecutorRegistrationAssertion {
  readonly schemaVersion: 1;
  readonly kind: "executor_registration";
  readonly expected: ActionExecutorDescriptor;
  readonly registrationFingerprint: string;
}

export interface RemoteServerIdentityAssertion {
  readonly schemaVersion: 1;
  readonly kind: "remote_server_identity";
  readonly expected: CanonicalRemoteServerIdentity;
}

export type TargetStateAssertion =
  | WorkspaceRootIdentityAssertion
  | CanonicalPathIdentityAssertion
  | FileBaselineAssertion
  | ExecutableIdentityAssertion
  | EnvironmentIdentityAssertion
  | AdapterRegistrationAssertion
  | ExecutorRegistrationAssertion
  | RemoteServerIdentityAssertion;

export type TargetStateAssertionInput =
  | { readonly kind: "workspace_root_identity"; readonly expected: CanonicalWorkspaceRootIdentityInput }
  | { readonly kind: "canonical_path_identity"; readonly expected: CanonicalPathIdentityInput }
  | {
      readonly kind: "file_baseline";
      readonly path: CanonicalPathIdentityInput;
      readonly expected: FileBaseline;
    }
  | { readonly kind: "executable_identity"; readonly expected: CanonicalExecutableIdentityInput }
  | { readonly kind: "environment_identity"; readonly expected: CanonicalEnvironmentIdentityInput }
  | {
      readonly kind: "adapter_registration";
      readonly expected: ActionAdapterDescriptor;
      readonly registrationFingerprint: string;
    }
  | {
      readonly kind: "executor_registration";
      readonly expected: ActionExecutorDescriptor;
      readonly registrationFingerprint: string;
    }
  | { readonly kind: "remote_server_identity"; readonly expected: CanonicalRemoteServerIdentity };

export function createTargetStateAssertions(
  inputs: readonly TargetStateAssertionInput[],
): readonly TargetStateAssertion[] {
  assertCanonicalArray(inputs, "targetAssertions", "canonical_assertion_invalid", 8_192);
  const keyed = inputs.map((input, index) => {
    const value = createAssertion(input, index);
    return { key: targetStateAssertionKey(value), value };
  });
  keyed.sort((left, right) => compareCanonicalStrings(left.key, right.key));
  for (let index = 1; index < keyed.length; index += 1) {
    if (keyed[index - 1]!.key === keyed[index]!.key) {
      throw contractError(
        "canonical_duplicate",
        `Duplicate target-state assertion: ${keyed[index]!.key}.`,
        "targetAssertions",
      );
    }
  }
  return Object.freeze(keyed.map(({ value }) => value));
}

export function mergeTargetStateAssertions(
  current: readonly TargetStateAssertion[],
  additions: readonly TargetStateAssertionInput[],
): readonly TargetStateAssertion[] {
  return createTargetStateAssertions([
    ...current.map(targetStateAssertionInput),
    ...additions,
  ]);
}

function targetStateAssertionInput(
  assertion: TargetStateAssertion,
): TargetStateAssertionInput {
  switch (assertion.kind) {
    case "workspace_root_identity":
      return {
        kind: assertion.kind,
        expected: {
          ...pathInput(assertion.expected),
          rootId: assertion.expected.rootId,
          resolvedPath: assertion.expected.resolvedPath ?? assertion.expected.canonicalPath,
        },
      };
    case "canonical_path_identity":
      return { kind: assertion.kind, expected: pathInput(assertion.expected) };
    case "file_baseline":
      return {
        kind: assertion.kind,
        path: pathInput(assertion.path),
        expected: assertion.expected,
      };
    case "executable_identity":
      return {
        kind: assertion.kind,
        expected: {
          path: pathInput(assertion.expected.path),
          baseline: assertion.expected.baseline,
        },
      };
    case "environment_identity":
      return { kind: assertion.kind, expected: assertion.expected };
    case "adapter_registration":
      return {
        kind: assertion.kind,
        expected: assertion.expected,
        registrationFingerprint: assertion.registrationFingerprint,
      };
    case "executor_registration":
      return {
        kind: assertion.kind,
        expected: assertion.expected,
        registrationFingerprint: assertion.registrationFingerprint,
      };
    case "remote_server_identity":
      return { kind: assertion.kind, expected: assertion.expected };
  }
}

function pathInput(path: CanonicalPathIdentity): CanonicalPathIdentityInput {
  return {
    platform: path.platform,
    path: path.canonicalPath,
    resolvedPath: path.resolvedPath,
    workspaceRootId: path.workspaceRootId,
    resolutionFingerprint: path.resolutionFingerprint,
  };
}

export function targetStateAssertionKey(assertion: TargetStateAssertion): string {
  switch (assertion.kind) {
    case "workspace_root_identity":
      return `${assertion.kind}:${assertion.expected.rootId}`;
    case "canonical_path_identity":
      return `${assertion.kind}:${canonicalPathTargetKey(assertion.expected)}`;
    case "file_baseline":
      return `${assertion.kind}:${canonicalPathTargetKey(assertion.path)}`;
    case "executable_identity":
      return `${assertion.kind}:${canonicalPathTargetKey(assertion.expected.path)}`;
    case "environment_identity":
      return `${assertion.kind}:${assertion.expected.environmentId}`;
    case "adapter_registration":
      return `${assertion.kind}:${assertion.expected.id}`;
    case "executor_registration":
      return `${assertion.kind}:${assertion.expected.id}`;
    case "remote_server_identity":
      return `${assertion.kind}:${assertion.expected.serverId}`;
  }
}

function createAssertion(
  input: TargetStateAssertionInput,
  index: number,
): TargetStateAssertion {
  const path = `targetAssertions[${index}]`;
  if (input?.kind === "workspace_root_identity") {
    assertStrictRecord(input, path, new Set(["kind", "expected"]), "canonical_assertion_invalid");
    return Object.freeze({
      schemaVersion: 1,
      kind: "workspace_root_identity",
      expected: createCanonicalWorkspaceRootIdentity(input.expected),
    });
  }
  if (input?.kind === "canonical_path_identity") {
    assertStrictRecord(input, path, new Set(["kind", "expected"]), "canonical_assertion_invalid");
    return Object.freeze({
      schemaVersion: 1,
      kind: "canonical_path_identity",
      expected: createCanonicalPathIdentity(input.expected),
    });
  }
  if (input?.kind === "file_baseline") {
    assertStrictRecord(input, path, new Set(["kind", "path", "expected"]), "canonical_assertion_invalid");
    return Object.freeze({
      schemaVersion: 1,
      kind: "file_baseline",
      path: createCanonicalPathIdentity(input.path),
      expected: createFileBaseline(input.expected),
    });
  }
  if (input?.kind === "executable_identity") {
    assertStrictRecord(input, path, new Set(["kind", "expected"]), "canonical_assertion_invalid");
    return Object.freeze({
      schemaVersion: 1,
      kind: "executable_identity",
      expected: createCanonicalExecutableIdentity(input.expected),
    });
  }
  if (input?.kind === "environment_identity") {
    assertStrictRecord(input, path, new Set(["kind", "expected"]), "canonical_assertion_invalid");
    return Object.freeze({
      schemaVersion: 1,
      kind: "environment_identity",
      expected: createCanonicalEnvironmentIdentity(input.expected),
    });
  }
  if (input?.kind === "adapter_registration") {
    assertStrictRecord(
      input,
      path,
      new Set(["kind", "expected", "registrationFingerprint"]),
      "canonical_assertion_invalid",
    );
    return Object.freeze({
      schemaVersion: 1,
      kind: "adapter_registration",
      expected: createAdapterDescriptor(input.expected, `${path}.expected`),
      registrationFingerprint: validateToken(
        input.registrationFingerprint,
        `${path}.registrationFingerprint`,
        "canonical_assertion_invalid",
        4_096,
      ),
    });
  }
  if (input?.kind === "executor_registration") {
    assertStrictRecord(
      input,
      path,
      new Set(["kind", "expected", "registrationFingerprint"]),
      "canonical_assertion_invalid",
    );
    return Object.freeze({
      schemaVersion: 1,
      kind: "executor_registration",
      expected: createExecutorDescriptor(input.expected, `${path}.expected`),
      registrationFingerprint: validateToken(
        input.registrationFingerprint,
        `${path}.registrationFingerprint`,
        "canonical_assertion_invalid",
        4_096,
      ),
    });
  }
  if (input?.kind === "remote_server_identity") {
    assertStrictRecord(input, path, new Set(["kind", "expected"]), "canonical_assertion_invalid");
    return Object.freeze({
      schemaVersion: 1,
      kind: "remote_server_identity",
      expected: createCanonicalRemoteServerIdentity(input.expected),
    });
  }
  throw contractError("canonical_assertion_invalid", "Unknown target-state assertion kind.", `${path}.kind`);
}

function createAdapterDescriptor(
  input: ActionAdapterDescriptor,
  path: string,
): ActionAdapterDescriptor {
  assertStrictRecord(
    input,
    path,
    new Set(["id", "version", "inputSchemaVersion"]),
    "canonical_assertion_invalid",
  );
  return Object.freeze({
    id: validateToken(input.id, `${path}.id`),
    version: validateToken(input.version, `${path}.version`),
    inputSchemaVersion: validateToken(input.inputSchemaVersion, `${path}.inputSchemaVersion`),
  });
}

function createExecutorDescriptor(
  input: ActionExecutorDescriptor,
  path: string,
): ActionExecutorDescriptor {
  assertStrictRecord(
    input,
    path,
    new Set(["id", "version", "invocationContractVersion"]),
    "canonical_assertion_invalid",
  );
  return Object.freeze({
    id: validateToken(input.id, `${path}.id`),
    version: validateToken(input.version, `${path}.version`),
    invocationContractVersion: validateToken(
      input.invocationContractVersion,
      `${path}.invocationContractVersion`,
    ),
  });
}
