import type {
  Agent,
  AgentTask,
  IdentityRef,
  ISODateTimeString,
  Metadata,
  RunInputItem,
  RunWorkspace,
} from "@agent-anything/foundation";
import type { ContextProjection } from "../context/Context.js";
import type { ActionCandidate } from "@agent-anything/foundation/action";
import type { CancellationContext } from "../run/RunCancellation.js";
import type { RetryEventSink } from "../retry/RetryEvent.js";
import type { RetryPolicy } from "../retry/RetryPolicy.js";
import type { ToolCatalogSnapshot } from "@agent-anything/tools";

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
  readonly toolCatalog: ToolCatalogSnapshot;
  readonly context: ContextProjection;
  readonly workspace: RunWorkspace;
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
  readonly deadlineAt: ISODateTimeString;
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
