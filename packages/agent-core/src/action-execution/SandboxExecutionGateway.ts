import type {
  InvocationInterruptionContext,
  InvocationInterruptionRef,
  ISODateTimeString,
} from "@agent-anything/shared";
import type { ToolResult } from "@agent-anything/tools";
import type { RuntimeError } from "../runner/RuntimeError.js";
import {
  createActionExecutorDispatchPermit,
  type ActionExecutor,
  type ActionExecutorContext,
  type ResolvedActionSecret,
} from "./ActionExecutor.js";
import { createPreparedInvocationDigest } from "./ActionFingerprint.js";
import type { ActionRegistrationSnapshot } from "./ActionRegistration.js";
import { assertActionDispatchPlan } from "./ActionRevalidation.js";
import { createCanonicalSha256Digest } from "./CanonicalEncoding.js";
import { snapshotCapabilityEffect } from "./CapabilityEffect.js";
import { assertPreparedInvocationMatchesExecutor } from "./PreparedActionInvocation.js";
import type {
  ActionExecutionLimits,
  ActionExecutionResult,
  CapabilityEffectKind,
  DispatchSandboxActionInput,
  SandboxAttempt,
  SandboxCancellationRequest,
  SandboxDenial,
  SandboxEnforcementEvidence,
  SandboxExecutionGateway,
  SandboxExecutionRequest,
  SandboxPolicyEnvelope,
  PreparedSandboxDispatch,
  SandboxDispatchPreparationResult,
  SandboxProvider,
  SandboxProviderDescriptor,
  SandboxProviderKind,
  SandboxProviderResult,
} from "./SandboxContracts.js";

export interface ResolveActionSecretsInput {
  readonly attempt: SandboxAttempt;
  readonly references: readonly string[];
}

export interface ActionSecretResolver {
  resolve(input: ResolveActionSecretsInput): Promise<readonly ResolvedActionSecret[]>;
}

export interface CreateSandboxExecutionGatewayInput {
  readonly registrations: ActionRegistrationSnapshot;
  readonly executors: readonly ActionExecutor[];
  readonly providers?: readonly SandboxProvider[];
  readonly limits: ActionExecutionLimits;
  readonly secretResolver?: ActionSecretResolver;
  readonly now?: () => ISODateTimeString;
  readonly createAttemptId?: (input: {
    readonly runId: string;
    readonly actionId: string;
    readonly ordinal: 1 | 2;
  }) => string;
}

interface RegisteredExecutor {
  readonly key: string;
  readonly executor: ActionExecutor;
}

interface RegisteredProvider {
  readonly provider: SandboxProvider;
  readonly descriptor: SandboxProviderDescriptor;
}

interface PreparedDispatchState {
  readonly attempt: SandboxAttempt;
  readonly policy: SandboxPolicyEnvelope;
  readonly actionName: string;
  readonly invocation: DispatchSandboxActionInput["preparedInvocation"];
  readonly deadlineAt: ISODateTimeString;
  readonly interruption: InvocationInterruptionContext;
  readonly enforcement: "managed" | "external" | "disabled";
}

const gatewaySandboxDenials = new WeakSet<object>();

export function assertGatewaySandboxDenial(denial: SandboxDenial): void {
  if (
    denial === null ||
    typeof denial !== "object" ||
    !gatewaySandboxDenials.has(denial) ||
    !Object.isFrozen(denial)
  ) {
    throw new TypeError("Sandbox escalation requires a gateway-validated denial.");
  }
}

export function createSandboxExecutionGateway(
  input: CreateSandboxExecutionGatewayInput,
): SandboxExecutionGateway {
  return new DefaultSandboxExecutionGateway(input);
}

class DefaultSandboxExecutionGateway implements SandboxExecutionGateway {
  private readonly executors: ReadonlyMap<string, RegisteredExecutor>;
  private readonly providers: ReadonlyMap<SandboxProviderKind, RegisteredProvider>;
  private readonly limits: ActionExecutionLimits;
  private readonly now: () => ISODateTimeString;
  private readonly createAttemptId: NonNullable<
    CreateSandboxExecutionGatewayInput["createAttemptId"]
  >;
  private readonly preparedDispatches = new WeakMap<object, PreparedDispatchState>();
  private readonly consumedDispatches = new WeakSet<object>();

  constructor(private readonly input: CreateSandboxExecutionGatewayInput) {
    this.limits = snapshotLimits(input.limits);
    this.executors = createExecutorRegistry(input.registrations, input.executors);
    this.providers = createProviderRegistry(input.providers ?? []);
    this.now = input.now ?? (() => new Date().toISOString());
    this.createAttemptId = input.createAttemptId ?? ((identity) =>
      `${identity.runId}:sandbox_attempt:${identity.actionId}:${identity.ordinal}`);
  }

  async prepare(
    input: DispatchSandboxActionInput,
  ): Promise<SandboxDispatchPreparationResult> {
    let validated: Awaited<ReturnType<typeof validateDispatchInput>>;
    try {
      validated = await validateDispatchInput(input);
    } catch (error) {
      return preparationFailed("sandbox_dispatch_invalid", safeMessage(
        error,
        "Sandbox dispatch input is invalid.",
      ));
    }

    const initialInterruption = observeInterruption(input.interruption, input.plan.runId);
    if (initialInterruption.status === "invalid") {
      return preparationFailed(
        "sandbox_interruption_unattributed",
        initialInterruption.message,
      );
    }
    if (initialInterruption.status === "interrupted") {
      return Object.freeze({
        status: "interrupted" as const,
        interruption: initialInterruption.interruption,
      });
    }

    const startedAt = this.now();
    if (!isCanonicalDateTime(startedAt)) {
      return preparationFailed(
        "sandbox_clock_invalid",
        "Sandbox clock returned an invalid timestamp.",
      );
    }
    const policy = await createSandboxPolicy(input.plan, this.limits);
    const attemptId = this.createAttemptId({
      runId: input.plan.runId,
      actionId: input.plan.actionId,
      ordinal: input.plan.attemptOrdinal,
    });
    if (!isCanonicalToken(attemptId)) {
      return preparationFailed(
        "sandbox_attempt_id_invalid",
        "Sandbox attempt id is invalid.",
      );
    }
    const attempt: SandboxAttempt = deepFreeze({
      id: attemptId,
      runId: input.plan.runId,
      actionId: input.plan.actionId,
      actionFingerprint: input.plan.actionFingerprint,
      ordinal: input.plan.attemptOrdinal,
      enforcement: input.plan.enforcement,
      policyId: policy.policyId,
      authoritySnapshotId: input.plan.authoritySnapshotId,
      dispatchPlanFingerprint: input.plan.dispatchPlanFingerprint,
      startedAt,
    });
    if (Date.parse(input.deadlineAt) <= Date.parse(startedAt)) {
      return Object.freeze({
        status: "interrupted" as const,
        interruption: Object.freeze({
          kind: "operation_deadline" as const,
          deadline: Object.freeze({
            operationId: attempt.id,
            deadlineAt: input.deadlineAt,
          }),
        }),
      });
    }

    const prepared = Object.freeze({ attempt });
    this.preparedDispatches.set(prepared, Object.freeze({
      attempt,
      policy,
      actionName: input.plan.actionName,
      invocation: validated.invocation,
      deadlineAt: input.deadlineAt,
      interruption: input.interruption,
      enforcement: input.plan.enforcement,
    }));
    return Object.freeze({ status: "ready" as const, prepared });
  }

  async execute(prepared: PreparedSandboxDispatch): Promise<ActionExecutionResult> {
    if (
      prepared === null ||
      typeof prepared !== "object" ||
      !Object.isFrozen(prepared)
    ) {
      return failed(null, "sandbox_prepared_dispatch_invalid", "Prepared sandbox dispatch is invalid.");
    }
    const state = this.preparedDispatches.get(prepared);
    if (state === undefined) {
      return failed(null, "sandbox_prepared_dispatch_invalid", "Prepared sandbox dispatch is not owned by this gateway.");
    }
    if (this.consumedDispatches.has(prepared)) {
      return failed(state.attempt, "sandbox_prepared_dispatch_consumed", "Prepared sandbox dispatch is single-use.");
    }
    this.consumedDispatches.add(prepared);

    const interruption = observeInterruption(
      state.interruption,
      state.attempt.runId,
    );
    if (interruption.status === "invalid") {
      return failed(
        state.attempt,
        "sandbox_interruption_unattributed",
        interruption.message,
      );
    }
    if (interruption.status === "interrupted") {
      return Object.freeze({
        status: "interrupted" as const,
        attempt: state.attempt,
        interruption: interruption.interruption,
      });
    }

    if (state.enforcement === "disabled") {
      return this.dispatchDisabled(state);
    }
    return this.dispatchProvider({ ...state, kind: state.enforcement });
  }

  private async dispatchDisabled(input: {
    readonly attempt: SandboxAttempt;
    readonly policy: SandboxPolicyEnvelope;
    readonly actionName: string;
    readonly invocation: DispatchSandboxActionInput["preparedInvocation"];
    readonly deadlineAt: ISODateTimeString;
    readonly interruption: InvocationInterruptionContext;
  }): Promise<ActionExecutionResult> {
    const registered = this.executors.get(executorKey(input.invocation));
    if (registered === undefined) {
      return unavailable(
        input.attempt,
        "sandbox_executor_unavailable",
        "setup",
        "none",
      );
    }

    let secrets: readonly ResolvedActionSecret[];
    try {
      secrets = await resolveSecrets(
        this.input.secretResolver,
        input.attempt,
        input.policy.allowedSecretReferences,
      );
    } catch (error) {
      return unavailable(
        input.attempt,
        error instanceof MissingSecretResolverError
          ? "sandbox_secret_resolver_unavailable"
          : "sandbox_secret_resolution_failed",
        "setup",
        "none",
      );
    }

    const local = createLocalInterruption(
      input.interruption,
      input.attempt,
      input.deadlineAt,
      this.now,
    );
    if (local.interruption !== null) {
      local.dispose();
      return Object.freeze({
        status: "interrupted" as const,
        attempt: input.attempt,
        interruption: local.interruption,
      });
    }

    const context: ActionExecutorContext = Object.freeze({
      attempt: input.attempt,
      interruption: Object.freeze({
        signal: local.signal,
        get interruption() {
          return local.interruption;
        },
      }),
      deadlineAt: input.deadlineAt,
      limits: this.limits,
      resolvedSecrets: secrets,
      dispatchPermit: createActionExecutorDispatchPermit(),
    });

    try {
      const result = await registered.executor.execute(input.invocation, context);
      const toolResult = snapshotToolResult(
        result,
        input.attempt,
        input.actionName,
        this.limits.maxResultBytes,
      );
      return Object.freeze({
        status: "executed" as const,
        attempt: input.attempt,
        toolResult,
        isolation: "unisolated" as const,
        enforcementEvidence: null,
      });
    } catch (error) {
      if (local.interruption !== null) {
        return Object.freeze({
          status: "interrupted" as const,
          attempt: input.attempt,
          interruption: local.interruption,
        });
      }
      return failed(
        input.attempt,
        "tool_executor_failed",
        safeMessage(error, "ActionExecutor failed."),
        "tool",
      );
    } finally {
      local.dispose();
    }
  }

  private async dispatchProvider(input: {
    readonly attempt: SandboxAttempt;
    readonly policy: SandboxPolicyEnvelope;
    readonly actionName: string;
    readonly invocation: DispatchSandboxActionInput["preparedInvocation"];
    readonly deadlineAt: ISODateTimeString;
    readonly interruption: InvocationInterruptionContext;
    readonly kind: SandboxProviderKind;
  }): Promise<ActionExecutionResult> {
    const registered = this.providers.get(input.kind);
    if (registered === undefined) {
      return unavailable(input.attempt, "sandbox_provider_unavailable", "setup", "none");
    }
    const requiredKinds = requiredEffectKinds(input.policy);
    if (!registered.descriptor.supportedPolicyVersions.includes(1)) {
      return unavailable(
        input.attempt,
        "sandbox_policy_version_unsupported",
        "capability_check",
        "none",
      );
    }
    if (requiredKinds.some((kind) =>
      !registered.descriptor.supportedEffectKinds.includes(kind))) {
      return unavailable(
        input.attempt,
        "sandbox_effect_kind_unsupported",
        "capability_check",
        "none",
      );
    }

    const request: SandboxExecutionRequest = deepFreeze({
      attempt: input.attempt,
      policy: input.policy,
      executor: {
        id: input.invocation.executorId,
        version: input.invocation.executorVersion,
        invocationContractVersion: input.invocation.contractVersion,
      },
      invocation: input.invocation,
      deadlineAt: input.deadlineAt,
    });
    const cancellation = attachProviderCancellation({
      provider: registered.provider,
      attempt: input.attempt,
      interruption: input.interruption,
      deadlineAt: input.deadlineAt,
      now: this.now,
    });
    try {
      const providerResult = await registered.provider.execute(request);
      return mapProviderResult(
        providerResult,
        input.attempt,
        input.actionName,
        registered.descriptor,
        requiredKinds,
        this.limits.maxResultBytes,
      );
    } catch (error) {
      return unavailable(
        input.attempt,
        "sandbox_provider_dispatch_failed",
        "dispatch",
        "unknown",
      );
    } finally {
      cancellation.dispose();
    }
  }
}

async function validateDispatchInput(input: DispatchSandboxActionInput) {
  if (input === null || typeof input !== "object") {
    throw new TypeError("Sandbox dispatch input must be an object.");
  }
  assertActionDispatchPlan(input.plan);
  if (!isCanonicalDateTime(input.deadlineAt)) {
    throw new TypeError("Sandbox deadlineAt must be a canonical timestamp.");
  }
  assertPreparedInvocationMatchesExecutor(
    input.preparedInvocation,
    input.plan.registration.executor,
  );
  const digest = await createPreparedInvocationDigest(input.preparedInvocation);
  if (digest !== input.plan.preparedInvocationDigest) {
    throw new TypeError("Prepared invocation digest does not match the dispatch plan.");
  }
  if (!sameStrings(
    input.preparedInvocation.secretReferences,
    input.plan.allowedSecretReferences,
  )) {
    throw new TypeError("Prepared invocation secret references do not match the dispatch plan.");
  }
  return Object.freeze({ invocation: input.preparedInvocation });
}

async function createSandboxPolicy(
  plan: DispatchSandboxActionInput["plan"],
  limits: ActionExecutionLimits,
): Promise<SandboxPolicyEnvelope> {
  const fields = {
    schemaVersion: 1 as const,
    actionFingerprint: plan.actionFingerprint,
    authoritySnapshotId: plan.authoritySnapshotId,
    enforcement: plan.enforcement,
    defaultDisposition: "deny" as const,
    authorizedEffects: plan.authorizedEffects,
    fileSystemPermissions: plan.effectivePermissions.fileSystem,
    processPermissions: plan.effectivePermissions.process,
    networkPermissions: plan.effectivePermissions.network,
    remoteToolPermissions: plan.effectivePermissions.remoteTool,
    environmentPolicy: Object.freeze({
      kind: "bound_configuration" as const,
      environment: plan.environment,
    }),
    resourceLimits: limits,
    allowedSecretReferences: plan.allowedSecretReferences,
  };
  const policyId = await createCanonicalSha256Digest(
    "agent-anything.sandbox-policy.v1",
    fields,
  );
  return deepFreeze({ ...fields, policyId });
}

function createExecutorRegistry(
  registrations: ActionRegistrationSnapshot,
  executors: readonly ActionExecutor[],
): ReadonlyMap<string, RegisteredExecutor> {
  if (!Array.isArray(executors)) throw new TypeError("Action executors must be an array.");
  const required = new Map<string, ActionRegistrationSnapshot["registrations"][number]["executor"]>();
  for (const registration of registrations.registrations) {
    required.set(descriptorKey(registration.executor), registration.executor);
  }
  const result = new Map<string, RegisteredExecutor>();
  for (const executor of executors) {
    const key = descriptorKey(executor.descriptor);
    if (!required.has(key)) {
      throw new TypeError(`Unregistered ActionExecutor implementation: ${key}.`);
    }
    if (result.has(key)) {
      throw new TypeError(`Duplicate ActionExecutor implementation: ${key}.`);
    }
    result.set(key, Object.freeze({ key, executor }));
  }
  return result;
}

function createProviderRegistry(
  providers: readonly SandboxProvider[],
): ReadonlyMap<SandboxProviderKind, RegisteredProvider> {
  if (!Array.isArray(providers)) throw new TypeError("Sandbox providers must be an array.");
  const result = new Map<SandboxProviderKind, RegisteredProvider>();
  for (const provider of providers) {
    const descriptor = snapshotProviderDescriptor(provider);
    if (result.has(descriptor.kind)) {
      throw new TypeError(`Duplicate SandboxProvider kind: ${descriptor.kind}.`);
    }
    result.set(descriptor.kind, Object.freeze({ provider, descriptor }));
  }
  return result;
}

function snapshotProviderDescriptor(provider: SandboxProvider): SandboxProviderDescriptor {
  if (
    provider === null ||
    typeof provider !== "object" ||
    typeof provider.execute !== "function" ||
    typeof provider.cancel !== "function" ||
    (provider.kind !== "managed" && provider.kind !== "external") ||
    provider.descriptor?.kind !== provider.kind ||
    !isCanonicalToken(provider.descriptor.id) ||
    !isCanonicalToken(provider.descriptor.version)
  ) {
    throw new TypeError("SandboxProvider descriptor is invalid.");
  }
  const versions = snapshotUniqueIntegers(provider.descriptor.supportedPolicyVersions);
  const kinds = snapshotEffectKinds(provider.descriptor.supportedEffectKinds);
  return Object.freeze({
    id: provider.descriptor.id,
    version: provider.descriptor.version,
    kind: provider.kind,
    supportedPolicyVersions: versions,
    supportedEffectKinds: kinds,
  });
}

function mapProviderResult(
  result: SandboxProviderResult,
  attempt: SandboxAttempt,
  actionName: string,
  descriptor: SandboxProviderDescriptor,
  requiredKinds: readonly CapabilityEffectKind[],
  maxResultBytes: number,
): ActionExecutionResult {
  try {
    if (result?.status === "executed") {
      const evidence = snapshotEnforcementEvidence(
        result.enforcementEvidence,
        attempt,
        descriptor,
        requiredKinds,
      );
      return Object.freeze({
        status: "executed" as const,
        attempt,
        toolResult: snapshotToolResult(result.toolResult, attempt, actionName, maxResultBytes),
        isolation: "enforced" as const,
        enforcementEvidence: evidence,
      });
    }
    if (result?.status === "denied") {
      return Object.freeze({
        status: "sandbox_denied" as const,
        attempt,
        denial: snapshotDenial(result.denial, attempt),
      });
    }
    if (result?.status === "interrupted") {
      return Object.freeze({
        status: "interrupted" as const,
        attempt,
        interruption: snapshotInterruption(result.interruption, attempt.runId, attempt.id),
      });
    }
    if (result?.status === "enforcement_failed") {
      if (
        !["capability_check", "setup", "dispatch", "settlement"].includes(result.stage) ||
        !isCanonicalToken(result.code) ||
        (result.effectState !== "none" && result.effectState !== "unknown")
      ) throw new TypeError("Sandbox enforcement failure is invalid.");
      return unavailable(attempt, result.code, result.stage, result.effectState);
    }
    throw new TypeError("SandboxProvider returned an unknown result.");
  } catch (error) {
    return unavailable(attempt, "sandbox_provider_result_invalid", "settlement", "unknown");
  }
}

function snapshotEnforcementEvidence(
  evidence: SandboxEnforcementEvidence,
  attempt: SandboxAttempt,
  descriptor: SandboxProviderDescriptor,
  requiredKinds: readonly CapabilityEffectKind[],
): SandboxEnforcementEvidence {
  if (
    evidence?.providerId !== descriptor.id ||
    evidence.providerVersion !== descriptor.version ||
    evidence.policyId !== attempt.policyId ||
    evidence.enforcement !== descriptor.kind ||
    !isCanonicalDateTime(evidence.settledAt)
  ) throw new TypeError("Sandbox enforcement evidence correlation is invalid.");
  const kinds = snapshotEffectKinds(evidence.enforcedEffectKinds);
  if (requiredKinds.some((kind) => !kinds.includes(kind))) {
    throw new TypeError("Sandbox enforcement evidence is incomplete.");
  }
  return Object.freeze({ ...evidence, enforcedEffectKinds: kinds });
}

function snapshotDenial(denial: SandboxDenial, attempt: SandboxAttempt): SandboxDenial {
  if (
    denial?.attemptId !== attempt.id ||
    denial.runId !== attempt.runId ||
    denial.actionId !== attempt.actionId ||
    denial.actionFingerprint !== attempt.actionFingerprint ||
    denial.ordinal !== attempt.ordinal ||
    !isCanonicalToken(denial.code) ||
    (denial.effectState !== "none" && denial.effectState !== "unknown") ||
    typeof denial.message !== "string" ||
    denial.message.length === 0 ||
    denial.message.length > 2_000
  ) throw new TypeError("SandboxDenial correlation is invalid.");
  const snapshot = deepFreeze({
    ...denial,
    deniedEffect: snapshotCapabilityEffect(denial.deniedEffect),
  });
  gatewaySandboxDenials.add(snapshot);
  return snapshot;
}

function snapshotToolResult(
  result: ToolResult,
  attempt: SandboxAttempt,
  actionName: string,
  maxResultBytes: number,
): ToolResult {
  if (
    result === null ||
    typeof result !== "object" ||
    result.toolCallId !== attempt.actionId ||
    result.toolName !== actionName ||
    !["succeeded", "failed", "cancelled", "timeout", "skipped", "partial", "interrupted"]
      .includes(result.status) ||
    !isCanonicalDateTime(result.startedAt) ||
    !isCanonicalDateTime(result.finishedAt) ||
    Date.parse(result.finishedAt) < Date.parse(result.startedAt) ||
    result.metadata === null ||
    typeof result.metadata !== "object"
  ) throw new TypeError("ActionExecutor returned an invalid ToolResult.");
  const encoded = JSON.stringify(result);
  if (encoded === undefined || new TextEncoder().encode(encoded).byteLength > maxResultBytes) {
    throw new TypeError("ActionExecutor ToolResult exceeds the configured result limit.");
  }
  return deepFreeze({ ...result });
}

function attachProviderCancellation(input: {
  readonly provider: SandboxProvider;
  readonly attempt: SandboxAttempt;
  readonly interruption: InvocationInterruptionContext;
  readonly deadlineAt: ISODateTimeString;
  readonly now: () => ISODateTimeString;
}) {
  let disposed = false;
  let sent = false;
  const send = (interruption: InvocationInterruptionRef) => {
    if (disposed || sent) return;
    sent = true;
    const request: SandboxCancellationRequest = Object.freeze({
      attemptId: input.attempt.id,
      runId: input.attempt.runId,
      actionId: input.attempt.actionId,
      interruption,
    });
    void input.provider.cancel(request).catch(() => undefined);
  };
  const onAbort = () => {
    const observed = observeInterruption(input.interruption, input.attempt.runId);
    if (observed.status === "interrupted") send(observed.interruption);
  };
  input.interruption.signal.addEventListener("abort", onAbort, { once: true });
  const timeoutMs = Math.max(0, Date.parse(input.deadlineAt) - Date.parse(input.now()));
  const timer = setTimeout(() => send(Object.freeze({
    kind: "operation_deadline" as const,
    deadline: Object.freeze({
      operationId: input.attempt.id,
      deadlineAt: input.deadlineAt,
    }),
  })), timeoutMs);
  if (input.interruption.signal.aborted) onAbort();
  return Object.freeze({
    dispose() {
      disposed = true;
      clearTimeout(timer);
      input.interruption.signal.removeEventListener("abort", onAbort);
    },
  });
}

function createLocalInterruption(
  upstream: InvocationInterruptionContext,
  attempt: SandboxAttempt,
  deadlineAt: ISODateTimeString,
  now: () => ISODateTimeString,
) {
  const controller = new AbortController();
  let interruption: InvocationInterruptionRef | null = null;
  const abort = (next: InvocationInterruptionRef) => {
    if (interruption !== null) return;
    interruption = next;
    controller.abort(next);
  };
  const onAbort = () => {
    const observed = observeInterruption(upstream, attempt.runId);
    if (observed.status === "interrupted") abort(observed.interruption);
  };
  upstream.signal.addEventListener("abort", onAbort, { once: true });
  const timeoutMs = Math.max(0, Date.parse(deadlineAt) - Date.parse(now()));
  const timer = setTimeout(() => abort(Object.freeze({
    kind: "operation_deadline" as const,
    deadline: Object.freeze({ operationId: attempt.id, deadlineAt }),
  })), timeoutMs);
  if (upstream.signal.aborted) onAbort();
  if (timeoutMs === 0) abort(Object.freeze({
    kind: "operation_deadline" as const,
    deadline: Object.freeze({ operationId: attempt.id, deadlineAt }),
  }));
  return {
    signal: controller.signal,
    get interruption() {
      return interruption;
    },
    dispose() {
      clearTimeout(timer);
      upstream.signal.removeEventListener("abort", onAbort);
    },
  };
}

async function resolveSecrets(
  resolver: ActionSecretResolver | undefined,
  attempt: SandboxAttempt,
  references: readonly string[],
): Promise<readonly ResolvedActionSecret[]> {
  if (references.length === 0) return Object.freeze([]);
  if (resolver === undefined) throw new MissingSecretResolverError();
  const resolved = await resolver.resolve({ attempt, references });
  if (!Array.isArray(resolved) || resolved.length !== references.length) {
    throw new TypeError("Resolved secret set does not match requested references.");
  }
  const byReference = new Map<string, string>();
  for (const item of resolved) {
    if (
      item === null ||
      typeof item !== "object" ||
      !references.includes(item.reference) ||
      typeof item.value !== "string" ||
      byReference.has(item.reference)
    ) throw new TypeError("Resolved secret is invalid.");
    byReference.set(item.reference, item.value);
  }
  return Object.freeze(references.map((reference) => Object.freeze({
    reference,
    value: byReference.get(reference)!,
  })));
}

class MissingSecretResolverError extends Error {}

function observeInterruption(
  context: InvocationInterruptionContext,
  runId: string,
):
  | { readonly status: "active" }
  | { readonly status: "interrupted"; readonly interruption: InvocationInterruptionRef }
  | { readonly status: "invalid"; readonly message: string } {
  if (!context?.signal || typeof context.signal.aborted !== "boolean") {
    return { status: "invalid", message: "Sandbox interruption context is invalid." };
  }
  if (!context.signal.aborted) return { status: "active" };
  try {
    const candidate = context.interruption ?? interruptionFromReason(context.signal.reason, runId);
    if (candidate === null) throw new TypeError("Missing interruption attribution.");
    return { status: "interrupted", interruption: snapshotInterruption(candidate, runId) };
  } catch (error) {
    return { status: "invalid", message: safeMessage(error, "Interruption is unattributed.") };
  }
}

function interruptionFromReason(reason: unknown, runId: string): InvocationInterruptionRef | null {
  if (
    reason !== null &&
    typeof reason === "object" &&
    "id" in reason &&
    "runId" in reason &&
    typeof reason.id === "string" &&
    reason.runId === runId
  ) {
    return Object.freeze({
      kind: "run_cancellation" as const,
      cancellation: Object.freeze({ runId, requestId: reason.id }),
    });
  }
  return null;
}

function snapshotInterruption(
  interruption: InvocationInterruptionRef,
  runId: string,
  expectedOperationId?: string,
): InvocationInterruptionRef {
  if (
    interruption?.kind === "run_cancellation" &&
    interruption.cancellation?.runId === runId &&
    isCanonicalToken(interruption.cancellation.requestId)
  ) return deepFreeze({ ...interruption });
  if (
    interruption?.kind === "operation_deadline" &&
    isCanonicalToken(interruption.deadline?.operationId) &&
    (expectedOperationId === undefined ||
      interruption.deadline.operationId === expectedOperationId) &&
    isCanonicalDateTime(interruption.deadline?.deadlineAt)
  ) return deepFreeze({ ...interruption });
  throw new TypeError("Sandbox interruption attribution is invalid.");
}

function requiredEffectKinds(policy: SandboxPolicyEnvelope): readonly CapabilityEffectKind[] {
  if (policy.authorizedEffects.kind === "effect_free") return Object.freeze([]);
  return Object.freeze([...new Set(
    policy.authorizedEffects.values.map((effect) => effect.kind),
  )].sort());
}

function snapshotEffectKinds(input: readonly CapabilityEffectKind[]): readonly CapabilityEffectKind[] {
  if (!Array.isArray(input)) throw new TypeError("Effect kinds must be an array.");
  const allowed = new Set<CapabilityEffectKind>([
    "file_system",
    "process",
    "network",
    "remote_tool",
  ]);
  const values = [...input];
  if (values.some((value) => !allowed.has(value)) || new Set(values).size !== values.length) {
    throw new TypeError("Effect kinds are invalid or duplicated.");
  }
  return Object.freeze(values.sort());
}

function snapshotUniqueIntegers(input: readonly number[]): readonly number[] {
  if (!Array.isArray(input) || input.some((value) => !Number.isSafeInteger(value) || value < 1)) {
    throw new TypeError("Policy versions must be positive integers.");
  }
  const values = [...input];
  if (new Set(values).size !== values.length) throw new TypeError("Policy versions are duplicated.");
  return Object.freeze(values.sort((left, right) => left - right));
}

function snapshotLimits(input: ActionExecutionLimits): ActionExecutionLimits {
  if (!Number.isSafeInteger(input?.maxResultBytes) || input.maxResultBytes < 1) {
    throw new TypeError("ActionExecutionLimits.maxResultBytes must be positive.");
  }
  return Object.freeze({ maxResultBytes: input.maxResultBytes });
}

function executorKey(
  invocation: DispatchSandboxActionInput["preparedInvocation"],
): string {
  return descriptorKey({
    id: invocation.executorId,
    version: invocation.executorVersion,
    invocationContractVersion: invocation.contractVersion,
  });
}

function descriptorKey(descriptor: {
  readonly id: string;
  readonly version: string;
  readonly invocationContractVersion: string;
}): string {
  return `${descriptor.id}\u0000${descriptor.version}\u0000${descriptor.invocationContractVersion}`;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function unavailable(
  attempt: SandboxAttempt,
  code: string,
  stage: "capability_check" | "setup" | "dispatch" | "settlement",
  effectState: "none" | "unknown",
): ActionExecutionResult {
  return Object.freeze({
    status: "sandbox_unavailable" as const,
    attempt,
    code,
    stage,
    effectState,
  });
}

function failed(
  attempt: SandboxAttempt | null,
  code: string,
  message: string,
  owner: RuntimeError["owner"] = "sandbox",
): ActionExecutionResult {
  return Object.freeze({
    status: "failed" as const,
    attempt,
    error: Object.freeze({
      owner,
      code,
      message,
      retryable: false,
      metadata: Object.freeze({}),
    }),
  });
}

function preparationFailed(code: string, message: string): SandboxDispatchPreparationResult {
  return Object.freeze({
    status: "failed" as const,
    error: Object.freeze({
      owner: "sandbox" as const,
      code,
      message,
      retryable: false,
      metadata: Object.freeze({}),
    }),
  });
}

function isCanonicalDateTime(input: unknown): input is ISODateTimeString {
  return typeof input === "string" &&
    !Number.isNaN(Date.parse(input)) &&
    new Date(input).toISOString() === input;
}

function isCanonicalToken(input: unknown): input is string {
  return typeof input === "string" &&
    input.length > 0 &&
    input.length <= 1_024 &&
    input === input.trim() &&
    /^[A-Za-z0-9][A-Za-z0-9._:/+-]*$/.test(input);
}

function safeMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.length > 0 ? error.message : fallback;
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value !== "object" || value === null || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}
