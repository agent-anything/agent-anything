/** Invocation-scoped owner records. The Controller validates its own serialized schema. */
export interface ControllerCheckpointPort {
  /** A detached value; editing it cannot change retained progress. */
  read(key: string): unknown | null;
  /** Runtime snapshots and owns the value before awaiting durable acceptance. */
  commit(key: string, value: unknown): Promise<void>;
}

export class ControllerCheckpointError extends Error {
  constructor(readonly key: string, options?: ErrorOptions) {
    super("Controller progress was not confirmed; execution must not advance.", options);
    this.name = "ControllerCheckpointError";
  }
}
