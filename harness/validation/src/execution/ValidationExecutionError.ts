import type { ValidationFailure } from "../definition/index.js";

export class ValidationExecutionError extends Error {
  readonly failure: ValidationFailure;
  readonly currentRevision: number;

  constructor(failure: ValidationFailure, currentRevision: number) {
    super(failure.message);
    this.name = "ValidationExecutionError";
    this.failure = failure;
    this.currentRevision = currentRevision;
  }
}
