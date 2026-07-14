import type { IdentityRef, WorkspaceContext } from "@agent-anything/governance";
import type { ArtifactRef, EvidenceRef, Metadata } from "@agent-anything/shared";
import type { ToolResult, ToolRisk } from "@agent-anything/tools";
import type { AgentTask } from "../task/index.js";
import type { Action } from "./Action.js";
import type { ActionDeniedOwner, ActionRejectedCode } from "./Observation.js";
import type {
  CancellationContext,
  CancellationLimits,
} from "./RunCancellation.js";
import type { RunInfrastructureRequirement } from "./RunConfig.js";
import type { RunFailureCode } from "./RunResult.js";
import type { RuntimeError } from "./RuntimeError.js";

export interface ToolActionBridgeInput {
  readonly action: Action & { readonly kind: "tool" };
  readonly task: AgentTask;
  readonly workspace: WorkspaceContext;
  readonly identity: IdentityRef;
  readonly cancellation: CancellationContext;
  readonly cancellationLimits: CancellationLimits;
  readonly audit: RunInfrastructureRequirement;
  readonly telemetry: RunInfrastructureRequirement;
  readonly toolRisk: ToolRisk;
  readonly metadata: Metadata;
}

export type ToolActionObservationPayload =
  | {
      readonly kind: "tool_result";
      readonly result: ToolResult;
      readonly metadata: Metadata;
    }
  | {
      readonly kind: "action_denied";
      readonly owner: ActionDeniedOwner;
      readonly code: string;
      readonly message: string;
      readonly metadata: Metadata;
    }
  | {
      readonly kind: "action_failure";
      readonly error: RuntimeError;
      readonly metadata: Metadata;
    }
  | {
      readonly kind: "action_rejected";
      readonly code: ActionRejectedCode;
      readonly message: string;
      readonly metadata: Metadata;
    };

interface ToolActionObservedResultBase {
  readonly status: "observed";
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly artifactRefs: readonly ArtifactRef[];
}

export type ToolActionObservedResult = ToolActionObservedResultBase & (
  | {
      readonly outcome: "succeeded";
      readonly observation: Extract<ToolActionObservationPayload, { readonly kind: "tool_result" }> | null;
    }
  | {
      readonly outcome: "denied";
      readonly observation: Extract<ToolActionObservationPayload, { readonly kind: "action_denied" }>;
    }
  | {
      readonly outcome: "failed";
      readonly observation:
        | Extract<ToolActionObservationPayload, { readonly kind: "action_failure" }>
        | Extract<ToolActionObservationPayload, { readonly kind: "action_rejected" }>;
    }
);

export interface ToolActionTerminalFailureResult {
  readonly status: "terminal_failure";
  readonly code: RunFailureCode;
  readonly errors: readonly [RuntimeError, ...RuntimeError[]];
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly artifactRefs: readonly ArtifactRef[];
}

export type ToolActionBridgeResult =
  | ToolActionObservedResult
  | ToolActionTerminalFailureResult;

export interface ToolActionBridge {
  execute(input: ToolActionBridgeInput): Promise<ToolActionBridgeResult>;
}
