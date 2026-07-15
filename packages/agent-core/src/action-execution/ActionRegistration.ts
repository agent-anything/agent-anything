export interface ActionAdapterDescriptor {
  readonly id: string;
  readonly version: string;
  readonly inputSchemaVersion: string;
}

export interface ActionExecutorDescriptor {
  readonly id: string;
  readonly version: string;
  readonly invocationContractVersion: string;
}

export interface ActionRegistration {
  readonly actionName: string;
  readonly adapter: ActionAdapterDescriptor;
  readonly executor: ActionExecutorDescriptor;
  readonly registrationFingerprint: string;
}

export interface ActionRegistrationInput {
  readonly actionName: string;
  readonly adapter: ActionAdapterDescriptor;
  readonly executor: ActionExecutorDescriptor;
}

export interface ActionRegistrationSnapshot {
  readonly schemaVersion: 1;
  readonly registrations: readonly ActionRegistration[];
}

export type ActionRegistrationValidationCode =
  | "action_registration_invalid"
  | "action_name_invalid"
  | "action_name_duplicate"
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

const REGISTRATION_FINGERPRINT_DOMAIN = "agent-anything.action-registration.v1";

export function createActionRegistrationSnapshot(
  inputs: readonly ActionRegistrationInput[],
): ActionRegistrationSnapshot {
  assertCanonicalRegistrationArray(inputs);

  const names = new Set<string>();
  const registrations = inputs.map((input, index) => {
    const path = `registrations[${index}]`;
    assertRegistrationInput(input, path);
    const actionName = validateCanonicalToken(
      input.actionName,
      `${path}.actionName`,
      "action_name_invalid",
      "Action name",
    );
    if (names.has(actionName)) {
      throw registrationError(
        "action_name_duplicate",
        `Action name is already registered: ${actionName}`,
        `${path}.actionName`,
      );
    }
    names.add(actionName);

    const adapter = snapshotAdapterDescriptor(input.adapter, `${path}.adapter`);
    const executor = snapshotExecutorDescriptor(input.executor, `${path}.executor`);
    return Object.freeze({
      actionName,
      adapter,
      executor,
      registrationFingerprint: createRegistrationFingerprint({
        actionName,
        adapter,
        executor,
      }),
    });
  });

  return Object.freeze({
    schemaVersion: 1 as const,
    registrations: Object.freeze(registrations),
  });
}

export function findActionRegistration(
  snapshot: ActionRegistrationSnapshot,
  actionName: string,
): ActionRegistration | undefined {
  return snapshot.registrations.find(
    (registration) => registration.actionName === actionName,
  );
}

function createRegistrationFingerprint(
  input: ActionRegistrationInput,
): string {
  const fields = [
    input.actionName,
    input.adapter.id,
    input.adapter.version,
    input.adapter.inputSchemaVersion,
    input.executor.id,
    input.executor.version,
    input.executor.invocationContractVersion,
  ];
  return `${REGISTRATION_FINGERPRINT_DOMAIN}:${fields.map(encodeToken).join(":")}`;
}

function assertCanonicalRegistrationArray(
  inputs: readonly ActionRegistrationInput[],
): void {
  if (!Array.isArray(inputs)) {
    throw registrationError(
      "action_registration_invalid",
      "Action registrations must be an array.",
      "registrations",
    );
  }
  for (const key of Reflect.ownKeys(inputs)) {
    if (typeof key !== "string") {
      throw registrationError(
        "action_registration_invalid",
        "Action registrations have a symbol property.",
        "registrations",
      );
    }
    if (key === "length") continue;
    if (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= inputs.length) {
      throw registrationError(
        "action_registration_invalid",
        `Action registrations have an unsupported property at registrations.${key}.`,
        `registrations.${key}`,
      );
    }
    const descriptor = Object.getOwnPropertyDescriptor(inputs, key);
    if (
      descriptor === undefined ||
      descriptor.get !== undefined ||
      descriptor.set !== undefined ||
      !descriptor.enumerable
    ) {
      throw registrationError(
        "action_registration_invalid",
        `Action registrations must use enumerable data properties at registrations[${key}].`,
        `registrations[${key}]`,
      );
    }
  }
  for (let index = 0; index < inputs.length; index += 1) {
    if (!Object.hasOwn(inputs, index)) {
      throw registrationError(
        "action_registration_invalid",
        `Action registrations are sparse at registrations[${index}].`,
        `registrations[${index}]`,
      );
    }
  }
}

function assertRegistrationInput(
  input: unknown,
  path: string,
): asserts input is ActionRegistrationInput {
  if (
    input === null ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.getPrototypeOf(input) !== Object.prototype
  ) {
    throw registrationError(
      "action_registration_invalid",
      `Action registration must be a plain object at ${path}.`,
      path,
    );
  }
  const allowedKeys = new Set(["actionName", "adapter", "executor"]);
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== "string" || !allowedKeys.has(key)) {
      throw registrationError(
        "action_registration_invalid",
        `Unsupported Action registration field at ${path}.${String(key)}.`,
        `${path}.${String(key)}`,
      );
    }
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (
      descriptor === undefined ||
      descriptor.get !== undefined ||
      descriptor.set !== undefined ||
      !descriptor.enumerable
    ) {
      throw registrationError(
        "action_registration_invalid",
        `Action registration must use enumerable data properties at ${path}.${key}.`,
        `${path}.${key}`,
      );
    }
  }
}

function snapshotAdapterDescriptor(
  input: ActionAdapterDescriptor,
  path: string,
): ActionAdapterDescriptor {
  assertPlainDescriptor(
    input,
    path,
    "adapter_descriptor_invalid",
    new Set(["id", "version", "inputSchemaVersion"]),
  );
  return Object.freeze({
    id: validateCanonicalToken(
      input.id,
      `${path}.id`,
      "adapter_descriptor_invalid",
      "Adapter id",
    ),
    version: validateCanonicalToken(
      input.version,
      `${path}.version`,
      "adapter_descriptor_invalid",
      "Adapter version",
    ),
    inputSchemaVersion: validateCanonicalToken(
      input.inputSchemaVersion,
      `${path}.inputSchemaVersion`,
      "adapter_descriptor_invalid",
      "Adapter input schema version",
    ),
  });
}

function snapshotExecutorDescriptor(
  input: ActionExecutorDescriptor,
  path: string,
): ActionExecutorDescriptor {
  assertPlainDescriptor(
    input,
    path,
    "executor_descriptor_invalid",
    new Set(["id", "version", "invocationContractVersion"]),
  );
  return Object.freeze({
    id: validateCanonicalToken(
      input.id,
      `${path}.id`,
      "executor_descriptor_invalid",
      "Executor id",
    ),
    version: validateCanonicalToken(
      input.version,
      `${path}.version`,
      "executor_descriptor_invalid",
      "Executor version",
    ),
    invocationContractVersion: validateCanonicalToken(
      input.invocationContractVersion,
      `${path}.invocationContractVersion`,
      "executor_descriptor_invalid",
      "Executor invocation contract version",
    ),
  });
}

function assertPlainDescriptor(
  input: unknown,
  path: string,
  code: Extract<
    ActionRegistrationValidationCode,
    "adapter_descriptor_invalid" | "executor_descriptor_invalid"
  >,
  allowedKeys: ReadonlySet<string>,
): asserts input is Record<string, unknown> {
  if (
    input === null ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.getPrototypeOf(input) !== Object.prototype
  ) {
    throw registrationError(code, `Descriptor must be a plain object at ${path}.`, path);
  }
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== "string" || !allowedKeys.has(key)) {
      throw registrationError(
        code,
        `Unsupported descriptor field at ${path}.${String(key)}.`,
        `${path}.${String(key)}`,
      );
    }
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (
      descriptor === undefined ||
      descriptor.get !== undefined ||
      descriptor.set !== undefined ||
      !descriptor.enumerable
    ) {
      throw registrationError(
        code,
        `Descriptor must use enumerable data properties at ${path}.${key}.`,
        `${path}.${key}`,
      );
    }
  }
}

function validateCanonicalToken(
  input: unknown,
  path: string,
  code: ActionRegistrationValidationCode,
  label: string,
): string {
  if (
    typeof input !== "string" ||
    input.length === 0 ||
    input.length > 256 ||
    input !== input.trim() ||
    !/^[A-Za-z0-9][A-Za-z0-9._:/+-]*$/.test(input)
  ) {
    throw registrationError(
      code,
      `${label} must be a canonical non-empty token.`,
      path,
    );
  }
  return input;
}

function encodeToken(value: string): string {
  return `${value.length}.${value}`;
}

function registrationError(
  code: ActionRegistrationValidationCode,
  message: string,
  path: string,
): ActionRegistrationValidationError {
  return new ActionRegistrationValidationError(code, message, path);
}
