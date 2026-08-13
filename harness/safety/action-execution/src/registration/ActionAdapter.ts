import type { InvocationInterruptionContext } from "@agent-anything/agent-core/control";
import type { RunActionRef } from "@agent-anything/agent-core/run-action";
import type { ResolvedOperationBinding } from "@agent-anything/operation-catalog/binding";
import type {
  ActionAdapterDescriptor,
  ActionRegistration,
  ActionRegistrationSnapshot,
} from "@agent-anything/canonical-action/registration";
import type {
  CanonicalActorIdentity,
  CanonicalActionRef,
  CanonicalActionSubjectRevision,
  CanonicalEnvironmentIdentity,
  CanonicalWorkspaceIdentity,
  ActionEffectSetInput,
  SafeActionSummary,
  SafeActionSummaryInput,
  PreparedActionInvocation,
  PreparedActionInvocationInput,
  TargetStateAssertion,
  TargetStateAssertionInput,
} from "@agent-anything/canonical-action/subject";
import {
  canonicalEndpointKey,
  canonicalPathTargetKey,
  canonicalRemoteToolTargetKey,
  createActionEffectSet,
  createCanonicalSha256Digest,
  createPreparedActionInvocation,
  createSafeActionSummary,
  createTargetStateAssertions,
  targetStateAssertionKey,
} from "@agent-anything/canonical-action/subject";
import type {
  ApprovalRequirementDraft,
  CanonicalAdditionalPermissions,
} from "@agent-anything/permission/approval";
import type { CanonicalActionSettlement } from "@agent-anything/canonical-action/settlement";

export interface ActionPreparationContext {
  readonly action: CanonicalActionRef;
  readonly parentRunAction: RunActionRef | null;
  readonly subjectRevision: number;
  readonly registration: ActionRegistration;
  readonly workspace: CanonicalWorkspaceIdentity | null;
  readonly actor: CanonicalActorIdentity;
  readonly environment: CanonicalEnvironmentIdentity;
  readonly interruption: InvocationInterruptionContext;
  readonly now: () => string;
}

export interface PreparedAction<TSemanticBasis = unknown> {
  readonly subject: CanonicalActionSubjectRevision;
  readonly invocation: PreparedActionInvocation;
  readonly assertions: readonly TargetStateAssertion[];
  readonly approval: ApprovalRequirementDraft | null;
  readonly safeSummary: SafeActionSummary;
  readonly semanticBasis: TSemanticBasis;
}

export interface ActionAdapterPreparedData<TSemanticBasis = unknown> {
  readonly effectSet: ActionEffectSetInput;
  readonly requestedAuthority: CanonicalAdditionalPermissions | null;
  readonly targetAssertions: readonly TargetStateAssertionInput[];
  readonly approval: ApprovalRequirementDraft | null;
  readonly safeSummary: SafeActionSummaryInput;
  readonly preparedInvocation: PreparedActionInvocationInput;
  readonly replayBasis?: CanonicalActionSubjectRevision["replayBasis"];
  readonly deadlineAt?: string | null;
  readonly provenance?: string;
  readonly semanticBasis: TSemanticBasis;
}

/** Builds one complete canonical subject from trusted Operation-owned semantics. */
export async function createPreparedAction<TRequest, TSemanticBasis>(
  binding: ResolvedOperationBinding<TRequest> & { readonly kind: "direct" | "hosted" },
  context: ActionPreparationContext,
  data: ActionAdapterPreparedData<TSemanticBasis>,
): Promise<PreparedAction<TSemanticBasis>> {
  const effectSet = createActionEffectSet(data.effectSet);
  if (effectSet.kind !== "effects") {
    throw new TypeError("An external Action requires at least one canonical effect.");
  }
  const invocation = createPreparedActionInvocation(data.preparedInvocation);
  const assertions = createTargetStateAssertions([
    ...data.targetAssertions,
    {
      kind: "adapter_registration",
      expected: context.registration.adapter,
      registrationFingerprint: context.registration.registrationFingerprint,
    },
    {
      kind: "executor_registration",
      expected: context.registration.executor,
      registrationFingerprint: context.registration.registrationFingerprint,
    },
    { kind: "environment_identity", expected: context.environment },
  ]);
  const safeSummary = createSafeActionSummary(data.safeSummary);
  const preparedInvocationDigest = await createCanonicalSha256Digest(
    "agent-anything.prepared-action-invocation.v1",
    invocation,
  );
  const requestedAuthorityDigest = await createCanonicalSha256Digest(
    "agent-anything.requested-action-authority.v1",
    data.requestedAuthority,
  );
  const safeReviewProjectionDigest = await createCanonicalSha256Digest(
    "agent-anything.safe-action-review.v1",
    safeSummary,
  );
  const targets = canonicalTargets(effectSet.values);
  const subject: CanonicalActionSubjectRevision = deepFreeze({
    ref: { action: context.action, revision: context.subjectRevision },
    previousRevision: null,
    parentRunAction: context.parentRunAction,
    operation: binding.invocation.operation,
    operationInvocation: binding.invocation,
    binding: binding.binding,
    correlation: binding.correlation,
    workspace: context.workspace,
    actor: context.actor,
    environment: context.environment,
    targets,
    effects: effectSet.values,
    currentStateAssertions: assertions.map(targetStateAssertionKey),
    preparedInvocationDigest,
    executorRegistrationFingerprint: context.registration.registrationFingerprint,
    sandboxRequirementRevision: context.registration.sandboxRequirementRevision,
    requestedAuthorityDigest,
    safeReviewProjectionDigest,
    replayBasis: data.replayBasis ?? "none",
    deadlineAt: data.deadlineAt ?? null,
    createdAt: context.now(),
    provenance: data.provenance ?? `operation-adapter:${context.registration.adapter.id}`,
  });
  return deepFreeze({
    subject,
    invocation,
    assertions,
    approval: data.approval,
    safeSummary,
    semanticBasis: data.semanticBasis,
  });
}

export type ActionPreparationResult<TSemanticBasis = unknown> =
  | {
      readonly status: "prepared";
      readonly prepared: PreparedAction<TSemanticBasis>;
    }
  | {
      readonly status: "invalid" | "unavailable" | "failed" | "interrupted";
      readonly owner: string;
      readonly code: string;
      readonly message: string;
    };

export type ActionRevalidationResult =
  | { readonly status: "valid"; readonly recordId: string }
  | {
      readonly status: "invalidated" | "failed" | "interrupted";
      readonly owner: string;
      readonly code: string;
      readonly recordId: string;
    };

export interface ActionSemanticResult<TOutput = unknown> {
  readonly operationInvocationId: string;
  readonly settlement: CanonicalActionSettlement;
  readonly status:
    | "succeeded"
    | "partial"
    | "failed"
    | "denied"
    | "cancelled"
    | "timed_out"
    | "invalid"
    | "unknown_effect";
  readonly output: TOutput | null;
  readonly failure: {
    readonly owner: string;
    readonly code: string;
    readonly message: string;
  } | null;
}

/** Trusted semantic-Operation-owned bridge into canonical Action execution. */
export interface OperationActionAdapter<
  TRequest = unknown,
  TSemanticBasis = unknown,
  TOutput = unknown,
> {
  readonly descriptor: ActionAdapterDescriptor;
  prepare(
    binding: ResolvedOperationBinding<TRequest> & {
      readonly kind: "direct" | "hosted";
    },
    context: ActionPreparationContext,
  ): Promise<ActionPreparationResult<TSemanticBasis>>;
  revalidate(
    prepared: PreparedAction<TSemanticBasis>,
    assertions: readonly TargetStateAssertion[],
    context: ActionPreparationContext,
  ): Promise<ActionRevalidationResult>;
  settle(
    prepared: PreparedAction<TSemanticBasis>,
    settlement: CanonicalActionSettlement,
  ): Promise<ActionSemanticResult<TOutput>>;
}

export interface ActionAdapterImplementation {
  readonly adapter: OperationActionAdapter;
}

export interface CapturedActionAdapter {
  readonly registration: ActionRegistration;
  readonly adapter: OperationActionAdapter;
}

export interface ActionAdapterImplementationSnapshot {
  readonly schemaVersion: 2;
  readonly adapterIds: readonly string[];
  find(adapterId: string): CapturedActionAdapter | undefined;
}

export function createActionAdapterImplementationSnapshot(
  registrations: ActionRegistrationSnapshot,
  implementations: readonly ActionAdapterImplementation[],
): ActionAdapterImplementationSnapshot {
  if (!Array.isArray(implementations)) {
    throw new TypeError("Action adapter implementations must be an array.");
  }
  const captured = new Map<string, CapturedActionAdapter>();
  for (const implementation of implementations) {
    if (
      implementation === null ||
      typeof implementation !== "object" ||
      implementation.adapter === null ||
      typeof implementation.adapter !== "object"
    ) {
      throw new TypeError("Action adapter implementation is invalid.");
    }
    const descriptor = implementation.adapter.descriptor;
    const registration = registrations.registrations.find(
      (candidate) => candidate.adapter.id === descriptor.id,
    );
    if (registration === undefined) {
      throw new TypeError(`Unregistered Action adapter implementation: ${descriptor.id}.`);
    }
    if (!sameDescriptor(registration.adapter, descriptor)) {
      throw new TypeError(
        `Action adapter descriptor does not match registration: ${descriptor.id}.`,
      );
    }
    if (captured.has(descriptor.id)) {
      throw new TypeError(`Duplicate Action adapter implementation: ${descriptor.id}.`);
    }
    captured.set(descriptor.id, Object.freeze({
      registration,
      adapter: Object.freeze({
        descriptor,
        prepare: implementation.adapter.prepare.bind(implementation.adapter),
        revalidate: implementation.adapter.revalidate.bind(implementation.adapter),
        settle: implementation.adapter.settle.bind(implementation.adapter),
      }),
    }));
  }
  for (const registration of registrations.registrations) {
    if (!captured.has(registration.adapter.id)) {
      throw new TypeError(
        `Missing Action adapter implementation: ${registration.adapter.id}.`,
      );
    }
  }
  return Object.freeze({
    schemaVersion: 2 as const,
    adapterIds: Object.freeze([...captured.keys()].sort()),
    find(adapterId: string) {
      return captured.get(adapterId);
    },
  });
}

function sameDescriptor(
  left: ActionAdapterDescriptor,
  right: ActionAdapterDescriptor,
): boolean {
  return left.id === right.id &&
    left.version === right.version &&
    left.requestSchemaRevision === right.requestSchemaRevision;
}

function canonicalTargets(
  effects: readonly import("@agent-anything/canonical-action/subject").CapabilityEffect[],
): readonly import("@agent-anything/canonical-action/subject").CanonicalTarget[] {
  const values: import("@agent-anything/canonical-action/subject").CanonicalTarget[] = [];
  for (const effect of effects) {
    switch (effect.kind) {
      case "file_system":
        values.push(...effect.targets.map((target) => ({
          kind: "filesystem" as const,
          identityKey: canonicalPathTargetKey(target.path),
        })));
        break;
      case "process":
        values.push({
          kind: "process",
          identityKey: canonicalPathTargetKey(effect.executable.path),
        });
        break;
      case "network":
        values.push(...effect.endpoints.map((endpoint) => ({
          kind: "network" as const,
          identityKey: canonicalEndpointKey(endpoint),
        })));
        break;
      case "remote_tool":
        values.push({
          kind: "remote_invocation",
          identityKey: canonicalRemoteToolTargetKey(effect.target),
        });
        break;
    }
  }
  values.sort((left, right) => `${left.kind}:${left.identityKey}`.localeCompare(
    `${right.kind}:${right.identityKey}`,
  ));
  return Object.freeze(values);
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
