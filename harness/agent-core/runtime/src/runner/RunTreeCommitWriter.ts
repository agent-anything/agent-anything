import { sameRunCommitValue as same } from "./RunCommitValue.js";
import {snapshotRunTreeCommit} from "./RunCommitSnapshot.js";
import type { RunCommit } from "./RunCommitPort.js";
import { RunCommitError } from "./RunCommitPort.js";
import {
  validateRunTreeCommit,
  validateRunTreeRecoveryRecords,
  type RetainedRunTreeMember,
  type RunTreeCommit,
  type RunTreeCommitPort,
  type RunTreeRecoveryRecords,
} from "./RunTreeCommitPort.js";
import { RunTreeExecution, type RunTreeCheckpoint } from "./RunTreeExecution.js";
import type { RunCancellationController } from "../run/index.js";

export interface RunTreeCommitDraft {
  readonly tree: RunTreeExecution;
  readonly members: readonly RetainedRunTreeMember[];
}

export interface PreparedRunTreeTransition<T> {
  readonly runs: readonly RunCommit[];
  readonly value: T;
}

/** Serializes short owner transitions, never Provider, process or user waits. */
export class RunTreeCommitWriter {
  private retained: RunTreeRecoveryRecords | null = null;
  private tail: Promise<unknown> = Promise.resolve();
  private failure: RunCommitError | null = null;
  private attempted: RunTreeCommit | null = null;
  private readonly listeners = new Set<(records: RunTreeRecoveryRecords) => void>();
  private currentTree: RunTreeExecution;
  private readonly cancellations = new Map<string, RunCancellationController>();

  constructor(
    private readonly initial: RunTreeCheckpoint,
    private readonly port: RunTreeCommitPort | null,
    private readonly now: () => string,
  ) {
    this.initial = freeze(structuredClone(initial));
    this.currentTree = RunTreeExecution.restore(this.initial, now);
  }

  static async recover(
    rootRunId: string,
    port: RunTreeCommitPort,
    now: () => string,
  ): Promise<RunTreeCommitWriter | null> {
    const records = await port.readRunTree(rootRunId);
    if (records === null) return null;
    if (records.commit.checkpoint.input.rootRunId !== rootRunId) {
      throw new TypeError("Recovery basis belongs to another Run Tree.");
    }
    const writer = new RunTreeCommitWriter(records.commit.checkpoint, port, now);
    // The port reads and validates the retained commit chain atomically. This
    // validation independently checks the returned heads without creating work.
    validateRunTreeRecoveryRecords(records);
    writer.retained = freeze(structuredClone(records));
    writer.currentTree = RunTreeExecution.restore(records.commit.checkpoint, now);
    return writer;
  }

  /** The last acknowledged aggregate. Mutations belong to transaction drafts. */
  get tree(): RunTreeExecution { return this.currentTree; }

  registerCancellation(runId: string, controller: RunCancellationController): void {
    if (this.cancellations.has(runId)) throw new TypeError("Cancellation control is already registered.");
    this.cancellations.set(runId, controller);
    const propagate = () => {
      // Abort active work immediately; acceptance into the execution history is
      // performed by each Run's cancelling transition, not by an observer.
      for (const [id, child] of this.cancellations) {
        let node = this.tree.getSnapshot().nodes.find(value => value.runId === id);
        while (node?.parentRunId !== null && node?.parentRunId !== undefined) {
          if (node.parentRunId === runId) {
            child.requestCancellation({origin: "parent_run", reasonCode: "parent_run_cancelled", parentRunId: runId});
            break;
          }
          node = this.tree.getSnapshot().nodes.find(value => value.runId === node?.parentRunId);
        }
      }
    };
    controller.context.signal.addEventListener("abort", propagate, {once: true});
    this.cancellationListeners.set(runId, () => controller.context.signal.removeEventListener("abort", propagate));
    let ancestor = this.tree.getSnapshot().nodes.find(value => value.runId === runId)?.parentRunId;
    while (ancestor) {
      if (this.cancellations.get(ancestor)?.context.signal.aborted) {
        controller.requestCancellation({origin: "parent_run", reasonCode: "parent_run_cancelled", parentRunId: ancestor});
        break;
      }
      ancestor = this.tree.getSnapshot().nodes.find(value => value.runId === ancestor)?.parentRunId;
    }
    if (controller.context.signal.aborted) propagate();
  }

  private readonly cancellationListeners = new Map<string, () => void>();

  unregisterCancellation(runId: string): void {
    this.cancellationListeners.get(runId)?.();
    this.cancellationListeners.delete(runId);
    this.cancellations.delete(runId);
  }

  getSnapshot(): RunTreeRecoveryRecords | null {
    return this.retained;
  }

  getUnconfirmedCommit(): RunTreeCommit | null {
    return this.attempted;
  }

  subscribe(listener: (records: RunTreeRecoveryRecords) => void): () => void {
    this.listeners.add(listener);
    if (this.retained !== null) notify(listener, this.retained);
    return () => { this.listeners.delete(listener); };
  }

  transaction<T>(
    prepare: (draft: RunTreeCommitDraft) => PreparedRunTreeTransition<T>,
    accepted?: () => void,
  ): Promise<T> {
    const result = this.tail.then(async () => {
      if (this.failure !== null) throw this.failure;
      const before = this.retained;
      const tree = RunTreeExecution.restore(before?.commit.checkpoint ?? this.initial, this.now);
      const prepared = prepare({tree, members: before?.members ?? Object.freeze([])});
      if (prepared === null || typeof prepared !== "object" || "then" in prepared) {
        throw new TypeError("Run Tree transition preparation must be synchronous.");
      }
      const revision = before === null ? 0 : before.commit.revision + 1;
      const checkpoint = tree.checkpoint();
      const commit = snapshotRunTreeCommit({
        id: `${checkpoint.input.rootRunId}:tree_commit:${revision}`,
        expectedRevision: before?.commit.revision ?? null,
        revision, checkpoint, runs: prepared.runs,
      } satisfies RunTreeCommit);
      const members = new Map((before?.members ?? []).map(member => [member.head.state.run.id, member]));
      for (const run of commit.runs) {
        const previous = members.get(run.state.run.id);
        validateRunTransition(run, previous?.head ?? null);
        const admission = previous?.admission ?? run.admission;
        if (admission === null) throw new TypeError("Run admission is missing.");
        members.set(run.state.run.id, {admission, head: run});
      }
      const records = freeze({commit, members: [...members.values()]});
      validateRunTreeCommit(commit, before?.commit ?? null, records.members);
      this.attempted = commit;
      try {
        const receipt = this.port === null
          ? {recordId: commit.id, revision: commit.revision,
              runs: commit.runs.map(run => ({recordId: run.id, revision: run.state.revision}))}
          : await this.port.commitRunTree(commit);
        if (receipt.recordId !== commit.id || receipt.revision !== commit.revision ||
            !same(receipt.runs, commit.runs.map(run => ({recordId: run.id, revision: run.state.revision})))) {
          throw new TypeError("Run Tree commit receipt mismatch.");
        }
      } catch (cause) {
        this.failure = new RunCommitError(commit.id, {cause});
        throw this.failure;
      }
      this.retained = records;
      this.currentTree = tree;
      this.attempted = null;
      try { accepted?.(); }
      catch (cause) {
        this.failure = new RunCommitError(commit.id, {cause});
        throw this.failure;
      }
      for (const listener of [...this.listeners]) notify(listener, records);
      return prepared.value;
    });
    // Local rejection has no storage outcome to reconcile. A persistence error
    // explicitly poisons this owner and is rethrown before the next preparation.
    this.tail = result.catch(() => {});
    return result;
  }
}

function validateRunTransition(next: RunCommit, previous: RunCommit | null): void {
  const {state, control} = next;
  if (next.id !== `${state.run.id}:commit:${state.revision}` ||
      !Number.isSafeInteger(state.revision) || state.revision < 0 ||
      state.revision !== (previous === null ? 0 : previous.state.revision + 1) ||
      next.expectedRevision !== (previous?.state.revision ?? null) ||
      (previous === null ? next.admission === null : next.admission !== null)) {
    throw new TypeError("Run transition has invalid admission or revision.");
  }
  if (!same(control.activeAgent, state.activeAgent) ||
      !same(control.instructionBinding.ref, state.activeInstructionBinding) ||
      !same(control.instructionBinding.agent, state.activeAgent) ||
      !same(control.instructionBinding.instructions, control.instructions.ref)) {
    throw new TypeError("Run transition has inconsistent Agent/Instruction binding.");
  }
  if (previous !== null) {
    const before = previous.state;
    if (["completed", "failed", "cancelled"].includes(before.status) ||
        state.taskId !== before.taskId || state.startedAt !== before.startedAt || state.deadlineAt !== before.deadlineAt ||
        state.items.length < before.items.length || !same(state.items.slice(0, before.items.length), before.items)) {
      throw new TypeError("Run transition changed retained execution facts.");
    }
  }
}

function freeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freeze(child);
  return Object.freeze(value);
}

function notify(listener: (records: RunTreeRecoveryRecords) => void, records: RunTreeRecoveryRecords): void {
  try { listener(records); } catch { /* Observation cannot undo an accepted commit. */ }
}
