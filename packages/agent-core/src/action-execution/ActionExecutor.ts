import type {
  InvocationInterruptionContext,
  ISODateTimeString,
} from "@agent-anything/shared";
import type { ToolResult } from "@agent-anything/tools";
import type { ActionExecutorDescriptor } from "./ActionRegistration.js";
import type {
  ActionExecutionLimits,
  SandboxAttempt,
} from "./SandboxContracts.js";
import type { PreparedActionInvocation } from "./PreparedActionInvocation.js";

const actionExecutorDispatchPermitBrand: unique symbol = Symbol(
  "ActionExecutorDispatchPermit",
);
const actionExecutorDispatchPermits = new WeakSet<object>();

export interface ActionExecutorDispatchPermit {
  readonly [actionExecutorDispatchPermitBrand]: true;
}

export interface ResolvedActionSecret {
  readonly reference: string;
  readonly value: string;
}

export interface ActionExecutorContext {
  readonly attempt: SandboxAttempt;
  readonly interruption: InvocationInterruptionContext;
  readonly deadlineAt: ISODateTimeString;
  readonly limits: ActionExecutionLimits;
  readonly resolvedSecrets: readonly ResolvedActionSecret[];
  readonly dispatchPermit: ActionExecutorDispatchPermit;
}

export interface ActionExecutor<
  TInvocation extends PreparedActionInvocation = PreparedActionInvocation,
> {
  readonly descriptor: ActionExecutorDescriptor;

  execute(
    invocation: TInvocation,
    context: ActionExecutorContext,
  ): Promise<ToolResult>;
}

export function assertActionExecutorDispatchContext(
  context: ActionExecutorContext,
): void {
  if (
    context === null ||
    typeof context !== "object" ||
    context.dispatchPermit === null ||
    typeof context.dispatchPermit !== "object" ||
    context.dispatchPermit[actionExecutorDispatchPermitBrand] !== true ||
    !actionExecutorDispatchPermits.has(context.dispatchPermit)
  ) {
    throw new TypeError(
      "ActionExecutor requires a gateway-created dispatch context.",
    );
  }
}

// Internal to the package. The action-execution public entry point does not export it.
export function createActionExecutorDispatchPermit(): ActionExecutorDispatchPermit {
  const permit = Object.freeze({
    [actionExecutorDispatchPermitBrand]: true as const,
  });
  actionExecutorDispatchPermits.add(permit);
  return permit;
}
