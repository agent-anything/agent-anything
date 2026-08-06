import type { Action, ActionRejectedCode } from "@agent-anything/agent-core/action";
import type { InvocationInterruptionContext } from "@agent-anything/agent-core/run";

import {
  type ActionAdapterImplementationSnapshot,
  type ActionPreparationContext,
} from "../registration/ActionAdapter.js";
import {
  findActionRegistration,
  type ActionRegistration,
  type ActionRegistrationSnapshot,
} from "../registration/ActionRegistration.js";
import {
  findToolActionBinding,
  type ToolActionBindingSnapshot,
} from "../registration/ToolActionBinding.js";
import {
  createCanonicalActorIdentity,
  createCanonicalEnvironmentIdentity,
  createCanonicalWorkspaceIdentity,
  type CanonicalActorIdentity,
  type CanonicalEnvironmentIdentityInput,
  type CanonicalWorkspaceIdentityInput,
} from "../canonical/CanonicalIdentity.js";
import {
  createPreparedActionReference,
  type PreparedActionReference,
} from "./PreparedExternalAction.js";

export type ActionPreparationResolution =
  | {
      readonly status: "ready";
      readonly action: PreparedActionReference;
      readonly registration: ActionRegistration;
      readonly adapter: NonNullable<
        ReturnType<ActionAdapterImplementationSnapshot["find"]>
      >;
    }
  | {
      readonly status: "rejected";
      readonly code: ActionRejectedCode;
      readonly message: string;
    }
  | {
      readonly status: "failed";
      readonly code: string;
      readonly message: string;
      readonly retryable: false;
    };

export function resolveActionPreparation(
  action: Action,
  registrations: ActionRegistrationSnapshot,
  toolBindings: ToolActionBindingSnapshot,
  adapters: ActionAdapterImplementationSnapshot,
): ActionPreparationResolution {
  const binding = findToolActionBinding(
    toolBindings,
    action.name,
    action.provenance.origin,
  );
  if (binding === undefined) {
    return Object.freeze({
      status: "rejected" as const,
      code: "tool_not_found" as const,
      message: `Tool '${action.name}' is not selected for '${action.provenance.origin}' origin.`,
    });
  }

  let preparedAction: PreparedActionReference;
  try {
    preparedAction = createPreparedActionReference(
      action,
      toolBindings.snapshotId,
      binding,
    );
  } catch (error) {
    return Object.freeze({
      status: "rejected" as const,
      code: hasDataProperty(action, "kind") && action.kind !== "tool"
        ? "action_unsupported" as const
        : "action_invalid" as const,
      message: safeValidationMessage(error, "The Action is invalid."),
    });
  }

  const registration = findActionRegistration(
    registrations,
    preparedAction.boundActionName,
  );
  if (
    registration === undefined ||
    registration.registrationFingerprint !==
      binding.actionRegistrationFingerprint
  ) {
    return Object.freeze({
      status: "failed" as const,
      code: "tool_action_binding_invalid",
      message:
        "The selected Tool Action binding does not match the Action registration snapshot.",
      retryable: false as const,
    });
  }

  const adapter = adapters.find(preparedAction.boundActionName);
  if (adapter === undefined) {
    return Object.freeze({
      status: "failed" as const,
      code: "tool_action_adapter_unavailable",
      message: "The registered Action adapter is unavailable.",
      retryable: false as const,
    });
  }

  return Object.freeze({
    status: "ready" as const,
    action: preparedAction,
    registration,
    adapter,
  });
}

export function createActionPreparationContext(input: {
  readonly workspace: CanonicalWorkspaceIdentityInput;
  readonly actor: CanonicalActorIdentity;
  readonly environment: CanonicalEnvironmentIdentityInput;
  readonly interruption: InvocationInterruptionContext;
}): ActionPreparationContext {
  assertInterruptionContext(input.interruption);
  return Object.freeze({
    workspace: createCanonicalWorkspaceIdentity(input.workspace),
    actor: createCanonicalActorIdentity(input.actor),
    environment: createCanonicalEnvironmentIdentity(input.environment),
    interruption: input.interruption,
  });
}

function assertInterruptionContext(input: InvocationInterruptionContext): void {
  if (
    input === null ||
    typeof input !== "object" ||
    typeof input.signal?.aborted !== "boolean" ||
    typeof input.signal?.addEventListener !== "function"
  ) {
    throw new TypeError("Action preparation requires an interruption context.");
  }
}

function safeValidationMessage(error: unknown, fallback: string): string {
  if (
    error instanceof Error &&
    error.message.length > 0 &&
    error.message.length <= 8_192
  ) {
    return error.message;
  }
  return fallback;
}

function hasDataProperty(
  input: unknown,
  key: PropertyKey,
): input is Record<PropertyKey, unknown> {
  if (input === null || typeof input !== "object") return false;
  const descriptor = Object.getOwnPropertyDescriptor(input, key);
  return descriptor !== undefined &&
    descriptor.get === undefined &&
    descriptor.set === undefined;
}
