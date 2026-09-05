import type { AgentRevisionRef } from "@agent-anything/agent-core/agent";
import type { ControllerTurnRef } from "@agent-anything/agent-core/control";
import type {
  RunActionEnvelope,
  RunActionProvenance,
} from "@agent-anything/agent-core/run-action";
import type { RunItemEnvelope } from "@agent-anything/agent-core/run-item";
import type { InteractionRequestRef } from "@agent-anything/interaction/protocol";
import type { PlanProjection } from "../plan/index.js";
import type { ControllerModelItem } from "../controller/Controller.js";
import type { PendingRunSubject } from "./PendingRunSubject.js";
import type { RunCancellationSummary } from "./RunCancellation.js";
import type { RunSteeringApplication } from "./RunSteering.js";
import type { RunFailureCause } from "./RunFailure.js";
import type { RunObservation } from "./RunObservation.js";
import type { RunResultStatus } from "./RunStatus.js";
import type {
  RunCauseSourceRef,
  RunSettlement,
  RunSettlementCauseRecord,
} from "./RunSettlement.js";
import type { RunResumeRequest, RunSuspension } from "./RunSuspension.js";
import type { VerificationRunnerProjection } from "@agent-anything/verification/projection";
import type { ToolRevisionRef } from "@agent-anything/tools/identity";
import type { ToolBindingUnavailableReason } from "@agent-anything/tools/selection";
import type { AgentInstructionBindingRef } from "../instructions/index.js";
import type { ModelCallRef, ModelToolResult } from "@agent-anything/model-interaction";
import type { ControllerFeedback } from "../controller/index.js";

export interface ControllerToolExposureRecord {
  readonly proofId: string;
  readonly controllerRequestId: string;
  readonly manifestId: string;
  readonly selectionRevision: string;
  readonly contentRevision: string;
  readonly basisRevision: string;
  readonly catalogRevision: string;
  readonly exposedTools: readonly ToolRevisionRef[];
  readonly exposedToolCount: number;
  readonly omittedToolCount: number;
  readonly omissionReasons: readonly ToolBindingUnavailableReason[];
}

export type RuntimeRunActionSubject =
  | { readonly kind: "state_transition"; readonly transition: "plan_update" | "handoff" }
  | { readonly kind: "operation"; readonly invocationId: string | null; readonly requestOrigin: "automatic_stage" | "controller_protocol" | "tool_request" | "composite" | "descendant" }
  | { readonly kind: "tool"; readonly toolCallId: string }
  | { readonly kind: "model_call_rejection"; readonly modelCallRef: ModelCallRef }
  | { readonly kind: "interaction"; readonly request: InteractionRequestRef | null };

export type RuntimeRunActionProvenance =
  | (Extract<RunActionProvenance, { readonly kind: "controller" }> & {
      readonly modelCallRef: ModelCallRef;
    })
  | Exclude<RunActionProvenance, { readonly kind: "controller" }>;

export type RuntimeRunAction = Omit<
  RunActionEnvelope<RuntimeRunActionSubject>,
  "provenance"
> & { readonly provenance: RuntimeRunActionProvenance };

export type RunItemPayload<TOutput = unknown> =
  | {
      readonly kind: "controller_turn";
      readonly turn: ControllerTurnRef;
      readonly status: "decided" | "failed" | "interrupted";
      readonly decisionKind: "advance" | "continue_with_feedback" | "propose_completion" | "propose_stop" | null;
      readonly instructionBinding: AgentInstructionBindingRef;
      readonly toolExposure: ControllerToolExposureRecord;
      readonly modelItems: readonly ControllerModelItem[];
      readonly failure: RunFailureCause | null;
    }
  | { readonly kind: "run_action"; readonly action: RuntimeRunAction }
  | { readonly kind: "model_call_settlement"; readonly result: ModelToolResult }
  | { readonly kind: "observation"; readonly observation: RunObservation }
  | {
      readonly kind: "state_transition";
      readonly transition: "plan";
      readonly previousRevision: number | null;
      readonly plan: PlanProjection;
    }
  | {
      readonly kind: "state_transition";
      readonly transition: "active_agent";
      readonly previousAgent: AgentRevisionRef;
      readonly activeAgent: AgentRevisionRef;
      readonly previousInstructionBinding: AgentInstructionBindingRef;
      readonly activeInstructionBinding: AgentInstructionBindingRef;
      readonly reason: string;
    }
  | {
      readonly kind: "state_transition";
      readonly transition: "steering";
      readonly steering: RunSteeringApplication;
    }
  | {
      readonly kind: "pending_transition";
      readonly transition: "opened" | "resolved" | "expired" | "cancelled" | "invalidated" | "failed";
      readonly pending: PendingRunSubject;
      readonly recordRef: string | null;
    }
  | { readonly kind: "cancellation_transition"; readonly transition: "requested" | "settled"; readonly cancellation: RunCancellationSummary }
  | {
      readonly kind: "verification_feedback";
      readonly verification: VerificationRunnerProjection;
    }
  | { readonly kind: "controller_feedback"; readonly feedback: ControllerFeedback }
  | {
      readonly kind: "completion_acceptance";
      readonly source: RunCauseSourceRef;
      readonly candidateId: string;
      readonly candidateRevision: string;
      readonly acceptedAt: string;
    }
  | {
      readonly kind: "suspension_transition";
      readonly transition: "suspended";
      readonly suspension: RunSuspension;
      readonly resume: null;
    }
  | {
      readonly kind: "suspension_transition";
      readonly transition: "resumed";
      readonly suspension: RunSuspension;
      readonly resume: RunResumeRequest;
    }
  | {
      readonly kind: "settlement_cause";
      readonly cause: RunSettlementCauseRecord;
    }
  | {
      readonly kind: "terminal_transition";
      readonly status: RunResultStatus;
      readonly settlement: RunSettlement<TOutput>;
      readonly cause: RunSettlementCauseRecord;
    };

export type RunItem<TOutput = unknown> = RunItemEnvelope<RunItemPayload<TOutput>>;
