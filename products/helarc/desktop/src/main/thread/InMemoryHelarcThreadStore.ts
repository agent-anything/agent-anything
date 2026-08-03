import {
  applyHelarcRunProgressCommit,
  applyHelarcRunStartCommit,
  applyHelarcRunTerminalCommit,
  type HelarcCommitResult,
  type HelarcRunProgressCommit,
  type HelarcRunStartCommit,
  type HelarcRunTerminalCommit,
  type HelarcThreadAggregate,
  type HelarcThreadRecord,
} from "@agent-anything/helarc";
import {
  createHelarcThreadSummary,
  sortHelarcThreadRecords,
  type HelarcThreadSummary,
} from "./HelarcThreadSummary.js";
import type { HelarcThreadStore } from "./FileHelarcThreadStore.js";

export class InMemoryHelarcThreadStore implements HelarcThreadStore {
  private readonly aggregates = new Map<string, HelarcThreadAggregate>();
  private commitTail: Promise<void> = Promise.resolve();

  async listThreadSummaries(): Promise<HelarcThreadSummary[]> {
    await this.commitTail;
    return sortHelarcThreadRecords(
      [...this.aggregates.values()].map((aggregate) => aggregate.record),
    ).map(createHelarcThreadSummary);
  }

  async loadThread(threadId: string): Promise<HelarcThreadRecord | null> {
    await this.commitTail;
    return this.aggregates.get(threadId.trim())?.record ?? null;
  }

  commitRunStart(input: HelarcRunStartCommit): Promise<HelarcCommitResult> {
    return this.commit(input.threadId, (aggregate) =>
      applyHelarcRunStartCommit(aggregate, input)
    );
  }

  commitRunProgress(input: HelarcRunProgressCommit): Promise<HelarcCommitResult> {
    return this.commit(input.threadId, (aggregate) =>
      applyHelarcRunProgressCommit(aggregate, input)
    );
  }

  commitRunTerminal(input: HelarcRunTerminalCommit): Promise<HelarcCommitResult> {
    return this.commit(input.threadId, (aggregate) =>
      applyHelarcRunTerminalCommit(aggregate, input)
    );
  }

  private commit(
    threadId: string,
    transition: (aggregate: HelarcThreadAggregate | null) => Promise<HelarcCommitResult>,
  ): Promise<HelarcCommitResult> {
    const operation = this.commitTail.then(async () => {
      const result = await transition(this.aggregates.get(threadId) ?? null);
      if (result.status === "applied") {
        this.aggregates.set(threadId, result.aggregate);
      }
      return result;
    });
    this.commitTail = operation.then(() => undefined, () => undefined);
    return operation;
  }
}
