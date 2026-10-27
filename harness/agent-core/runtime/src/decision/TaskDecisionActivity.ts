import type { AgentDefinition, AgentDefinitionRevisionRef } from "@agent-anything/agent-core/agent";
import type { AgentTask } from "@agent-anything/agent-core/task";
import type { TaskDecisionActivityRef } from "@agent-anything/agent-core/control";
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
import type { OperationDefinitionRevisionRef } from "@agent-anything/operation-catalog/identity";
import type {
  InteractionProtocolRef,
  InteractionSubjectRef,
} from "@agent-anything/interaction/protocol";
import type { PendingRunSubjectProjection } from "../run/PendingRunSubject.js";
import type { AgentInstructionBinding } from "../instructions/index.js";
import type {
  ModelCallRef,
  ModelMessage,
  ModelCallableRequest,
  ModelToolResult,
  ModelTurnFinish,
  ProviderResponseRef,
  ProviderUsage,
} from "@agent-anything/model-interaction";
import type { PlanLimits } from "../plan/index.js";
import type { DescendantTargetsProjection } from "../delegation/index.js";

interface ControllerModelItemBase {
  readonly id: string;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export type TaskDecisionModelItem =
  | ControllerModelItemBase & {
      readonly kind: "assistant_reasoning";
      readonly turnId: string;
      readonly reasoning: import("@agent-anything/model-interaction").ModelReasoning;
    }
  | ControllerModelItemBase & {
      readonly kind: "assistant_text";
      readonly turnId: string;
      readonly contentBlockOrdinal: number;
      readonly text: string;
    }
  | ControllerModelItemBase & {
      readonly kind: "model_tool_call";
      readonly call: ModelCallableRequest;
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
  readonly workingForms?: readonly import("@agent-anything/model-interaction/input").ModelInputOwnerForm[];
  readonly workingAccounts?: readonly import("@agent-anything/model-interaction/input").ModelInputAccount[];
  readonly inputUsageObservations?: readonly import("@agent-anything/model-interaction/context").ModelInputUsageObservation[];
  readonly workingView: import("@agent-anything/model-interaction/input").ModelWorkingView;
  readonly id: string;
  readonly revision: string;
  readonly messages: readonly ModelMessage[];
  readonly unsettledCalls: readonly ModelCallableRequest[];
  readonly settledCallCount: number;
  readonly latestTurn: LocalModelTurnProjection | null;
  readonly opening?: import("./TaskConversation.js").ConversationOpeningReceipt | null;
  readonly seed?: import("./TaskConversation.js").ModelConversationSeed | null;
  readonly historyPresentations?: readonly import("./DecisionInputDelivery.js").RetainedInputPresentation[];
  readonly notificationHistory?: readonly {readonly messageIndex: number; readonly batchId: string;
    readonly batchRevision: string; readonly sequence: number;
    readonly presentation?: import("./DecisionInputDelivery.js").RetainedInputPresentation}[];
}

export interface LocalModelTurnProjection {
  readonly runId: string;
  readonly runItemId: string;
  readonly runItemSequence: number;
  readonly turnId: string;
  readonly textBlocks: readonly {
    readonly modelItemId: string;
    readonly ordinal: number;
    readonly text: string;
  }[];
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

export type PlanUpdateCandidate = Extract<
  StateTransitionCandidate,
  { readonly transition: "plan_update" }
>;

export interface SameRunHandoffRequest {
  readonly expectedRunRevision: number;
  readonly currentAgent: AgentDefinitionRevisionRef;
  readonly targetAgent: AgentDefinitionRevisionRef;
  readonly reason: string;
  readonly transferPolicy: "all_context" | "bounded_context" | "fresh_context";
  readonly admissionEvidenceRef: string;
}

export type OperationRequestCandidate = {
  /** Null for a direct task decision; its activity and candidate index are the execution source. */
  readonly modelCallRef: ModelCallRef | null;
  readonly kind: "operation_request";
  readonly origin: "controller_protocol";
  readonly operation: OperationDefinitionRevisionRef;
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

export interface TaskDecisionInputSources<TOutput = unknown> {
  readonly inputDelivery?: import("./DecisionInputDelivery.js").ControllerInputDeliveryBatch | null;
  readonly runId: string;
  readonly iteration: number;
  readonly agent: AgentDefinition<TOutput>;
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
  readonly permission: PermissionContextProjection;
  readonly pending: readonly PendingRunSubjectProjection[];
  readonly descendants: DescendantTargetsProjection;
  readonly workspace: WorkspaceSelection | null;
  readonly identity: IdentityRef;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export type TaskDecisionSourceBasis<TOutput = unknown> = Omit<
  TaskDecisionInputSources<TOutput>,
  "context" | "contextManifest"
>;

export interface AgentActivityExecutionContext {
  readonly acceptInputRepreparation?: (input: {
    readonly requestId: string; readonly purpose: string; readonly sequence: number; readonly maximum: number;
    readonly location: "local_admission" | "provider";
  }) => Promise<import("../model-access/ModelInputContinuation.js").AcceptedActivityContinuationRef>;
  readonly auxiliaryWork?: import("../context-representation/RunPreparationWork.js").RunPreparationWorkPort;
  readonly auxiliaryInvocationId?: string;
  readonly auxiliaryUsage?: {
    assertAvailable(): void;
    record(value: import("../model-access/AuxiliaryModelUsage.js").AuxiliaryModelUsage): Promise<void>;
  };
  readonly checkpoints?: import("../activity/ActivityCheckpoint.js").ActivityCheckpointPort;
  readonly runCheckpoints?: import("../activity/ActivityCheckpoint.js").ActivityCheckpointPort;
  readonly executionFlow?: import("@agent-anything/observability/execution-flow").ExecutionFlowContext;
  readonly cancellation: CancellationContext;
  readonly retry: ModelActivityRetryContext;
}

export interface ModelActivityRetryContext {
  readonly waitControl?: import("../retry/RetryWaitControl.js").RetryWaitControl;
  readonly providerRequest: RetryPolicy<string>;
  readonly structuredOutput: RetryPolicy<string>;
  readonly deadlineAt: string;
  readonly events: RetryEventSink;
}

export interface TaskDecisionFeedback {
  readonly source: Readonly<{
    readonly owner: string;
    readonly kind: string;
    readonly id: string;
    readonly revision: string;
  }>;
  readonly code: string;
  readonly message: string;
}

export type TaskDecisionProposal<TOutput = unknown> = {
  /** Absence does not acknowledge pending input. Set only by the trusted Controller. */
  readonly inputDeliveryReceipt?: import("./DecisionInputDelivery.js").ControllerInputDeliveryReceipt | null;
  readonly openingReceipt?: import("./TaskConversation.js").ConversationOpeningReceipt | null;
} & (
  | {
      readonly kind: "propose_completion";
      readonly candidates: readonly ProgressionCandidate[];
      readonly completionSource: CompletionSource;
      readonly output: TOutput;
      readonly modelItems: readonly TaskDecisionModelItem[];
    }
  | {
      readonly kind: "advance";
      readonly candidates: readonly [ProgressionCandidate, ...ProgressionCandidate[]];
      readonly modelItems: readonly TaskDecisionModelItem[];
    }
  | {
      readonly kind: "continue_with_feedback";
      readonly feedback: TaskDecisionFeedback;
      readonly modelItems: readonly TaskDecisionModelItem[];
    });

export type CompletionSource =
  // The source call may also supply one Plan transition; it still settles once.
  | { readonly kind: "model_call"; readonly modelCallRef: ModelCallRef }
  | { readonly kind: "controller" };

export interface RunCompletionCandidate<TOutput = unknown> {
  readonly turn: TaskDecisionActivityRef;
  readonly stateRevision: number;
  readonly current: TaskDecisionInputSources<TOutput>;
  readonly output: TOutput;
  readonly completionSource: CompletionSource;
  readonly settlements: readonly ModelToolResult[];
}

export type RunCompletionDisposition =
  | { readonly kind: "allow" }
  | { readonly kind: "continue_with_feedback"; readonly feedback: TaskDecisionFeedback };

export interface TaskDecisionActivity<TOutput = unknown> {
  readonly resourceMetering: TaskDecisionResourceMetering;
  next(
    input: TaskDecisionInputSources<TOutput>,
    context: AgentActivityExecutionContext,
  ): Promise<TaskDecisionProposal<TOutput>>;
  recover?(
    input: TaskDecisionInputSources<TOutput>,
    context: AgentActivityExecutionContext,
  ): Promise<TaskDecisionProposal<TOutput>>;
}

export interface TaskDecisionResourceMetering {
  readonly modelInputTokens: import("@agent-anything/model-interaction").ProviderUsageMeteringQualification;
  readonly modelOutputTokens: import("@agent-anything/model-interaction").ProviderUsageMeteringQualification;
  readonly costUnits: import("@agent-anything/model-interaction").ProviderUsageMeteringQualification;
}
