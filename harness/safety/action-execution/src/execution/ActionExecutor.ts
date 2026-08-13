import type {
  InvocationInterruptionContext,
} from "@agent-anything/agent-core/control";
import type { ActionExecutorDescriptor } from "@agent-anything/canonical-action/registration";
import type { ActionAttemptRef } from "@agent-anything/canonical-action/subject";
import type { PreparedActionInvocation } from "@agent-anything/canonical-action/subject";
import type { ActionExecutionLimits } from "../sandbox/SandboxContracts.js";

const actionExecutorDispatchPermitBrand: unique symbol = Symbol("ActionExecutorDispatchPermit");
const actionExecutorDispatchPermits = new WeakSet<object>();

export interface ActionExecutorDispatchPermit {
  readonly [actionExecutorDispatchPermitBrand]: true;
}

export interface ResolvedActionSecret {
  readonly reference: string;
  readonly value: string;
}

export interface ActionExecutorContext {
  readonly attempt: ActionAttemptRef;
  readonly interruption: InvocationInterruptionContext;
  readonly deadlineAt: string;
  readonly limits: ActionExecutionLimits;
  readonly resolvedSecrets: readonly ResolvedActionSecret[];
  readonly dispatchPermit: ActionExecutorDispatchPermit;
}

export interface PhysicalEvidence {
  readonly code: string;
  readonly message: string;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface ExecutorFailure extends PhysicalEvidence {
  readonly retryable: boolean;
}

export type PhysicalAttemptOutcome<TPayload = unknown> =
  | {
      readonly status: "completed";
      readonly effectState: "none" | "settled";
      readonly payload: TPayload;
    }
  | {
      readonly status: "denied";
      readonly effectState: "none";
      readonly evidence: PhysicalEvidence;
    }
  | {
      readonly status: "interrupted" | "timed_out";
      readonly effectState: "none" | "settled" | "unknown";
      readonly evidence: PhysicalEvidence;
    }
  | {
      readonly status: "failed";
      readonly effectState: "none" | "settled" | "unknown";
      readonly failure: ExecutorFailure;
    };

export interface ActionExecutor<
  TInvocation extends PreparedActionInvocation = PreparedActionInvocation,
  TPayload = unknown,
> {
  readonly descriptor: ActionExecutorDescriptor;
  validatePayload(candidate: unknown): candidate is TPayload;
  execute(
    invocation: TInvocation,
    context: ActionExecutorContext,
  ): Promise<PhysicalAttemptOutcome<TPayload>>;
}

export function assertActionExecutorDispatchContext(context: ActionExecutorContext): void {
  if (
    context === null ||
    typeof context !== "object" ||
    context.dispatchPermit === null ||
    typeof context.dispatchPermit !== "object" ||
    context.dispatchPermit[actionExecutorDispatchPermitBrand] !== true ||
    !actionExecutorDispatchPermits.has(context.dispatchPermit)
  ) {
    throw new TypeError("ActionExecutor requires a gateway-created dispatch context.");
  }
}

export function createActionExecutorDispatchPermit(): ActionExecutorDispatchPermit {
  const permit = Object.freeze({ [actionExecutorDispatchPermitBrand]: true as const });
  actionExecutorDispatchPermits.add(permit);
  return permit;
}
