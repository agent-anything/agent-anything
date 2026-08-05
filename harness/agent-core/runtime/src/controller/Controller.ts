import type { Agent } from "@agent-anything/agent-core/agent";
import type { AgentTask } from "@agent-anything/agent-core/task";
import type { IdentityRef, RunWorkspace } from "@agent-anything/agent-core/run";
import type { RunInputItem } from "@agent-anything/agent-core/input";
import type { ContextProjection } from "@agent-anything/context/context";
import type { ActionCandidate } from "@agent-anything/agent-core/action";
import type { PlanProjection } from "../plan/index.js";
import type { CancellationContext } from "../run/RunCancellation.js";
import type { PermissionContextProjection } from "../run/RunPermissionState.js";
import type { RetryEventSink } from "../retry/RetryEvent.js";
import type { RetryPolicy } from "../retry/RetryPolicy.js";
import type { ToolCatalogSnapshot } from "@agent-anything/tools";

export interface ControllerModelItem {
  readonly id: string;
  readonly kind: string;
  readonly content: unknown;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface ControllerInput<TOutput = unknown> {
  readonly runId: string;
  readonly iteration: number;
  readonly agent: Agent<TOutput>;
  readonly task: AgentTask;
  readonly inputItems: readonly RunInputItem[];
  readonly toolCatalog: ToolCatalogSnapshot;
  readonly toolSelectionId: string;
  readonly context: ContextProjection;
  readonly plan: PlanProjection | null;
  readonly permission: PermissionContextProjection;
  readonly workspace: RunWorkspace | null;
  readonly identity: IdentityRef;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface ControllerCallContext {
  readonly cancellation: CancellationContext;
  readonly retry: ControllerRetryContext;
}

export interface ControllerRetryContext {
  readonly providerRequest: RetryPolicy<string>;
  readonly structuredOutput: RetryPolicy<string>;
  readonly deadlineAt: string;
  readonly events: RetryEventSink;
}

export type ControllerDecision<TOutput = unknown> =
  | {
      readonly kind: "final_output";
      readonly output: TOutput;
      readonly modelItems: readonly ControllerModelItem[];
    }
  | {
      readonly kind: "actions";
      readonly actions: readonly [ActionCandidate, ...ActionCandidate[]];
      readonly modelItems: readonly ControllerModelItem[];
    }
  | {
      readonly kind: "stop";
      readonly reason: string;
      readonly modelItems: readonly ControllerModelItem[];
    };

export interface Controller<TOutput = unknown> {
  next(
    input: ControllerInput<TOutput>,
    context: ControllerCallContext,
  ): Promise<ControllerDecision<TOutput>>;
}
