import type { PolicyFailure } from "@agent-anything/governance";
import type {
  PermissionFailure,
} from "@agent-anything/permission";
import type { ToolFailure } from "@agent-anything/tools";
import type { SandboxExecutionFailure } from "./SandboxExecutionFailure.js";


export interface ActionProcessingFailure {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export type ActionExecutionFailure =
  | {
      readonly kind: "action_execution";
      readonly failure: ActionProcessingFailure;
    }
  | { readonly kind: "policy"; readonly failure: PolicyFailure }
  | { readonly kind: "permission"; readonly failure: PermissionFailure }
  | { readonly kind: "sandbox"; readonly failure: SandboxExecutionFailure }
  | { readonly kind: "tool"; readonly failure: ToolFailure };

export type ActionExecutionFailureKind = ActionExecutionFailure["kind"];

export type ActionExecutionFailureForKind<
  TKind extends ActionExecutionFailureKind,
> = Extract<ActionExecutionFailure, { readonly kind: TKind }>["failure"];

export function createActionExecutionFailure<
  TKind extends ActionExecutionFailureKind,
>(
  kind: TKind,
  failure: ActionExecutionFailureForKind<TKind>,
): Extract<ActionExecutionFailure, { readonly kind: TKind }> {
  return Object.freeze({ kind, failure }) as unknown as Extract<
    ActionExecutionFailure,
    { readonly kind: TKind }
  >;
}
