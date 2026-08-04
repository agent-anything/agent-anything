import type { ContextFailure } from "@agent-anything/context";
import type { ProviderFailure } from "@agent-anything/model-interaction";
import type {
  AuditFailure,
  TelemetryFailure,
} from "@agent-anything/observability";
import type {
  ApprovalFailure,
  PermissionFailure,
} from "@agent-anything/permission";
import type { PolicyFailure } from "@agent-anything/governance";
import type {
  ActionProcessingFailure,
  SandboxExecutionFailure,
} from "@agent-anything/action-execution";
import type { ToolFailure } from "@agent-anything/tools";
import type { Metadata } from "@agent-anything/foundation";
import type { ModelFailure } from "../controller/ModelFailure.js";

export interface RuntimeFailure {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly metadata: Readonly<Metadata>;
}

export type RunFailureCause =
  | { readonly kind: "runtime"; readonly failure: RuntimeFailure }
  | { readonly kind: "model"; readonly failure: ModelFailure }
  | { readonly kind: "provider"; readonly failure: ProviderFailure }
  | { readonly kind: "approval"; readonly failure: ApprovalFailure }
  | { readonly kind: "permission"; readonly failure: PermissionFailure }
  | { readonly kind: "policy"; readonly failure: PolicyFailure }
  | {
      readonly kind: "action_execution";
      readonly failure: ActionProcessingFailure;
    }
  | {
      readonly kind: "sandbox";
      readonly failure: SandboxExecutionFailure;
    }
  | { readonly kind: "tool"; readonly failure: ToolFailure }
  | { readonly kind: "context"; readonly failure: ContextFailure }
  | { readonly kind: "audit"; readonly failure: AuditFailure }
  | { readonly kind: "telemetry"; readonly failure: TelemetryFailure };

export type RunFailureKind = RunFailureCause["kind"];

export type RunFailureForKind<TKind extends RunFailureKind> = Extract<
  RunFailureCause,
  { readonly kind: TKind }
>["failure"];

export function createRunFailureCause<TKind extends RunFailureKind>(
  kind: TKind,
  failure: RunFailureForKind<TKind>,
): Extract<RunFailureCause, { readonly kind: TKind }> {
  return Object.freeze({ kind, failure }) as unknown as Extract<
    RunFailureCause,
    { readonly kind: TKind }
  >;
}

export function runFailureCode(cause: RunFailureCause): string {
  return cause.failure.code;
}

export function runFailureMessage(cause: RunFailureCause): string {
  return cause.failure.message;
}

export function runFailureMetadata(
  cause: RunFailureCause,
): Readonly<Metadata> {
  return cause.failure.metadata;
}
