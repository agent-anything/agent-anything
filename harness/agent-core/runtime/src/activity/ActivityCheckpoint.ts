/** Invocation-scoped records. Each activity owner validates its serialized schema. */
export interface ActivityCheckpointPort {
  /** A detached value; editing it cannot change retained progress. */
  read(key: string): unknown | null;
  /** Runtime snapshots and owns the value before awaiting durable acceptance. */
  commit(key: string, value: unknown): Promise<void>;
  /** The response checkpoint and known physical-attempt charge share one durable commit. */
  commitWithAuxiliaryUsage?(key: string, value: unknown, usage: import("../model-access/AuxiliaryModelUsage.js").AuxiliaryModelUsage): Promise<void>;
  /** Check expectations and the live invocation basis in the same Run transaction. */
  compareAndCommit?(expected: readonly {readonly key: string; readonly value: unknown | null}[],
    writes: readonly {readonly key: string; readonly value: unknown}[]): Promise<void>;
}

export class ActivityCheckpointError extends Error {
  constructor(readonly key: string, options?: ErrorOptions) {
    super("Activity progress was not confirmed; execution must not advance.", options);
    this.name = "ActivityCheckpointError";
  }
}
