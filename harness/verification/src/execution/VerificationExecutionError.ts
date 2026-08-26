import type { VerificationFailure } from "../definition/index.js";

export class VerificationExecutionError extends Error {
  readonly failure: VerificationFailure;
  readonly currentRevision: number;

  constructor(failure: VerificationFailure, currentRevision: number) {
    super(failure.message);
    this.name = "VerificationExecutionError";
    this.failure = failure;
    this.currentRevision = currentRevision;
  }
}
