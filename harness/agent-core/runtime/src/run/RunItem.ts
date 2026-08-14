import type { AgentRevisionRef } from "@agent-anything/agent-core/agent";
import type { ControllerTurnRef } from "@agent-anything/agent-core/control";
import type { RunActionEnvelope } from "@agent-anything/agent-core/run-action";
import type { RunItemEnvelope } from "@agent-anything/agent-core/run-item";
import type { InteractionRequestRef } from "@agent-anything/interaction/protocol";
import type { PlanProjection } from "../plan/index.js";
import type { ControllerModelItem } from "../controller/Controller.js";
import type { PendingRunSubject } from "./PendingRunSubject.js";
import type { RunCancellationSummary } from "./RunCancellation.js";
import type { RunSteeringApplication } from "./RunSteering.js";
import type { RunFailureCause } from "./RunFailure.js";
import type { RunObservation } from "./RunObservation.js";
import type { RunBlockedCode, RunFailureCode, RunResultStatus } from "./RunStatus.js";

export type RuntimeRunActionSubject =
  | { readonly kind: "state_transition"; readonly transition: "plan_update" | "handoff" }
  | { readonly kind: "operation"; readonly invocationId: string | null; readonly requestOrigin: "controller_protocol" | "tool_request" | "composite" | "descendant" }
  | { readonly kind: "interaction"; readonly request: InteractionRequestRef | null };

export type RuntimeRunAction = RunActionEnvelope<RuntimeRunActionSubject>;

export type RunItemPayload<TOutput = unknown> =
  | {
      readonly kind: "controller_turn";
      readonly turn: ControllerTurnRef;
      readonly status: "decided" | "failed" | "interrupted";
      readonly decisionKind: "advance" | "propose_completion" | "propose_stop" | null;
      readonly modelItems: readonly ControllerModelItem[];
      readonly failure: RunFailureCause | null;
    }
  | { readonly kind: "run_action"; readonly action: RuntimeRunAction }
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
      readonly kind: "terminal_transition";
      readonly status: RunResultStatus;
      readonly code: RunBlockedCode | RunFailureCode | "runtime_cancelled" | null;
      readonly output: TOutput | null;
      readonly failure: RunFailureCause | null;
    };

export type RunItem<TOutput = unknown> = RunItemEnvelope<RunItemPayload<TOutput>>;
