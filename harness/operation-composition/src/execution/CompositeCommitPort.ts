import type { CompositeDefinitionRevision } from "../definition/index.js";
import type { CompositeExecutionSnapshot } from "./CompositeExecution.js";

export interface CompositeCommit {
  readonly id: string;
  readonly expectedRevision: number | null;
  readonly runId: string;
  readonly definition: CompositeDefinitionRevision;
  readonly input: unknown;
  readonly startedAt: string;
  readonly state: CompositeExecutionSnapshot;
  readonly requests: readonly {readonly nodeId: string; readonly instance: number; readonly request: unknown}[];
}

export interface CompositeCommitPort {
  commitComposite(commit: CompositeCommit): Promise<{readonly recordId: string; readonly revision: number}>;
  readCompositeCommit(id: string): Promise<CompositeCommit | null>;
}

export class CompositeRecoveryError extends Error {
  constructor(readonly compositeId: string, readonly code: string) {
    super(`Composite recovery cannot proceed: ${code}.`);
    this.name = "CompositeRecoveryError";
  }
}

export class CompositeCommitError extends Error {
  constructor(readonly commitId: string, options?: ErrorOptions) {
    super("Composite commit was not confirmed; execution must not advance.", options);
    this.name = "CompositeCommitError";
  }
}
