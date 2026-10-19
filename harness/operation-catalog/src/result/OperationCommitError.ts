/** Mandatory owner progress is unconfirmed; no public result is available yet. */
export class OperationCommitError extends Error {
  constructor(readonly owner: string, readonly recordId: string, options?: ErrorOptions) {
    super("Operation owner progress was not durably confirmed.", options);
    this.name = "OperationCommitError";
  }
}
