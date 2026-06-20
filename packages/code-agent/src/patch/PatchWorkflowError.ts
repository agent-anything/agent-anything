import type { Metadata } from "@agent-anything/shared";
import type { PatchFailureCode } from "./PatchContracts.js";

export class PatchWorkflowError extends Error {
  constructor(
    readonly code: PatchFailureCode,
    message: string,
    readonly metadata: Metadata = {},
  ) {
    super(message);
    this.name = "PatchWorkflowError";
  }
}
