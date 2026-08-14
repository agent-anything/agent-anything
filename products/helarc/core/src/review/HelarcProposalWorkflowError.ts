
import type { PatchFailureCode } from "./HelarcProposalReview.js";

export class PatchWorkflowError extends Error {
  constructor(
    readonly code: PatchFailureCode,
    message: string,
    readonly metadata: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "PatchWorkflowError";
  }
}
