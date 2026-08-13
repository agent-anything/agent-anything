import type { ActionAttemptRef } from "@agent-anything/canonical-action/subject";
import type {
  ActionExecutorDescriptor,
} from "@agent-anything/canonical-action/registration";
import {
  assertActionExecutorDispatchContext,
  createActionExecutorDispatchPermit,
  type ActionExecutor,
  type PhysicalAttemptOutcome,
  type ResolvedActionSecret,
} from "../execution/ActionExecutor.js";
import type {
  SandboxCancellationRequest,
  SandboxCancellationResult,
  SandboxEnforcementEvidence,
  SandboxExecutionGateway,
  SandboxExecutionRequest,
  SandboxExecutionResult,
  SandboxProvider,
  SandboxProviderKind,
} from "./SandboxContracts.js";

export interface ResolveActionSecretsInput {
  readonly attempt: ActionAttemptRef;
  readonly references: readonly string[];
}

export interface ActionSecretResolver {
  resolve(input: ResolveActionSecretsInput): Promise<readonly ResolvedActionSecret[]>;
}

export interface CreateSandboxExecutionGatewayInput {
  readonly executors: readonly ActionExecutor[];
  readonly providers?: readonly SandboxProvider[];
  readonly secretResolver?: ActionSecretResolver;
}

interface ActiveAttempt {
  readonly enforcement: "managed" | "external" | "disabled";
  readonly provider: SandboxProvider | null;
  settled: boolean;
}

export function createSandboxExecutionGateway(
  input: CreateSandboxExecutionGatewayInput,
): SandboxExecutionGateway {
  return new DefaultSandboxExecutionGateway(input);
}

class DefaultSandboxExecutionGateway implements SandboxExecutionGateway {
  private readonly executors: ReadonlyMap<string, ActionExecutor>;
  private readonly providers: ReadonlyMap<SandboxProviderKind, SandboxProvider>;
  private readonly attempts = new Map<string, ActiveAttempt>();

  constructor(private readonly input: CreateSandboxExecutionGatewayInput) {
    this.executors = captureExecutors(input.executors);
    this.providers = captureProviders(input.providers ?? []);
  }

  async execute(request: SandboxExecutionRequest): Promise<SandboxExecutionResult> {
    const attemptKey = actionAttemptKey(request.attempt);
    if (this.attempts.has(attemptKey)) {
      return unavailable(
        request,
        "dispatch",
        "sandbox_attempt_already_submitted",
        "unknown",
      );
    }
    const executor = this.executors.get(executorKey(request.executor));
    if (executor === undefined || !sameExecutor(executor.descriptor, request.executor)) {
      return unavailable(
        request,
        "capability_check",
        "sandbox_executor_unavailable",
        "none",
      );
    }
    const validation = validateRequest(request);
    if (validation !== null) {
      return unavailable(request, "capability_check", validation, "none");
    }
    const provider = request.policy.enforcement === "disabled"
      ? null
      : this.providers.get(request.policy.enforcement);
    if (request.policy.enforcement !== "disabled" && provider === undefined) {
      return unavailable(
        request,
        "capability_check",
        "sandbox_provider_unavailable",
        "none",
      );
    }
    const active: ActiveAttempt = {
      enforcement: request.policy.enforcement,
      provider: provider ?? null,
      settled: false,
    };
    this.attempts.set(attemptKey, active);

    try {
      if (request.policy.enforcement === "disabled") {
        return await this.executeUnisolated(request, executor);
      }
      if (!providerSupports(provider!, request)) {
        return unavailable(
          request,
          "capability_check",
          "sandbox_policy_unsupported",
          "none",
        );
      }
      let result;
      try {
        result = await provider!.execute(request);
      } catch {
        return unavailable(
          request,
          "dispatch",
          "sandbox_provider_failed",
          "unknown",
        );
      }
      if (result.status === "enforcement_failed") {
        return unavailable(
          request,
          result.stage,
          result.code,
          result.effectState,
        );
      }
      const invalid = validateProviderSettlement(request, result.enforcementEvidence);
      if (invalid !== null || !validateOutcome(result.outcome, executor, request)) {
        return unavailable(
          request,
          "settlement",
          invalid ?? "sandbox_physical_outcome_invalid",
          "unknown",
        );
      }
      return Object.freeze({
        status: "settled" as const,
        attempt: request.attempt,
        outcome: freezeOutcome(result.outcome),
        isolation: "enforced" as const,
        enforcementEvidence: Object.freeze(result.enforcementEvidence),
      });
    } finally {
      active.settled = true;
    }
  }

  async cancel(input: SandboxCancellationRequest): Promise<SandboxCancellationResult> {
    const active = this.attempts.get(actionAttemptKey(input.attempt));
    if (active === undefined) {
      return Object.freeze({
        status: "unavailable" as const,
        code: "sandbox_attempt_unknown",
      });
    }
    if (active.settled) {
      return Object.freeze({ status: "already_settled" as const });
    }
    if (active.provider === null) {
      return Object.freeze({ status: "accepted" as const });
    }
    try {
      return await active.provider.cancel(input);
    } catch {
      return Object.freeze({
        status: "unavailable" as const,
        code: "sandbox_cancellation_failed",
      });
    }
  }

  private async executeUnisolated(
    request: SandboxExecutionRequest,
    executor: ActionExecutor,
  ): Promise<SandboxExecutionResult> {
    let resolvedSecrets: readonly ResolvedActionSecret[] = [];
    if (request.invocation.secretReferences.length > 0) {
      if (this.input.secretResolver === undefined) {
        return unavailable(
          request,
          "setup",
          "sandbox_secret_resolver_unavailable",
          "none",
        );
      }
      try {
        resolvedSecrets = await this.input.secretResolver.resolve({
          attempt: request.attempt,
          references: request.invocation.secretReferences,
        });
      } catch {
        return unavailable(
          request,
          "setup",
          "sandbox_secret_resolution_failed",
          "none",
        );
      }
      if (!sameSecretReferences(request.invocation.secretReferences, resolvedSecrets)) {
        return unavailable(
          request,
          "setup",
          "sandbox_secret_resolution_invalid",
          "none",
        );
      }
    }

    let outcome: PhysicalAttemptOutcome;
    try {
      const context = Object.freeze({
        attempt: request.attempt,
        interruption: request.interruption,
        deadlineAt: request.deadlineAt,
        limits: request.policy.resourceLimits,
        resolvedSecrets: Object.freeze([...resolvedSecrets]),
        dispatchPermit: createActionExecutorDispatchPermit(),
      });
      assertActionExecutorDispatchContext(context);
      outcome = await executor.execute(request.invocation, context);
    } catch {
      return unavailable(
        request,
        "dispatch",
        "executor_dispatch_failed",
        "unknown",
      );
    }
    if (!validateOutcome(outcome, executor, request)) {
      return unavailable(
        request,
        "settlement",
        "executor_physical_outcome_invalid",
        "unknown",
      );
    }
    const settledAt = new Date().toISOString();
    return Object.freeze({
      status: "settled" as const,
      attempt: request.attempt,
      outcome: freezeOutcome(outcome),
      isolation: "unisolated" as const,
      enforcementEvidence: Object.freeze({
        providerId: "action-execution.disabled-passthrough",
        providerVersion: "1",
        policyId: request.policy.policyId,
        enforcement: "disabled" as const,
        enforcedEffectFamilies: Object.freeze([...request.policy.effectFamilies]),
        settledAt,
      }),
    });
  }
}

function captureExecutors(
  input: readonly ActionExecutor[],
): ReadonlyMap<string, ActionExecutor> {
  if (!Array.isArray(input)) throw new TypeError("Sandbox executors must be an array.");
  const result = new Map<string, ActionExecutor>();
  for (const executor of input) {
    const key = executorKey(executor.descriptor);
    if (result.has(key)) throw new TypeError(`Duplicate Action Executor: ${key}.`);
    if (typeof executor.validatePayload !== "function" || typeof executor.execute !== "function") {
      throw new TypeError(`Action Executor '${key}' is incomplete.`);
    }
    result.set(key, Object.freeze({
      descriptor: Object.freeze({ ...executor.descriptor }),
      validatePayload: executor.validatePayload.bind(executor),
      execute: executor.execute.bind(executor),
    }));
  }
  return result;
}

function captureProviders(
  input: readonly SandboxProvider[],
): ReadonlyMap<SandboxProviderKind, SandboxProvider> {
  if (!Array.isArray(input)) throw new TypeError("Sandbox providers must be an array.");
  const result = new Map<SandboxProviderKind, SandboxProvider>();
  for (const provider of input) {
    if (provider.kind !== "managed" && provider.kind !== "external") {
      throw new TypeError("Sandbox provider kind is unsupported.");
    }
    if (provider.descriptor.kind !== provider.kind || result.has(provider.kind)) {
      throw new TypeError(`Duplicate or incoherent Sandbox provider: ${provider.kind}.`);
    }
    result.set(provider.kind, provider);
  }
  return result;
}

function validateRequest(request: SandboxExecutionRequest): string | null {
  if (
    request.policy.schemaVersion !== 1 ||
    request.policy.defaultDisposition !== "deny" ||
    request.policy.actionFingerprint !== request.attempt.actionFingerprint ||
    request.policy.authoritySnapshotId !== request.attempt.authoritySnapshotId ||
    request.policy.policyId !== request.attempt.policyId ||
    request.policy.enforcement !== request.attempt.enforcement ||
    request.actionRegistrationFingerprint !==
      request.attempt.actionRegistrationFingerprint ||
    request.invocation.executorId !== request.executor.id ||
    request.invocation.executorVersion !== request.executor.version ||
    request.invocation.contractVersion !== request.executor.invocationContractVersion
  ) {
    return "sandbox_request_incoherent";
  }
  if (
    !Number.isSafeInteger(request.attempt.ordinal) ||
    request.attempt.ordinal < 1 ||
    !Number.isSafeInteger(request.policy.resourceLimits.maxResultBytes) ||
    request.policy.resourceLimits.maxResultBytes < 1 ||
    Number.isNaN(Date.parse(request.deadlineAt))
  ) {
    return "sandbox_request_invalid";
  }
  return null;
}

function providerSupports(
  provider: SandboxProvider,
  request: SandboxExecutionRequest,
): boolean {
  return provider.descriptor.supportedPolicyVersions.includes(request.policy.schemaVersion) &&
    request.policy.effectFamilies.every((family) =>
      provider.descriptor.supportedEffectFamilies.includes(family)
    );
}

function validateProviderSettlement(
  request: SandboxExecutionRequest,
  evidence: SandboxEnforcementEvidence,
): string | null {
  if (
    evidence.policyId !== request.policy.policyId ||
    evidence.enforcement !== request.policy.enforcement ||
    evidence.enforcedEffectFamilies.length !== request.policy.effectFamilies.length ||
    request.policy.effectFamilies.some((family) =>
      !evidence.enforcedEffectFamilies.includes(family)
    ) ||
    Number.isNaN(Date.parse(evidence.settledAt))
  ) {
    return "sandbox_enforcement_evidence_invalid";
  }
  return null;
}

function validateOutcome(
  outcome: PhysicalAttemptOutcome,
  executor: ActionExecutor,
  request: SandboxExecutionRequest,
): boolean {
  if (outcome === null || typeof outcome !== "object") return false;
  if (outcome.status === "completed") {
    if (!executor.validatePayload(outcome.payload)) return false;
    return serializedSize(outcome.payload) <= request.policy.resourceLimits.maxResultBytes;
  }
  if (outcome.status === "denied") return outcome.effectState === "none";
  if (outcome.status === "interrupted" || outcome.status === "timed_out") {
    return ["none", "settled", "unknown"].includes(outcome.effectState);
  }
  if (outcome.status === "failed") {
    return ["none", "settled", "unknown"].includes(outcome.effectState);
  }
  return false;
}

function freezeOutcome<TPayload>(
  outcome: PhysicalAttemptOutcome<TPayload>,
): PhysicalAttemptOutcome<TPayload> {
  return deepFreeze(outcome);
}

function unavailable(
  request: SandboxExecutionRequest,
  stage: "capability_check" | "setup" | "dispatch" | "settlement",
  code: string,
  effectState: "none" | "unknown",
): SandboxExecutionResult {
  return Object.freeze({
    status: "sandbox_unavailable" as const,
    attempt: request.attempt,
    code,
    stage,
    effectState,
  });
}

function sameSecretReferences(
  expected: readonly string[],
  actual: readonly ResolvedActionSecret[],
): boolean {
  if (actual.length !== expected.length) return false;
  const expectedSet = new Set(expected);
  return actual.every((secret) =>
    expectedSet.has(secret.reference) && typeof secret.value === "string"
  ) && new Set(actual.map((secret) => secret.reference)).size === actual.length;
}

function sameExecutor(
  left: ActionExecutorDescriptor,
  right: ActionExecutorDescriptor,
): boolean {
  return left.id === right.id &&
    left.version === right.version &&
    left.invocationContractVersion === right.invocationContractVersion &&
    left.physicalPayloadSchemaRevision === right.physicalPayloadSchemaRevision;
}

function executorKey(descriptor: ActionExecutorDescriptor): string {
  return `${descriptor.id}@${descriptor.version}#${descriptor.invocationContractVersion}:${descriptor.physicalPayloadSchemaRevision}`;
}

function actionAttemptKey(attempt: ActionAttemptRef): string {
  return `${attempt.action.id}:${attempt.ordinal}:${attempt.id}`;
}

function serializedSize(input: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(input), "utf8");
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function deepFreeze<T>(input: T, seen = new WeakSet<object>()): T {
  if (input === null || typeof input !== "object" || seen.has(input)) return input;
  seen.add(input);
  for (const value of Object.values(input)) deepFreeze(value, seen);
  return Object.freeze(input);
}
