import type { Agent, AgentRevisionRef } from "@agent-anything/agent-core/agent";
import type { AgentTask } from "@agent-anything/agent-core/task";
import type { IdentityRef } from "@agent-anything/agent-core/run";
import type { WorkspaceSelection } from "@agent-anything/workspace/selection";
import type { RunInputItem } from "@agent-anything/agent-core/input";
import type { ContextProjection } from "@agent-anything/context/projection";
import type { ProjectionManifest } from "@agent-anything/context/projection";
import type { PlanProjection } from "../plan/index.js";
import type { CancellationContext } from "../run/RunCancellation.js";
import type { PermissionContextProjection } from "../run/RunPermissionState.js";
import type { RetryEventSink } from "../retry/RetryEvent.js";
import type { RetryPolicy } from "../retry/RetryPolicy.js";
import type { ToolCallCandidate } from "@agent-anything/tools/invocation";
import type { ToolExposureProof } from "@agent-anything/tools/selection";
import type { OperationRevisionRef } from "@agent-anything/operation-catalog/identity";
import type {
  InteractionProtocolRef,
  InteractionSubjectRef,
} from "@agent-anything/interaction/protocol";
import type { PendingRunSubjectProjection } from "../run/PendingRunSubject.js";
import type { AgentInstructionBinding } from "../instructions/index.js";
import type {
  ModelCallRef,
  ModelMessage,
  ModelToolCall,
  ModelTurnFinish,
  ProviderResponseRef,
  ProviderUsage,
} from "@agent-anything/model-interaction";
import type { PlanLimits } from "../plan/index.js";

interface ControllerModelItemBase {
  readonly id: string;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export type ControllerModelItem =
  | ControllerModelItemBase & {
      readonly kind: "assistant_text";
      readonly turnId: string;
      readonly contentBlockOrdinal: number;
      readonly text: string;
    }
  | ControllerModelItemBase & {
      readonly kind: "model_tool_call";
      readonly call: ModelToolCall;
    }
  | ControllerModelItemBase & {
      readonly kind: "model_turn_finish";
      readonly turnId: string;
      readonly finish: ModelTurnFinish;
    }
  | ControllerModelItemBase & {
      readonly kind: "model_response_correlation";
      readonly turnId: string;
      readonly response: ProviderResponseRef;
      readonly usage: ProviderUsage | null;
    };

export interface ModelInteractionProjection {
  readonly id: string;
  readonly revision: string;
  readonly messages: readonly ModelMessage[];
  readonly unsettledCalls: readonly ModelToolCall[];
  readonly settledCallCount: number;
}

interface ModelOriginCandidate {
  readonly modelCallRef: ModelCallRef;
}

export type StateTransitionCandidate =
  | ModelOriginCandidate & {
      readonly kind: "state_transition";
      readonly transition: "plan_update";
      readonly input: unknown;
    }
  | ModelOriginCandidate & {
      readonly kind: "state_transition";
      readonly transition: "handoff";
      readonly input: SameRunHandoffRequest;
    };

export interface SameRunHandoffRequest {
  readonly expectedRunRevision: number;
  readonly currentAgent: AgentRevisionRef;
  readonly targetAgent: AgentRevisionRef;
  readonly reason: string;
  readonly transferPolicy: "all_context" | "bounded_context" | "fresh_context";
  readonly admissionEvidenceRef: string;
}

export type OperationRequestCandidate = ModelOriginCandidate & {
  readonly kind: "operation_request";
  readonly origin: "controller_protocol";
  readonly operation: OperationRevisionRef;
  readonly request: unknown;
};

export interface ToolRequestCandidate extends ModelOriginCandidate {
  readonly kind: "tool_request";
  readonly tool: ToolCallCandidate;
}

export interface InteractionRequestCandidate extends ModelOriginCandidate {
  readonly kind: "interaction_request";
  readonly protocol: InteractionProtocolRef;
  readonly subject: unknown;
  readonly subjectRef: InteractionSubjectRef;
  readonly presentation: unknown;
  readonly requestVersion: number;
  readonly expiresAt: string | null;
  readonly blockingScope: "none" | "branch" | "run";
}

export interface ModelCallRejectionCandidate extends ModelOriginCandidate {
  readonly kind: "model_call_rejection";
  readonly name: string;
  readonly code: string;
  readonly message: string;
}

export type ProgressionCandidate =
  | StateTransitionCandidate
  | OperationRequestCandidate
  | ToolRequestCandidate
  | InteractionRequestCandidate
  | ModelCallRejectionCandidate;

export interface ControllerInput<TOutput = unknown> {
  readonly runId: string;
  readonly iteration: number;
  readonly agent: Agent<TOutput>;
  readonly instructionBinding: AgentInstructionBinding;
  readonly task: AgentTask;
  readonly inputItems: readonly RunInputItem[];
  readonly toolExposure: ToolExposureProof;
  readonly context: ContextProjection;
  readonly contextManifest: Pick<
    ProjectionManifest,
    "id" | "projectionId" | "requestId" | "activeContext" | "profile" |
      "policy" | "estimator" | "budget" | "accounting"
  >;
  readonly interaction: ModelInteractionProjection;
  readonly plan: PlanProjection | null;
  readonly planLimits: PlanLimits;
  readonly progress: ControllerRunProgressProjection;
  readonly verification: ControllerVerificationProjection;
  readonly permission: PermissionContextProjection;
  readonly pending: readonly PendingRunSubjectProjection[];
  readonly workspace: WorkspaceSelection | null;
  readonly identity: IdentityRef;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface ControllerRunProgressProjection {
  readonly checkpointSequence: number;
  readonly consecutiveNonAdvancingCheckpoints: number;
  readonly correctionRounds: number;
  readonly activeCorrectionRound: number | null;
}

export interface ControllerVerificationProjection {
  readonly snapshot: Readonly<{ readonly runId: string; readonly revision: number }>;
  readonly gate: Readonly<{
    readonly id: string;
    readonly revision: string;
  }> | null;
}

export type ControllerPreProjectionInput<TOutput = unknown> = Omit<
  ControllerInput<TOutput>,
  "context" | "contextManifest"
>;

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
      readonly kind: "propose_completion";
      readonly output: TOutput;
      readonly modelItems: readonly ControllerModelItem[];
    }
  | {
      readonly kind: "advance";
      readonly candidates: readonly [ProgressionCandidate, ...ProgressionCandidate[]];
      readonly modelItems: readonly ControllerModelItem[];
    }
  | {
      readonly kind: "propose_stop";
      readonly reason: string;
      readonly modelItems: readonly ControllerModelItem[];
    };

export interface Controller<TOutput = unknown> {
  next(
    input: ControllerInput<TOutput>,
    context: ControllerCallContext,
  ): Promise<ControllerDecision<TOutput>>;
}
