import type { InvocationInterruptionContext } from "@agent-anything/agent-core/run";

import type {
  ActionAdapterImplementationSnapshot,
  ActionAdapterRevalidationResult,
} from "../registration/ActionAdapter.js";
import type {
  ActionRegistration,
  ActionRegistrationSnapshot,
} from "../registration/ActionRegistration.js";
import { findActionRegistration } from "../registration/ActionRegistration.js";
import { assertPreparedInvocationMatchesExecutor } from "../canonical/PreparedActionInvocation.js";
import type { PreparedExternalAction } from "../preparation/PreparedExternalAction.js";

export interface FinalActionRevalidationTarget {
  readonly registration: ActionRegistration;
  readonly adapter: NonNullable<
    ReturnType<ActionAdapterImplementationSnapshot["find"]>
  >;
}

export type FinalActionRevalidationTargetResult =
  | {
      readonly status: "ready";
      readonly target: FinalActionRevalidationTarget;
    }
  | {
      readonly status: "invalidated";
      readonly code: string;
      readonly message: string;
    };

export function resolveFinalActionRevalidationTarget(input: {
  readonly prepared: PreparedExternalAction;
  readonly registrations: ActionRegistrationSnapshot;
  readonly adapters: ActionAdapterImplementationSnapshot;
}): FinalActionRevalidationTargetResult {
  const registration = findActionRegistration(
    input.registrations,
    input.prepared.action.boundActionName,
  );
  if (
    registration === undefined ||
    !registrationMatchesPrepared(registration, input.prepared)
  ) {
    return invalidated(
      "action_registration_changed",
      "The Action registration no longer matches the prepared subject.",
    );
  }

  try {
    assertPreparedInvocationMatchesExecutor(
      input.prepared.preparedInvocation,
      registration.executor,
    );
  } catch {
    return invalidated(
      "action_executor_invocation_changed",
      "The prepared invocation no longer matches the registered executor.",
    );
  }

  const adapter = input.adapters.find(
    input.prepared.action.boundActionName,
  );
  if (
    adapter === undefined ||
    !sameAdapterDescriptor(adapter.descriptor, registration.adapter)
  ) {
    return invalidated(
      "action_adapter_registration_changed",
      "The Action adapter registration no longer matches the prepared subject.",
    );
  }

  return Object.freeze({
    status: "ready" as const,
    target: Object.freeze({ registration, adapter }),
  });
}

export function revalidatePreparedActionTarget(
  target: FinalActionRevalidationTarget,
  prepared: PreparedExternalAction,
  interruption: InvocationInterruptionContext,
): Promise<ActionAdapterRevalidationResult> {
  return target.adapter.revalidate(
    prepared.preparedInvocation,
    prepared.subject.targetAssertions,
    Object.freeze({
      workspace: prepared.subject.workspace,
      actor: prepared.subject.identity,
      environment: prepared.subject.environment,
      interruption,
    }),
  );
}

function registrationMatchesPrepared(
  registration: ActionRegistration,
  prepared: PreparedExternalAction,
): boolean {
  const subject = prepared.subject;
  return registration.actionName === prepared.action.boundActionName &&
    registration.registrationFingerprint ===
      prepared.action.actionRegistrationFingerprint &&
    prepared.subject.toolBinding.snapshotId ===
      prepared.action.toolBindingSnapshotId &&
    prepared.subject.toolBinding.toolName === prepared.action.name &&
    prepared.subject.toolBinding.boundActionName ===
      prepared.action.boundActionName &&
    prepared.subject.toolBinding.toolRegistrationFingerprint ===
      prepared.action.toolRegistrationFingerprint &&
    prepared.subject.toolBinding.actionRegistrationFingerprint ===
      prepared.action.actionRegistrationFingerprint &&
    registration.registrationFingerprint ===
      subject.adapter.registrationFingerprint &&
    registration.registrationFingerprint ===
      subject.executor.registrationFingerprint &&
    sameAdapterDescriptor(registration.adapter, subject.adapter) &&
    registration.executor.id === subject.executor.id &&
    registration.executor.version === subject.executor.version &&
    registration.executor.invocationContractVersion ===
      subject.executor.invocationContractVersion;
}

function sameAdapterDescriptor(
  left: { readonly id: string; readonly version: string; readonly inputSchemaVersion: string },
  right: { readonly id: string; readonly version: string; readonly inputSchemaVersion: string },
): boolean {
  return left.id === right.id &&
    left.version === right.version &&
    left.inputSchemaVersion === right.inputSchemaVersion;
}

function invalidated(
  code: string,
  message: string,
): FinalActionRevalidationTargetResult {
  return Object.freeze({ status: "invalidated" as const, code, message });
}
