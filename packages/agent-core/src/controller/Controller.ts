import type { IdentityRef, WorkspaceContext } from "@agent-anything/governance";
import type { Metadata } from "@agent-anything/shared";
import type { Agent } from "../agent/index.js";
import type { ContextProjection } from "../context/Context.js";
import type { ActionCandidate } from "../runner/Action.js";
import type { CancellationContext } from "../runner/RunCancellation.js";
import type { RunInputItem } from "../runner/RunInput.js";
import type { AgentTask } from "../task/index.js";
import type { RetryEventSink, RetryPolicy } from "../retry/index.js";

export interface ControllerModelItem {
  readonly id: string;
  readonly kind: string;
  readonly content: unknown;
  readonly metadata: Metadata;
}

export interface ControllerInput<TOutput = unknown> {
  readonly runId: string;
  readonly iteration: number;
  readonly agent: Agent<TOutput>;
  readonly task: AgentTask;
  readonly conversationItems: readonly RunInputItem[];
  readonly context: ContextProjection;
  readonly workspace: WorkspaceContext;
  readonly identity: IdentityRef;
  readonly metadata: Metadata;
}

export interface ControllerCallContext {
  readonly cancellation: CancellationContext;
  readonly retry: ControllerRetryContext;
}

export interface ControllerRetryContext {
  readonly providerRequest: RetryPolicy<string>;
  readonly structuredOutput: RetryPolicy<string>;
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
