import type {
  ApprovalApplicabilityKey,
  ApprovalCategory,
  ApprovalPayloadByCategory,
  CanonicalAdditionalPermissions,
} from "@agent-anything/permission";
import { canonicalizePermissionDomain } from "@agent-anything/permission/profile";
import type { ISODateTimeString } from "@agent-anything/shared";
import type { Action, ActionProvenance } from "../runner/Action.js";
import {
  assertCanonicalArray,
  assertStrictRecord,
  canonicalizeAbsolutePath,
  canonicalPathComparisonKey,
  compareCanonicalStrings,
  contractError,
  validateBoundedText,
  validateToken,
} from "./ActionContractValidation.js";
import type { ActionRegistration } from "./ActionRegistration.js";
import type { CanonicalActionOperation } from "./CanonicalActionOperation.js";
import type { CanonicalActionSubject } from "./CanonicalActionSubject.js";
import type {
  CanonicalActorIdentity,
  CanonicalEnvironmentIdentity,
  CanonicalWorkspaceIdentity,
} from "./CanonicalIdentity.js";
import type { ActionEffectSet } from "./CapabilityEffect.js";
import type { PreparedActionInvocation } from "./PreparedActionInvocation.js";
import type { SafeActionSummary } from "./SafeActionSummary.js";
import type { TargetStateAssertion } from "./TargetStateAssertion.js";

const preparedExternalActionBrand: unique symbol = Symbol("PreparedExternalAction");

export interface PreparedActionReference {
  readonly id: string;
  readonly runId: string;
  readonly sequence: number;
  readonly kind: "tool";
  readonly name: string;
  readonly provenance: ActionProvenance;
}

export interface PreparedExternalAction<
  TInvocation extends PreparedActionInvocation = PreparedActionInvocation,
> {
  readonly [preparedExternalActionBrand]: true;
  readonly action: PreparedActionReference;
  readonly subject: CanonicalActionSubject;
  readonly actionFingerprint: string;
  readonly approvalCategory: ApprovalCategory | null;
  readonly approvalPayload: ApprovalPayloadByCategory[ApprovalCategory] | null;
  readonly applicabilityKeys: readonly ApprovalApplicabilityKey[];
  readonly safeSummary: SafeActionSummary;
  readonly preparedInvocation: TInvocation;
  readonly preparedAt: ISODateTimeString;
}

export interface CreatePreparedExternalActionInput<
  TInvocation extends PreparedActionInvocation = PreparedActionInvocation,
> {
  readonly action: PreparedActionReference;
  readonly subject: CanonicalActionSubject;
  readonly actionFingerprint: string;
  readonly safeSummary: SafeActionSummary;
  readonly approvalPayload: ApprovalPayloadByCategory[ApprovalCategory] | null;
  readonly preparedInvocation: TInvocation;
  readonly preparedAt: ISODateTimeString;
}

export function createPreparedExternalAction<
  TInvocation extends PreparedActionInvocation,
>(
  input: CreatePreparedExternalActionInput<TInvocation>,
): PreparedExternalAction<TInvocation> {
  return Object.freeze({
    [preparedExternalActionBrand]: true as const,
    action: input.action,
    subject: input.subject,
    actionFingerprint: input.actionFingerprint,
    approvalCategory: input.subject.approvalContext?.category ?? null,
    approvalPayload: input.approvalPayload,
    applicabilityKeys: input.subject.approvalContext?.applicabilityKeys ?? Object.freeze([]),
    safeSummary: input.safeSummary,
    preparedInvocation: input.preparedInvocation,
    preparedAt: input.preparedAt,
  });
}

export function assertPreparedExternalAction(
  input: PreparedExternalAction,
): void {
  if (input === null || typeof input !== "object" ||
    input[preparedExternalActionBrand] !== true || !isDeeplyFrozen(input)) {
    throw contractError(
      "canonical_contract_invalid",
      "Action assessment requires a factory-created immutable PreparedExternalAction.",
      "prepared",
    );
  }
}

function isDeeplyFrozen(input: unknown, seen = new WeakSet<object>()): boolean {
  if (typeof input !== "object" || input === null) return true;
  if (seen.has(input)) return true;
  seen.add(input);
  if (!Object.isFrozen(input)) return false;
  return Reflect.ownKeys(input).every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    return descriptor !== undefined && descriptor.get === undefined &&
      descriptor.set === undefined && isDeeplyFrozen(descriptor.value, seen);
  });
}

export function createPreparedActionReference(
  action: Action,
): PreparedActionReference {
  assertToolAction(action);
  return Object.freeze({
    id: validateToken(action.id, "action.id"),
    runId: validateToken(action.runId, "action.runId"),
    sequence: validatePositiveInteger(action.sequence, "action.sequence"),
    kind: "tool" as const,
    name: validateToken(action.name, "action.name"),
    provenance: Object.freeze({
      modelItemId: validateToken(action.provenance.modelItemId, "action.provenance.modelItemId"),
      controllerIteration: validatePositiveInteger(
        action.provenance.controllerIteration,
        "action.provenance.controllerIteration",
      ),
    }),
  });
}

export interface CreateCanonicalActionSubjectInput {
  readonly action: PreparedActionReference;
  readonly registration: ActionRegistration;
  readonly workspace: CanonicalWorkspaceIdentity;
  readonly actor: CanonicalActorIdentity;
  readonly environment: CanonicalEnvironmentIdentity;
  readonly operation: CanonicalActionOperation;
  readonly effectSet: ActionEffectSet;
  readonly requestedPermissions: CanonicalAdditionalPermissions | null;
  readonly approvalCategory: ApprovalCategory | null;
  readonly applicabilityKeys: readonly ApprovalApplicabilityKey[];
  readonly preparedInvocationDigest: string;
  readonly targetAssertions: readonly TargetStateAssertion[];
}

export function createCanonicalActionSubject(
  input: CreateCanonicalActionSubjectInput,
): CanonicalActionSubject {
  return Object.freeze({
    schemaVersion: 1 as const,
    action: Object.freeze({
      runId: input.action.runId,
      actionId: input.action.id,
      actionName: input.action.name,
    }),
    adapter: Object.freeze({
      id: input.registration.adapter.id,
      version: input.registration.adapter.version,
      inputSchemaVersion: input.registration.adapter.inputSchemaVersion,
      registrationFingerprint: input.registration.registrationFingerprint,
    }),
    executor: Object.freeze({
      id: input.registration.executor.id,
      version: input.registration.executor.version,
      invocationContractVersion: input.registration.executor.invocationContractVersion,
      registrationFingerprint: input.registration.registrationFingerprint,
    }),
    workspace: input.workspace,
    identity: input.actor,
    environment: input.environment,
    operation: input.operation,
    effectSet: input.effectSet,
    requestedPermissions: input.requestedPermissions,
    approvalContext: input.approvalCategory === null
      ? null
      : Object.freeze({
          category: input.approvalCategory,
          applicabilityKeys: input.applicabilityKeys,
        }),
    preparedInvocationDigest: input.preparedInvocationDigest,
    targetAssertions: input.targetAssertions,
  });
}

export function createApprovalApplicabilityKeys(
  category: ApprovalCategory | null,
  inputs: readonly ApprovalApplicabilityKey[],
): readonly ApprovalApplicabilityKey[] {
  assertCanonicalArray(inputs, "applicabilityKeys", "canonical_contract_invalid", 4_096);
  if (category === null && inputs.length > 0) {
    throw contractError(
      "canonical_contract_invalid",
      "An Action without an approval category cannot define applicability keys.",
      "applicabilityKeys",
    );
  }
  const keys = inputs.map((input, index) => {
    const path = `applicabilityKeys[${index}]`;
    assertStrictRecord(
      input,
      path,
      new Set(["category", "value"]),
      "canonical_contract_invalid",
    );
    if (category === null || input.category !== category) {
      throw contractError(
        "canonical_contract_invalid",
        "Approval applicability key category does not match the prepared Action category.",
        `${path}.category`,
      );
    }
    return Object.freeze({
      category,
      value: validateBoundedText(
        input.value,
        `${path}.value`,
        "canonical_contract_invalid",
        4_096,
      ),
    });
  });
  keys.sort((left, right) => compareCanonicalStrings(left.value, right.value));
  for (let index = 1; index < keys.length; index += 1) {
    if (keys[index - 1]!.value === keys[index]!.value) {
      throw contractError(
        "canonical_duplicate",
        `Duplicate approval applicability key: ${keys[index]!.value}.`,
        "applicabilityKeys",
      );
    }
  }
  return Object.freeze(keys);
}

export function snapshotCanonicalAdditionalPermissions(
  input: CanonicalAdditionalPermissions | null,
  environment: CanonicalEnvironmentIdentity,
): CanonicalAdditionalPermissions | null {
  if (input === null) return null;
  assertStrictRecord(
    input,
    "requestedPermissions",
    new Set(["fileSystem", "network"]),
    "canonical_permission_invalid",
  );

  const fileSystem = input.fileSystem === undefined
    ? undefined
    : snapshotFileSystemPermissions(input.fileSystem, environment);
  const network = input.network === undefined
    ? undefined
    : snapshotNetworkPermissions(input.network);
  if (fileSystem === undefined && network === undefined) {
    throw contractError(
      "canonical_permission_invalid",
      "Requested permissions must contain authority or be null.",
      "requestedPermissions",
    );
  }
  return Object.freeze({
    ...(fileSystem === undefined ? {} : { fileSystem }),
    ...(network === undefined ? {} : { network }),
  });
}

export function validateApprovalCategory(input: unknown): ApprovalCategory | null {
  if (input === null) return null;
  if (
    input !== "commandExecution" &&
    input !== "fileChange" &&
    input !== "permissions" &&
    input !== "mcpToolCall" &&
    input !== "skill" &&
    input !== "networkAccess"
  ) {
    throw contractError(
      "canonical_contract_invalid",
      "Unknown approval category.",
      "approvalCategory",
    );
  }
  return input;
}

export function validatePreparedAt(input: unknown): ISODateTimeString {
  if (
    typeof input !== "string" ||
    input.length === 0 ||
    Number.isNaN(Date.parse(input)) ||
    new Date(input).toISOString() !== input
  ) {
    throw contractError(
      "canonical_contract_invalid",
      "preparedAt must be a canonical ISO date-time string.",
      "preparedAt",
    );
  }
  return input;
}

function snapshotFileSystemPermissions(
  input: unknown,
  environment: CanonicalEnvironmentIdentity,
): NonNullable<CanonicalAdditionalPermissions["fileSystem"]> {
  assertStrictRecord(
    input,
    "requestedPermissions.fileSystem",
    new Set(["read", "write"]),
    "canonical_permission_invalid",
  );
  const permissions = input as NonNullable<CanonicalAdditionalPermissions["fileSystem"]>;
  const read = permissions.read === undefined
    ? undefined
    : snapshotPermissionPaths(permissions.read, "requestedPermissions.fileSystem.read", environment);
  const write = permissions.write === undefined
    ? undefined
    : snapshotPermissionPaths(permissions.write, "requestedPermissions.fileSystem.write", environment);
  if (read === undefined && write === undefined) {
    throw contractError(
      "canonical_permission_invalid",
      "Filesystem permission requests must contain read or write paths.",
      "requestedPermissions.fileSystem",
    );
  }
  return Object.freeze({
    ...(read === undefined ? {} : { read }),
    ...(write === undefined ? {} : { write }),
  });
}

function snapshotPermissionPaths(
  input: readonly string[],
  path: string,
  environment: CanonicalEnvironmentIdentity,
): readonly string[] {
  assertCanonicalArray(input, path, "canonical_permission_invalid", 4_096);
  if (input.length === 0) {
    throw contractError(
      "canonical_permission_invalid",
      "Canonical permission path sets cannot be empty.",
      path,
    );
  }
  const values = input.map((value, index) => canonicalizeAbsolutePath(
    value,
    environment.platform,
    `${path}[${index}]`,
  ));
  values.sort((left, right) => compareCanonicalStrings(
    canonicalPathComparisonKey(left, environment.platform),
    canonicalPathComparisonKey(right, environment.platform),
  ));
  rejectDuplicates(
    values.map((value) => canonicalPathComparisonKey(value, environment.platform)),
    path,
  );
  return Object.freeze(values);
}

function snapshotNetworkPermissions(
  input: unknown,
): NonNullable<CanonicalAdditionalPermissions["network"]> {
  assertStrictRecord(
    input,
    "requestedPermissions.network",
    new Set(["enabled", "domains"]),
    "canonical_permission_invalid",
  );
  const permissions = input as NonNullable<CanonicalAdditionalPermissions["network"]>;
  if (permissions.enabled !== true) {
    throw contractError(
      "canonical_permission_invalid",
      "Canonical network permission requests must be enabled.",
      "requestedPermissions.network.enabled",
    );
  }
  if (permissions.domains === undefined) return Object.freeze({ enabled: true as const });
  assertCanonicalArray(
    permissions.domains,
    "requestedPermissions.network.domains",
    "canonical_permission_invalid",
    4_096,
  );
  if (permissions.domains.length === 0) {
    throw contractError(
      "canonical_permission_invalid",
      "Canonical network domain sets cannot be empty.",
      "requestedPermissions.network.domains",
    );
  }
  const domains = permissions.domains.map((domain, index) => {
    try {
      return canonicalizePermissionDomain(domain);
    } catch {
      throw contractError(
        "canonical_permission_invalid",
        "Invalid canonical permission domain.",
        `requestedPermissions.network.domains[${index}]`,
      );
    }
  }).sort(compareCanonicalStrings);
  rejectDuplicates(domains, "requestedPermissions.network.domains");
  return Object.freeze({ enabled: true as const, domains: Object.freeze(domains) });
}

function rejectDuplicates(keys: readonly string[], path: string): void {
  for (let index = 1; index < keys.length; index += 1) {
    if (keys[index - 1] === keys[index]) {
      throw contractError(
        "canonical_duplicate",
        `Duplicate canonical permission target: ${keys[index]}.`,
        path,
      );
    }
  }
}

function assertToolAction(input: Action): void {
  assertStrictRecord(
    input,
    "action",
    new Set(["id", "runId", "sequence", "kind", "name", "input", "provenance"]),
    "canonical_contract_invalid",
  );
  if (input.kind !== "tool") {
    throw contractError(
      "canonical_contract_invalid",
      "Only Tool Actions can be externally prepared.",
      "action.kind",
    );
  }
  assertStrictRecord(
    input.provenance,
    "action.provenance",
    new Set(["modelItemId", "controllerIteration"]),
    "canonical_contract_invalid",
  );
}

function validatePositiveInteger(input: unknown, path: string): number {
  if (!Number.isSafeInteger(input) || (input as number) < 1) {
    throw contractError(
      "canonical_contract_invalid",
      `A positive safe integer is required at ${path}.`,
      path,
    );
  }
  return input as number;
}
