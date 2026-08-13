import type { ControllerTurnRef } from "../control/index.js";
import type { RunRef } from "../run/index.js";

export interface RunActionRef {
  readonly run: RunRef;
  readonly id: string;
  readonly sequence: number;
}

export interface TrustedWorkflowRef {
  readonly owner: string;
  readonly invocationId: string;
}

export interface OwnerOperationRef {
  readonly owner: string;
  readonly operationId: string;
}

export type RunActionProvenance =
  | {
      readonly kind: "controller";
      readonly turn: ControllerTurnRef;
      readonly candidateIndex: number;
    }
  | {
      readonly kind: "trusted_workflow";
      readonly workflow: TrustedWorkflowRef;
      readonly nodeRef: string;
    }
  | {
      readonly kind: "automatic";
      readonly trigger: OwnerOperationRef;
    };

export interface RunActionBasis {
  readonly runRevision: number;
  readonly activeAgentId: string;
  readonly controllerProjectionRevision: string | null;
}

export interface RunActionEnvelope<TSubjectRef> {
  readonly ref: RunActionRef;
  readonly provenance: RunActionProvenance;
  readonly subject: TSubjectRef;
  readonly basis: RunActionBasis;
  readonly materializedAt: string;
}

export interface ObservationRef {
  readonly run: RunRef;
  readonly id: string;
  readonly runAction: RunActionRef;
}

export interface ObservationEnvelope<TPayload> {
  readonly ref: ObservationRef;
  readonly owner: string;
  readonly kind: string;
  readonly createdAt: string;
  readonly payload: TPayload;
  readonly metadata: Readonly<Record<string, unknown>>;
}
