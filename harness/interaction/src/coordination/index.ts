export type {
  InteractionProtocolRegistration,
  InteractionProtocolRegistrySnapshot,
  CapturedInteractionProtocol,
  PendingInteractionLifecycle,
  PendingInteractionRef,
} from "./InteractionCoordination.js";
export {
  createInteractionProtocolRegistrySnapshot,
  snapshotPendingInteractionRef,
} from "./InteractionCoordination.js";
export { InteractionContractError } from "../internal/validation.js";
export type { InteractionContractErrorCode } from "../internal/validation.js";
export * from "./InteractionExecution.js";
export type {
  InteractionAppliedOutcome,
  InteractionSubmissionInput,
  InteractionSubmissionOutcome,
} from "./InteractionSubmission.js";
