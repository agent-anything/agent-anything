import type { RunInput } from "@agent-anything/agent-core/input";
import type { ControllerTurnRef } from "@agent-anything/agent-core/control";
import type { AgentRevisionRef, AgentInstructions } from "@agent-anything/agent-core/agent";
import type { ToolCall } from "@agent-anything/tools/invocation";
import type { ResolvedOperationBinding } from "@agent-anything/operation-catalog/binding";
import type { RuntimeRunAction, RunSteeringCommand } from "../run/index.js";
import type { ModelMessage, ModelToolCall, ModelToolResult } from "@agent-anything/model-interaction";
import type { AgentInstructionBinding } from "../instructions/index.js";
import type { RunState } from "../run/index.js";
import type { RetainedRunConfig } from "./RunConfigurationCheckpoint.js";
import type { RunInputNotificationCheckpoint } from "./RunInputNotifications.js";
import type { DelegationRequest, DelegationResult, DescendantContinuationTargetProjection } from "../delegation/index.js";
import type { DescendantContinuationCorrelation } from "@agent-anything/agent-core/delegation";

export interface RetainedDescendantContinuation {
  readonly correlation: DescendantContinuationCorrelation;
  readonly projection: DescendantContinuationTargetProjection;
  readonly sourceRequest: DelegationRequest;
  readonly sourceResult: DelegationResult;
  readonly modelInteractionSeed: readonly ModelMessage[];
  readonly status: "available" | "starting" | "consumed";
}

export interface RetainedDescendantTransfer {
  readonly childRunId: string;
  readonly relationId: string;
  readonly action: RuntimeRunAction;
  readonly result: DelegationResult | null;
  readonly status: "settled" | "failed";
  readonly code: "delegation_result_invalid" | null;
}

/** Data needed to continue the accepted decision; never executable callbacks. */
export interface RunControlCheckpoint {
  readonly initialized: boolean;
  readonly finalization: import("./RunFinalizationCheckpoint.js").RunFinalizationCheckpoint | null;
  readonly lifecycleRecordings: readonly import("./RunFinalizationCheckpoint.js").RunLifecycleRecordingCheckpoint[];
  readonly controllerCheckpoints: readonly (readonly [string, unknown])[];
  readonly identitySequences: readonly (readonly [string, number])[];
  readonly nextInteractionRequest: number;
  readonly activeAgent: AgentRevisionRef;
  readonly instructionBinding: AgentInstructionBinding;
  readonly instructionRevisions: readonly (readonly [string, string])[];
  readonly instructions: AgentInstructions;
  readonly agentDefinition: Omit<import("@agent-anything/agent-core/agent").Agent, "output">;
  readonly contextPayloadBytes: number;
  readonly operationCalls: readonly (readonly [string, ToolCall])[];
  readonly resultDeliveries: readonly {
    readonly presenter: {readonly id: string; readonly revision: string};
    readonly input: Parameters<NonNullable<import("./ToolResultPresenter.js").ToolResultPresenter["committed"]>>[0];
  }[];
  readonly operations: readonly {readonly action: RuntimeRunAction; readonly binding: ResolvedOperationBinding; readonly startedAt: string}[];
  readonly operationResults: readonly import("@agent-anything/operation-catalog/result").OperationResult[];
  readonly operationExecutions: readonly (readonly [string,
    {readonly kind: "internal"} | {readonly kind: "action" | "composite"; readonly id: string}])[];
  readonly executionFailureSettlements: readonly (readonly [string, "failure" | "success" | "unchanged" | null])[];
  readonly steering: {
    readonly epoch: number;
    readonly pending: readonly RunSteeringCommand[];
    readonly ledger: readonly {readonly fingerprint: string; readonly command: RunSteeringCommand}[];
  };
  readonly decisionBases: readonly (readonly [string, number])[];
  readonly deferredInteractionActions: readonly RuntimeRunAction[];
  readonly inputNotifications: RunInputNotificationCheckpoint;
  readonly decision: import("./RunDecisionCheckpoint.js").RunDecisionCheckpoint | null;
  readonly pendingCompletion: null | {
    readonly call: ModelToolCall;
    readonly turn: ControllerTurnRef;
    readonly stateResult: ModelToolResult | null;
  };
  readonly descendantTransfers: readonly RetainedDescendantTransfer[];
  readonly descendantContinuations: readonly RetainedDescendantContinuation[];
  readonly cancellation: import("../run/index.js").RunCancellationRequest | null;
  readonly controllerInvocation: null | {
    readonly turn: ControllerTurnRef;
    readonly basisRevision: number;
    readonly prepared: import("./RunDecisionCheckpoint.js").RetainedControllerOperation;
    readonly status: "pending" | "returned" | "failed" | "interrupted";
  };
  readonly retryEvents: readonly import("../retry/index.js").RetryEvent[];
  readonly completionNotification: import("./RunCompletionCheckpoint.js").RunCompletionNotificationCheckpoint | null;
  readonly interactions: import("./RunInteractionCoordinator.js").RunInteractionCheckpoint;
  readonly interactionActions: readonly {readonly requestId: string; readonly action: RuntimeRunAction; readonly toolCall: ToolCall | null}[];
  readonly deliveredInteractions: readonly string[];
}

export interface RunCommit {
  readonly id: string;
  readonly expectedRevision: number | null;
  readonly state: RunState<unknown>;
  readonly control: RunControlCheckpoint;
  readonly admission: null | {
    readonly input: RunInput;
    readonly config: RetainedRunConfig;
    readonly modelInteractionSeed: readonly ModelMessage[];
    readonly lineage: import("@agent-anything/agent-core/run-tree").RunLineage;
    readonly rootTask: import("@agent-anything/agent-core/task").AgentTask;
    readonly rootConfig: RetainedRunConfig;
    readonly delegationRequest: import("../delegation/index.js").DelegationRequest | null;
    readonly delegationContextMaterials: readonly import("../delegation/index.js").DelegationContextMaterial[];
  };
}

export interface RunCommitReceipt {
  readonly recordId: string;
  readonly revision: number;
}

/** One atomic state/control/delivery commit. A rejected acknowledgement never publishes. */
export interface RunCommitPort {
  /** Immutable owner snapshot; unchanged payloads may be shared across revisions. */
  commitRun(commit: RunCommit): Promise<RunCommitReceipt>;
  readRunCommit(id: string): Promise<RunCommit | null>;
}

export class RunCommitError extends Error {
  constructor(readonly commitId: string, options?: ErrorOptions) {
    super("Run commit was not confirmed; execution must not advance.", options);
    this.name = "RunCommitError";
  }
}
