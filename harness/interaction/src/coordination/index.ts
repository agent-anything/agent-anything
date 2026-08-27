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
export { InteractionContractError } from "../contract/InteractionContractValidation.js";
export type { InteractionContractErrorCode } from "../contract/InteractionContractValidation.js";
export * from "./InteractionExecution.js";
export type {
  InteractionAppliedOutcome,
  InteractionSubmissionInput,
  InteractionSubmissionOutcome,
} from "./InteractionSubmission.js";
