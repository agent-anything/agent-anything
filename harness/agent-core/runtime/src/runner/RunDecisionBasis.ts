import type {RunCommitBookkeeping} from "./RunCommitBookkeeping.js";

/** Own Retry bookkeeping and validated Run auxiliary bookkeeping preserve business bases. */
export class RunDecisionBasis {
  private readonly active = new Map<string, number>();
  snapshot(nextRevision: number, bookkeepingInvocationId: RunCommitBookkeeping): readonly (readonly [string, number])[] {
    return [...this.active].map(([id, revision]) => [id, preserves(id, bookkeepingInvocationId) ? revision : nextRevision] as const);
  }

  capture(invocationId: string, revision: number): void {
    if (this.active.has(invocationId)) throw new TypeError("Decision basis is already captured.");
    this.active.set(invocationId, revision);
  }

  revision(invocationId: string, currentRevision: number): number {
    return this.active.get(invocationId) ?? currentRevision;
  }

  committed(revision: number, bookkeepingInvocationId: RunCommitBookkeeping): void {
    for (const id of this.active.keys()) {
      if (!preserves(id, bookkeepingInvocationId)) this.active.set(id, revision);
    }
  }

  release(invocationId: string): void { this.active.delete(invocationId); }
}

function preserves(id: string, bookkeeping: RunCommitBookkeeping): boolean {
  return id === bookkeeping || typeof bookkeeping === "object" && bookkeeping?.kind === "auxiliary";
}
