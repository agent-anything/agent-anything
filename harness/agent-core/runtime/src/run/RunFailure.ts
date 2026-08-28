import type { ProviderFailure } from "@agent-anything/model-interaction";
import type { AuditFailure, TelemetryFailure } from "@agent-anything/observability";
import type { ApprovalFailure, PermissionFailure } from "@agent-anything/permission";
import type { PolicyFailure } from "@agent-anything/governance";
import type { ActionExecutionFailure } from "@agent-anything/action-execution/execution";
import type { SandboxExecutionFailure } from "@agent-anything/action-execution/sandbox";
import type { ToolFailure } from "@agent-anything/tools/result";
import type { OperationFailure } from "@agent-anything/operation-catalog/result";
import type { InteractionFailure } from "@agent-anything/interaction/protocol";
import type { CompositeFailure } from "@agent-anything/operation-composition/result";
import type { ModelFailure } from "../controller/ModelFailure.js";
import type { VerificationFailure } from "@agent-anything/verification/definition";
import type { TaskFulfillmentFailure } from "../completion/index.js";

export interface RuntimeFailure {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface DescendantRunFailure extends RuntimeFailure {
  readonly childRunId: string | null;
}

export interface RunContextFailure extends RuntimeFailure {
  readonly path: string;
}

export type RunFailureCause =
  | { readonly kind: "runtime"; readonly failure: RuntimeFailure }
  | { readonly kind: "model"; readonly failure: ModelFailure }
  | { readonly kind: "provider"; readonly failure: ProviderFailure }
  | { readonly kind: "operation"; readonly failure: OperationFailure }
  | { readonly kind: "interaction"; readonly failure: InteractionFailure }
  | { readonly kind: "approval"; readonly failure: ApprovalFailure }
  | { readonly kind: "permission"; readonly failure: PermissionFailure }
  | { readonly kind: "policy"; readonly failure: PolicyFailure }
  | { readonly kind: "action_execution"; readonly failure: ActionExecutionFailure }
  | { readonly kind: "sandbox"; readonly failure: SandboxExecutionFailure }
  | { readonly kind: "tool"; readonly failure: ToolFailure }
  | { readonly kind: "composite"; readonly failure: CompositeFailure }
  | { readonly kind: "descendant"; readonly failure: DescendantRunFailure }
  | { readonly kind: "context"; readonly failure: RunContextFailure }
  | { readonly kind: "audit"; readonly failure: AuditFailure }
  | { readonly kind: "telemetry"; readonly failure: TelemetryFailure }
  | { readonly kind: "task_fulfillment"; readonly failure: TaskFulfillmentFailure }
  | { readonly kind: "verification"; readonly failure: VerificationFailure };

export type RunFailureKind = RunFailureCause["kind"];
export type RunFailureForKind<TKind extends RunFailureKind> = Extract<
  RunFailureCause,
  { readonly kind: TKind }
>["failure"];

export function createRunFailureCause<TKind extends RunFailureKind>(
  kind: TKind,
  failure: RunFailureForKind<TKind>,
): Extract<RunFailureCause, { readonly kind: TKind }> {
  return Object.freeze({ kind, failure }) as unknown as Extract<RunFailureCause, { readonly kind: TKind }>;
}

export const runFailureCode = (cause: RunFailureCause): string => cause.failure.code;
export const runFailureMessage = (cause: RunFailureCause): string => cause.failure.message;
export const runFailureMetadata = (cause: RunFailureCause): Readonly<Record<string, unknown>> =>
  cause.kind === "verification"
    ? Object.freeze({
        stage: cause.failure.stage,
        retryable: cause.failure.retryable,
        cause: cause.failure.cause,
      })
    : cause.failure.metadata;
