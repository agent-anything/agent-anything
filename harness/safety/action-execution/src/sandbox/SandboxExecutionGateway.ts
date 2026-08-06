import type { InvocationInterruptionContext } from "@agent-anything/agent-core/run";
import {
  createActionExecutionFailure,
  type ActionExecutionFailureKind,
} from "../execution/ActionExecutionFailure.js";
import {
  createActionExecutorDispatchPermit,
  type ActionExecutor,
  type ActionExecutorContext,
  type ResolvedActionSecret,
} from "../execution/ActionExecutor.js";
import type { ActionRegistrationSnapshot } from "../registration/ActionRegistration.js";
import type {
  ActionExecutionLimits,
  ActionExecutionResult,
  CapabilityEffectKind,
  DispatchSandboxActionInput,
  SandboxAttempt,
  SandboxExecutionGateway,
  SandboxExecutionRequest,
  SandboxPolicyEnvelope,
  PreparedSandboxDispatch,
  SandboxDispatchPreparationResult,
  SandboxProvider,
  SandboxProviderKind,
} from "./SandboxContracts.js";
import {
  settleExecutorResult,
  settleProviderResult,
} from "./SandboxResultSettlement.js";
import { prepareSandboxDispatch } from "./SandboxDispatchPreparation.js";
import {
  createExecutorRegistry,
  createProviderRegistry,
  executorKey,
  type RegisteredExecutor,
  type RegisteredProvider,
} from "./SandboxRegistration.js";
import {
  MissingSecretResolverError,
  resolveActionSecrets,
  type ActionSecretResolver,
  type ResolveActionSecretsInput,
} from "./SandboxSecretResolution.js";
import {
  attachProviderCancellation,
  createLocalInterruption,
  observeSandboxInterruption,
} from "./SandboxInterruption.js";

export type {
  ActionSecretResolver,
  ResolveActionSecretsInput,
} from "./SandboxSecretResolution.js";

export { assertGatewaySandboxDenial } from "./SandboxResultSettlement.js";

export interface CreateSandboxExecutionGatewayInput {
  readonly registrations: ActionRegistrationSnapshot;
  readonly executors: readonly ActionExecutor[];
  readonly providers?: readonly SandboxProvider[];
  readonly limits: ActionExecutionLimits;
  readonly secretResolver?: ActionSecretResolver;
  readonly now?: () => string;
  readonly createAttemptId?: (input: {
    readonly runId: string;
    readonly actionId: string;
    readonly ordinal: 1 | 2;
  }) => string;
}

interface PreparedDispatchState {
  readonly attempt: SandboxAttempt;
  readonly policy: SandboxPolicyEnvelope;
  readonly toolName: string;
  readonly boundActionName: string;
  readonly invocation: DispatchSandboxActionInput["preparedInvocation"];
  readonly deadlineAt: string;
  readonly interruption: InvocationInterruptionContext;
  readonly enforcement: "managed" | "external" | "disabled";
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
  private readonly now: () => string;
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
    const stage = await prepareSandboxDispatch({
      dispatch: input,
      limits: this.limits,
      now: this.now,
      createAttemptId: this.createAttemptId,
    });
    if (stage.status === "failed") {
      return preparationFailed(stage.code, stage.message);
    }
    if (stage.status === "interrupted") {
      return Object.freeze({
        status: "interrupted" as const,
        interruption: stage.interruption,
      });
    }
    const { attempt, policy, invocation } = stage;
    const prepared = Object.freeze({ attempt });
    this.preparedDispatches.set(prepared, Object.freeze({
      attempt,
      policy,
      toolName: input.plan.actionName,
      boundActionName: input.plan.registration.actionName,
      invocation,
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

    const interruption = observeSandboxInterruption(
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
    readonly toolName: string;
    readonly boundActionName: string;
    readonly invocation: DispatchSandboxActionInput["preparedInvocation"];
    readonly deadlineAt: string;
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
      secrets = await resolveActionSecrets(
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
      return settleExecutorResult({
        result,
        attempt: input.attempt,
        boundActionName: input.boundActionName,
        toolName: input.toolName,
        maxResultBytes: this.limits.maxResultBytes,
      });
    } catch (error) {
      return failed(
        input.attempt,
        "tool_executor_failed",
        safeMessage(error, "ActionExecutor failed without a settled result."),
        "tool",
        "unknown",
      );
    } finally {
      local.dispose();
    }
  }

  private async dispatchProvider(input: {
    readonly attempt: SandboxAttempt;
    readonly policy: SandboxPolicyEnvelope;
    readonly toolName: string;
    readonly boundActionName: string;
    readonly invocation: DispatchSandboxActionInput["preparedInvocation"];
    readonly deadlineAt: string;
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
      return settleProviderResult({
        result: providerResult,
        attempt: input.attempt,
        boundActionName: input.boundActionName,
        toolName: input.toolName,
        descriptor: registered.descriptor,
        requiredKinds,
        maxResultBytes: this.limits.maxResultBytes,
      });
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

function requiredEffectKinds(policy: SandboxPolicyEnvelope): readonly CapabilityEffectKind[] {
  if (policy.authorizedEffects.kind === "effect_free") return Object.freeze([]);
  return Object.freeze([...new Set(
    policy.authorizedEffects.values.map((effect) => effect.kind),
  )].sort());
}

function snapshotLimits(input: ActionExecutionLimits): ActionExecutionLimits {
  if (!Number.isSafeInteger(input?.maxResultBytes) || input.maxResultBytes < 1) {
    throw new TypeError("ActionExecutionLimits.maxResultBytes must be positive.");
  }
  return Object.freeze({ maxResultBytes: input.maxResultBytes });
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
  owner: Extract<ActionExecutionFailureKind, "sandbox" | "tool"> = "sandbox",
  effectState: "none" | "unknown" = "none",
): ActionExecutionResult {
  const base = Object.freeze({
    code,
    message,
    retryable: false,
    metadata: Object.freeze({}),
  });
  return Object.freeze({
    status: "failed" as const,
    attempt,
    effectState,
    failure: owner === "sandbox"
      ? createActionExecutionFailure("sandbox", Object.freeze({
          ...base,
          effectState,
        }))
      : createActionExecutionFailure("tool", base),
  });
}

function preparationFailed(code: string, message: string): SandboxDispatchPreparationResult {
  return Object.freeze({
    status: "failed" as const,
    failure: createActionExecutionFailure("sandbox", Object.freeze({
      code,
      message,
      retryable: false,
      effectState: "none",
      metadata: Object.freeze({}),
    })),
  });
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
