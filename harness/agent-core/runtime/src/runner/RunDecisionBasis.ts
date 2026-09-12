/** Only an invocation's own registered Retry bookkeeping preserves its decision basis. */
export class RunDecisionBasis {
  private readonly active = new Map<string, number>();

  capture(invocationId: string, revision: number): void {
    if (this.active.has(invocationId)) throw new TypeError("Decision basis is already captured.");
    this.active.set(invocationId, revision);
  }

  revision(invocationId: string, currentRevision: number): number {
    return this.active.get(invocationId) ?? currentRevision;
  }

  committed(revision: number, bookkeepingInvocationId: string | null): void {
    for (const id of this.active.keys()) {
      if (id !== bookkeepingInvocationId) this.active.set(id, revision);
    }
  }

  release(invocationId: string): void { this.active.delete(invocationId); }
}
