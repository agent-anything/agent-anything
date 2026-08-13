import type { InteractionRequestRef } from "../protocol/index.js";
import type {
  InteractionApplicationRef,
  InteractionResolutionRef,
  InteractionTransportReceipt,
} from "../records/index.js";

export interface InteractionSubmissionInput {
  readonly request: InteractionRequestRef;
  readonly submissionId: string;
  readonly contentDigest: string;
  readonly payload: unknown;
  readonly receivedAt: string;
}

export type InteractionSubmissionOutcome =
  | {
      readonly status: "accepted_for_resolution" | "duplicate_identical";
      readonly receipt: InteractionTransportReceipt;
    }
  | {
      readonly status: "rejected";
      readonly code:
        | "interaction_not_pending"
        | "interaction_version_stale"
        | "interaction_submission_conflict"
        | "interaction_submission_invalid"
        | "run_settled";
      readonly receipt: InteractionTransportReceipt | null;
    };

export interface InteractionAppliedOutcome {
  readonly request: InteractionRequestRef;
  readonly resolution: InteractionResolutionRef;
  readonly application: InteractionApplicationRef | null;
  readonly value: unknown;
}
