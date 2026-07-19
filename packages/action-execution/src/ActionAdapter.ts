import type {
  ApprovalApplicabilityKey,
  ApprovalCategory,
  ApprovalPayloadByCategory,
  CanonicalAdditionalPermissions,
} from "@agent-anything/permission";
import type {
  InvocationInterruptionContext,
  InvocationInterruptionRef,
} from "@agent-anything/shared";
import type { CanonicalActionOperationInput } from "./CanonicalActionOperation.js";
import type {
  CanonicalActorIdentity,
  CanonicalEnvironmentIdentity,
  CanonicalWorkspaceIdentity,
} from "./CanonicalIdentity.js";
import type {
  ActionEffectSetInput,
  CapabilityEffect,
} from "./CapabilityEffect.js";
import type {
  PreparedActionInvocation,
  PreparedActionInvocationInput,
} from "./PreparedActionInvocation.js";
import type { SafeActionSummaryInput } from "./SafeActionSummary.js";
import type {
  TargetStateAssertion,
  TargetStateAssertionInput,
} from "./TargetStateAssertion.js";
import type {
  ActionAdapterDescriptor,
  ActionRegistrationSnapshot,
} from "./ActionRegistration.js";

export interface ActionAdapterPreparationInput {
  readonly actionName: string;
  readonly input: unknown;
}

export interface ActionPreparationContext {
  readonly workspace: CanonicalWorkspaceIdentity;
  readonly actor: CanonicalActorIdentity;
  readonly environment: CanonicalEnvironmentIdentity;
  readonly interruption: InvocationInterruptionContext;
}

export interface ActionAdapterPreparedData {
  readonly operation: CanonicalActionOperationInput;
  readonly effectSet: ActionEffectSetInput;
  readonly requestedPermissions: CanonicalAdditionalPermissions | null;
  readonly targetAssertions: readonly TargetStateAssertionInput[];
  readonly approvalCategory: ApprovalCategory | null;
  readonly approvalPayload: ApprovalPayloadByCategory[ApprovalCategory] | null;
  readonly applicabilityKeys: readonly ApprovalApplicabilityKey[];
  readonly safeSummary: SafeActionSummaryInput;
  readonly preparedInvocation: PreparedActionInvocationInput;
}

export type ActionAdapterPreparationResult =
  | { readonly status: "prepared"; readonly data: ActionAdapterPreparedData }
  | {
      readonly status: "rejected";
      readonly code: "action_invalid" | "action_unsupported";
      readonly message: string;
    }
  | {
      readonly status: "failed";
      readonly code: string;
      readonly message: string;
      readonly retryable: boolean;
    }
  | {
      readonly status: "interrupted";
      readonly interruption: InvocationInterruptionRef;
    };

export interface ActionRevalidationContext extends ActionPreparationContext {}

export type ActionAdapterRevalidationResult =
  | { readonly status: "valid" }
  | { readonly status: "invalidated"; readonly code: string; readonly message: string }
  | {
      readonly status: "failed";
      readonly code: string;
      readonly message: string;
      readonly retryable: boolean;
    }
  | { readonly status: "interrupted"; readonly interruption: InvocationInterruptionRef };

export type ActionAdapterSandboxReconciliationResult =
  | {
      readonly status: "supported";
      readonly targetAssertions: readonly TargetStateAssertionInput[];
    }
  | { readonly status: "unsupported"; readonly code: string; readonly message: string }
  | { readonly status: "invalidated"; readonly code: string; readonly message: string }
  | {
      readonly status: "failed";
      readonly code: string;
      readonly message: string;
      readonly retryable: boolean;
    }
  | { readonly status: "interrupted"; readonly interruption: InvocationInterruptionRef };

export interface ActionAdapter {
  readonly descriptor: ActionAdapterDescriptor;
  prepare(
    input: ActionAdapterPreparationInput,
    context: ActionPreparationContext,
  ): Promise<ActionAdapterPreparationResult>;
  revalidate(
    preparedInvocation: PreparedActionInvocation,
    assertions: readonly TargetStateAssertion[],
    context: ActionRevalidationContext,
  ): Promise<ActionAdapterRevalidationResult>;
  reconcileSandboxDenial?(
    preparedInvocation: PreparedActionInvocation,
    deniedEffect: CapabilityEffect,
    assertions: readonly TargetStateAssertion[],
    context: ActionRevalidationContext,
  ): Promise<ActionAdapterSandboxReconciliationResult>;
}

export interface ActionAdapterImplementation {
  readonly actionName: string;
  readonly adapter: ActionAdapter;
}

interface CapturedActionAdapter {
  readonly descriptor: ActionAdapterDescriptor;
  readonly prepare: ActionAdapter["prepare"];
  readonly revalidate: ActionAdapter["revalidate"];
  readonly reconcileSandboxDenial: ActionAdapter["reconcileSandboxDenial"];
}

export interface ActionAdapterImplementationSnapshot {
  readonly schemaVersion: 1;
  readonly actionNames: readonly string[];
  find(actionName: string): CapturedActionAdapter | undefined;
}

export function createActionAdapterImplementationSnapshot(
  registrations: ActionRegistrationSnapshot,
  implementations: readonly ActionAdapterImplementation[],
): ActionAdapterImplementationSnapshot {
  assertImplementationArray(implementations);
  const registrationNames = new Set(registrations.registrations.map(({ actionName }) => actionName));
  const captured = new Map<string, CapturedActionAdapter>();

  for (let index = 0; index < implementations.length; index += 1) {
    const implementation = implementations[index]!;
    const path = `adapterImplementations[${index}]`;
    assertImplementation(implementation, path);
    const registration = registrations.registrations.find(
      ({ actionName }) => actionName === implementation.actionName,
    );
    if (registration === undefined) {
      throw new TypeError(`Unregistered Action adapter implementation: ${implementation.actionName}.`);
    }
    if (captured.has(implementation.actionName)) {
      throw new TypeError(`Duplicate Action adapter implementation: ${implementation.actionName}.`);
    }
    if (!sameDescriptor(registration.adapter, implementation.adapter.descriptor)) {
      throw new TypeError(
        `Action adapter descriptor does not match registration: ${implementation.actionName}.`,
      );
    }
    captured.set(implementation.actionName, Object.freeze({
      descriptor: registration.adapter,
      prepare: implementation.adapter.prepare.bind(implementation.adapter),
      revalidate: implementation.adapter.revalidate.bind(implementation.adapter),
      reconcileSandboxDenial: implementation.adapter.reconcileSandboxDenial?.bind(
        implementation.adapter,
      ),
    }));
  }

  for (const actionName of registrationNames) {
    if (!captured.has(actionName)) {
      throw new TypeError(`Missing Action adapter implementation: ${actionName}.`);
    }
  }

  const actionNames = Object.freeze([...captured.keys()].sort(compareStrings));
  return Object.freeze({
    schemaVersion: 1 as const,
    actionNames,
    find(actionName: string) {
      return captured.get(actionName);
    },
  });
}

function assertImplementationArray(input: readonly ActionAdapterImplementation[]): void {
  if (!Array.isArray(input)) throw new TypeError("Action adapter implementations must be an array.");
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== "string" || (key !== "length" && !/^(0|[1-9][0-9]*)$/.test(key))) {
      throw new TypeError("Action adapter implementations contain an unsupported property.");
    }
    if (key !== "length") assertDataProperty(input, key, `adapterImplementations[${key}]`);
  }
  for (let index = 0; index < input.length; index += 1) {
    if (!Object.hasOwn(input, index)) {
      throw new TypeError(`Action adapter implementations are sparse at index ${index}.`);
    }
  }
}

function assertImplementation(
  input: ActionAdapterImplementation,
  path: string,
): void {
  if (
    input === null ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.getPrototypeOf(input) !== Object.prototype
  ) {
    throw new TypeError(`Action adapter implementation must be a plain object at ${path}.`);
  }
  const keys = Reflect.ownKeys(input);
  if (keys.length !== 2 || !keys.includes("actionName") || !keys.includes("adapter")) {
    throw new TypeError(`Action adapter implementation has unsupported fields at ${path}.`);
  }
  assertDataProperty(input, "actionName", `${path}.actionName`);
  assertDataProperty(input, "adapter", `${path}.adapter`);
  if (
    typeof input.actionName !== "string" ||
    typeof input.adapter?.prepare !== "function" ||
    typeof input.adapter?.revalidate !== "function"
  ) {
    throw new TypeError(`Action adapter implementation is incomplete at ${path}.`);
  }
}

function assertDataProperty(input: object, key: PropertyKey, path: string): void {
  const descriptor = Object.getOwnPropertyDescriptor(input, key);
  if (
    descriptor === undefined ||
    descriptor.get !== undefined ||
    descriptor.set !== undefined ||
    !descriptor.enumerable
  ) {
    throw new TypeError(`Action adapter implementations require data properties at ${path}.`);
  }
}

function sameDescriptor(left: ActionAdapterDescriptor, right: ActionAdapterDescriptor): boolean {
  return left.id === right.id &&
    left.version === right.version &&
    left.inputSchemaVersion === right.inputSchemaVersion;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
