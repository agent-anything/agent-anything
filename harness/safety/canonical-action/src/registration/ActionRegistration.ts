import { createHash } from "node:crypto";
import type {
  OperationBindingRevisionRef,
  OperationRevisionRef,
} from "@agent-anything/operation-catalog/identity";

export interface ActionAdapterDescriptor {
  readonly id: string;
  readonly version: string;
  readonly requestSchemaRevision: string;
}

export interface ActionExecutorDescriptor {
  readonly id: string;
  readonly version: string;
  readonly invocationContractVersion: string;
  readonly physicalPayloadSchemaRevision: string;
}

export type CanonicalEffectFamily =
  | "filesystem"
  | "process"
  | "network"
  | "remote_invocation"
  | "computer_environment";

export interface ActionRegistration {
  readonly registrationId: string;
  readonly revision: string;
  readonly operation: OperationRevisionRef;
  readonly binding: OperationBindingRevisionRef;
  readonly adapter: ActionAdapterDescriptor;
  readonly executor: ActionExecutorDescriptor;
  readonly effectFamilies: readonly CanonicalEffectFamily[];
  readonly sandboxRequirementRevision: string;
  readonly maxInvocationBytes: number;
  readonly maxPhysicalResultBytes: number;
  readonly registrationFingerprint: string;
}

export type ActionRegistrationInput = Omit<
  ActionRegistration,
  "registrationFingerprint"
>;

export interface ActionRegistrationSnapshot {
  readonly schemaVersion: 2;
  readonly snapshotId: string;
  readonly registrations: readonly ActionRegistration[];
}

export type ActionRegistrationValidationCode =
  | "action_registration_invalid"
  | "action_registration_duplicate"
  | "action_operation_duplicate"
  | "action_adapter_duplicate"
  | "action_operation_mismatch"
  | "adapter_descriptor_invalid"
  | "executor_descriptor_invalid";

export class ActionRegistrationValidationError extends TypeError {
  constructor(
    readonly code: ActionRegistrationValidationCode,
    message: string,
    readonly path: string,
  ) {
    super(message);
    this.name = "ActionRegistrationValidationError";
  }
}

const FINGERPRINT_DOMAIN = "agent-anything.action-registration.v2";

export function createActionRegistrationSnapshot(
  inputs: readonly ActionRegistrationInput[],
): ActionRegistrationSnapshot {
  if (!Array.isArray(inputs)) {
    throw validationError(
      "action_registration_invalid",
      "Action registrations must be an array.",
      "registrations",
    );
  }
  assertDenseDataArray(inputs, "registrations");

  const registrationIds = new Set<string>();
  const operationBindings = new Set<string>();
  const adapterKeys = new Set<string>();
  const registrations = inputs.map((input, index) => {
    const path = `registrations[${index}]`;
    const registration = snapshotRegistration(input, path);
    const operationBindingKey = bindingKey(registration.binding);
    const adapterKey = descriptorKey(registration.adapter);
    if (registrationIds.has(registration.registrationId)) {
      throw validationError(
        "action_registration_duplicate",
        `Action registration id is duplicated: ${registration.registrationId}.`,
        `${path}.registrationId`,
      );
    }
    if (operationBindings.has(operationBindingKey)) {
      throw validationError(
        "action_operation_duplicate",
        `Action binding is registered more than once: ${operationBindingKey}.`,
        `${path}.binding`,
      );
    }
    if (adapterKeys.has(adapterKey)) {
      throw validationError(
        "action_adapter_duplicate",
        `Action adapter revision is registered more than once: ${adapterKey}.`,
        `${path}.adapter`,
      );
    }
    registrationIds.add(registration.registrationId);
    operationBindings.add(operationBindingKey);
    adapterKeys.add(adapterKey);
    return registration;
  });

  registrations.sort((left, right) =>
    left.registrationId.localeCompare(right.registrationId)
  );
  const frozen = Object.freeze(registrations);
  return Object.freeze({
    schemaVersion: 2 as const,
    snapshotId: sha256(
      "agent-anything.action-registration-snapshot.v2",
      frozen.map((registration) => registration.registrationFingerprint),
    ),
    registrations: frozen,
  });
}

export function findActionRegistrationByAdapter(
  snapshot: ActionRegistrationSnapshot,
  adapterId: string,
): ActionRegistration | undefined {
  return snapshot.registrations.find(
    (registration) => registration.adapter.id === adapterId,
  );
}

export function findActionRegistrationByBinding(
  snapshot: ActionRegistrationSnapshot,
  binding: OperationBindingRevisionRef,
): ActionRegistration | undefined {
  const expected = bindingKey(binding);
  return snapshot.registrations.find(
    (registration) => bindingKey(registration.binding) === expected,
  );
}

function snapshotRegistration(
  input: ActionRegistrationInput,
  path: string,
): ActionRegistration {
  assertPlainRecord(input, path, [
    "registrationId",
    "revision",
    "operation",
    "binding",
    "adapter",
    "executor",
    "effectFamilies",
    "sandboxRequirementRevision",
    "maxInvocationBytes",
    "maxPhysicalResultBytes",
  ]);
  const operation = snapshotOperation(input.operation, `${path}.operation`);
  const binding = snapshotBinding(input.binding, `${path}.binding`);
  if (operationKey(operation) !== operationKey(binding.operation)) {
    throw validationError(
      "action_operation_mismatch",
      "Action registration binding does not belong to its Operation revision.",
      `${path}.binding.operation`,
    );
  }
  const adapter = snapshotAdapter(input.adapter, `${path}.adapter`);
  const executor = snapshotExecutor(input.executor, `${path}.executor`);
  const effectFamilies = snapshotEffectFamilies(
    input.effectFamilies,
    `${path}.effectFamilies`,
  );
  const base = Object.freeze({
    registrationId: token(input.registrationId, `${path}.registrationId`),
    revision: token(input.revision, `${path}.revision`),
    operation,
    binding,
    adapter,
    executor,
    effectFamilies,
    sandboxRequirementRevision: token(
      input.sandboxRequirementRevision,
      `${path}.sandboxRequirementRevision`,
    ),
    maxInvocationBytes: positiveInteger(
      input.maxInvocationBytes,
      `${path}.maxInvocationBytes`,
    ),
    maxPhysicalResultBytes: positiveInteger(
      input.maxPhysicalResultBytes,
      `${path}.maxPhysicalResultBytes`,
    ),
  });
  return Object.freeze({
    ...base,
    registrationFingerprint: sha256(FINGERPRINT_DOMAIN, base),
  });
}

function snapshotOperation(
  input: OperationRevisionRef,
  path: string,
): OperationRevisionRef {
  assertPlainRecord(input, path, ["operation", "revision"]);
  assertPlainRecord(input.operation, `${path}.operation`, ["namespace", "name"]);
  return Object.freeze({
    operation: Object.freeze({
      namespace: token(input.operation.namespace, `${path}.operation.namespace`),
      name: token(input.operation.name, `${path}.operation.name`),
    }),
    revision: token(input.revision, `${path}.revision`),
  });
}

function snapshotBinding(
  input: OperationBindingRevisionRef,
  path: string,
): OperationBindingRevisionRef {
  assertPlainRecord(input, path, ["operation", "revision"]);
  return Object.freeze({
    operation: snapshotOperation(input.operation, `${path}.operation`),
    revision: token(input.revision, `${path}.revision`),
  });
}

function snapshotAdapter(
  input: ActionAdapterDescriptor,
  path: string,
): ActionAdapterDescriptor {
  assertPlainRecord(
    input,
    path,
    ["id", "version", "requestSchemaRevision"],
    "adapter_descriptor_invalid",
  );
  return Object.freeze({
    id: token(input.id, `${path}.id`),
    version: token(input.version, `${path}.version`),
    requestSchemaRevision: token(
      input.requestSchemaRevision,
      `${path}.requestSchemaRevision`,
    ),
  });
}

function snapshotExecutor(
  input: ActionExecutorDescriptor,
  path: string,
): ActionExecutorDescriptor {
  assertPlainRecord(
    input,
    path,
    [
      "id",
      "version",
      "invocationContractVersion",
      "physicalPayloadSchemaRevision",
    ],
    "executor_descriptor_invalid",
  );
  return Object.freeze({
    id: token(input.id, `${path}.id`),
    version: token(input.version, `${path}.version`),
    invocationContractVersion: token(
      input.invocationContractVersion,
      `${path}.invocationContractVersion`,
    ),
    physicalPayloadSchemaRevision: token(
      input.physicalPayloadSchemaRevision,
      `${path}.physicalPayloadSchemaRevision`,
    ),
  });
}

function snapshotEffectFamilies(
  input: readonly CanonicalEffectFamily[],
  path: string,
): readonly CanonicalEffectFamily[] {
  if (!Array.isArray(input) || input.length === 0) {
    throw validationError(
      "action_registration_invalid",
      "Action registration requires at least one effect family.",
      path,
    );
  }
  assertDenseDataArray(input, path);
  const allowed = new Set<CanonicalEffectFamily>([
    "filesystem",
    "process",
    "network",
    "remote_invocation",
    "computer_environment",
  ]);
  const values = [...new Set(input)];
  if (values.length !== input.length || values.some((value) => !allowed.has(value))) {
    throw validationError(
      "action_registration_invalid",
      "Action registration effect families must be unique supported values.",
      path,
    );
  }
  return Object.freeze(values.sort());
}

function assertPlainRecord(
  input: unknown,
  path: string,
  fields: readonly string[],
  code: ActionRegistrationValidationCode = "action_registration_invalid",
): asserts input is Record<string, unknown> {
  if (
    input === null ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.getPrototypeOf(input) !== Object.prototype
  ) {
    throw validationError(
      code,
      `A plain object is required at ${path}.`,
      path,
    );
  }
  const keys = Object.keys(input);
  if (
    Reflect.ownKeys(input).length !== keys.length ||
    keys.length !== fields.length ||
    keys.some((key) => !fields.includes(key))
  ) {
    throw validationError(
      code,
      `Action registration has unsupported or missing fields at ${path}.`,
      path,
    );
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (
      descriptor === undefined ||
      descriptor.get !== undefined ||
      descriptor.set !== undefined ||
      !descriptor.enumerable
    ) {
      throw validationError(
        code,
        `Action registration requires enumerable data properties at ${path}.${key}.`,
        `${path}.${key}`,
      );
    }
  }
}

function assertDenseDataArray(input: readonly unknown[], path: string): void {
  const keys = Reflect.ownKeys(input);
  for (const key of keys) {
    if (key === "length") continue;
    if (
      typeof key !== "string" ||
      !/^(0|[1-9][0-9]*)$/.test(key) ||
      Number(key) >= input.length
    ) {
      throw validationError(
        "action_registration_invalid",
        `Action registration array has an unsupported property at ${path}.${String(key)}.`,
        path,
      );
    }
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (
      descriptor === undefined ||
      descriptor.get !== undefined ||
      descriptor.set !== undefined ||
      !descriptor.enumerable
    ) {
      throw validationError(
        "action_registration_invalid",
        `Action registration array requires enumerable data properties at ${path}[${key}].`,
        `${path}[${key}]`,
      );
    }
  }
  for (let index = 0; index < input.length; index += 1) {
    if (!Object.hasOwn(input, index)) {
      throw validationError(
        "action_registration_invalid",
        `Action registration array is sparse at ${path}[${index}].`,
        `${path}[${index}]`,
      );
    }
  }
}

function token(input: unknown, path: string): string {
  if (
    typeof input !== "string" ||
    input.length === 0 ||
    input.length > 1_024 ||
    input !== input.trim() ||
    !/^[A-Za-z0-9][A-Za-z0-9._:/+-]*$/.test(input)
  ) {
    throw validationError(
      "action_registration_invalid",
      `A canonical token is required at ${path}.`,
      path,
    );
  }
  return input;
}

function positiveInteger(input: unknown, path: string): number {
  if (!Number.isSafeInteger(input) || (input as number) < 1) {
    throw validationError(
      "action_registration_invalid",
      `A positive safe integer is required at ${path}.`,
      path,
    );
  }
  return input as number;
}

function operationKey(input: OperationRevisionRef): string {
  return `${input.operation.namespace}/${input.operation.name}@${input.revision}`;
}

function bindingKey(input: OperationBindingRevisionRef): string {
  return `${operationKey(input.operation)}#${input.revision}`;
}

function descriptorKey(input: ActionAdapterDescriptor): string {
  return `${input.id}@${input.version}#${input.requestSchemaRevision}`;
}

function sha256(domain: string, input: unknown): string {
  return `sha256:${createHash("sha256")
    .update(domain, "utf8")
    .update("\0", "utf8")
    .update(JSON.stringify(input), "utf8")
    .digest("hex")}`;
}

function validationError(
  code: ActionRegistrationValidationCode,
  message: string,
  path: string,
): ActionRegistrationValidationError {
  return new ActionRegistrationValidationError(code, message, path);
}
