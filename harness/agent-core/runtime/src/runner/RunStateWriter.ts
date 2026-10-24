import type { RunItemPayload, RunState } from "../run/index.js";
import type { CreateRunnerIdentity } from "./RunnerDependencies.js";
import type {RunCommitBookkeeping} from "./RunCommitBookkeeping.js";

export type RunStatePatch<TOutput> = { readonly [K in keyof RunState<TOutput>]?: RunState<TOutput>[K] };

export type RunStateTransition<TOutput> = (
  current: RunState<TOutput>,
) => RunStatePatch<TOutput>;

type PreparedCommit<TOutput, T> = { readonly value: T; readonly bookkeepingInvocationId?: RunCommitBookkeeping } & (
  | { readonly payloads: readonly RunItemPayload<TOutput>[]; readonly patch: RunStatePatch<TOutput> }
  | { readonly payloads?: never; readonly patch?: never }
);

/** Invocation-local sole writer for one RunState revision chain. */
export class RunStateWriter<TOutput> {
  private state: RunState<TOutput>;
  private tail: Promise<unknown> = Promise.resolve();
  private failure: unknown;
  private failed = false;

  constructor(
    initial: RunState<TOutput>,
    private readonly now: () => string,
    private readonly createId: CreateRunnerIdentity,
    private readonly onCommit: (state: RunState<TOutput>, previous: RunState<TOutput>, bookkeepingInvocationId: RunCommitBookkeeping) => void,
    private readonly persist?: (state: RunState<TOutput>, previous: RunState<TOutput>, accept: () => void, bookkeepingInvocationId: RunCommitBookkeeping) => Promise<void>,
  ) {
    this.state = deepFreeze(initial);
  }

  getSnapshot(): RunState<TOutput> {
    return this.state;
  }

  fail(error: unknown): void {
    if (this.failed) return;
    this.failed = true;
    this.failure = error;
  }

  commit(
    payload: RunItemPayload<TOutput>,
    transition: RunStateTransition<TOutput> = () => Object.freeze({}),
  ): Promise<RunState<TOutput>> {
    return this.commitItems(Object.freeze([payload]), transition);
  }

  commitItems(
    payloads: readonly RunItemPayload<TOutput>[],
    transition: RunStateTransition<TOutput> = () => Object.freeze({}),
  ): Promise<RunState<TOutput>> {
    if (payloads.length === 0) {
      throw new TypeError("RunStateWriter.commitItems requires at least one RunItem payload.");
    }
    return this.mutate(current => ({ payloads, patch: transition(current), value: undefined }))
      .then(result => result.state);
  }

  /** Prepare identities, counters and associated control facts within the same short commit. */
  transaction<T>(prepare: (current: RunState<TOutput>) => PreparedCommit<TOutput, T>): Promise<T> {
    return this.mutate(prepare).then(result => result.value);
  }

  private mutate<T>(
    prepare: (current: RunState<TOutput>) => PreparedCommit<TOutput, T>,
  ): Promise<{ state: RunState<TOutput>; value: T }> {
    return this.serialize(async () => {
      const current = this.state;
      const { payloads, patch, value, bookkeepingInvocationId = null } = prepare(current);
      if (patch === undefined) return { state: current, value };
      if (typeof bookkeepingInvocationId === "object" && bookkeepingInvocationId !== null &&
          (bookkeepingInvocationId.kind !== "auxiliary" || !bookkeepingInvocationId.invocationId || payloads.length || Object.keys(patch).length)) {
        throw new TypeError("Auxiliary bookkeeping cannot change business state.");
      }
      this.assertWritable();
      const revision = current.revision + 1;
      const items = payloads.map((payload, index) => {
        const sequence = current.items.length + index + 1;
        return deepFreeze({
          ref: {
            run: current.run,
            id: this.createId({ kind: "run_item", runId: current.run.id, sequence }),
            sequence,
          },
          committedInRevision: revision,
          createdAt: this.now(),
          payload,
        });
      });
      const next = deepFreeze({
        ...current,
        ...patch,
        revision,
        items: [...current.items, ...items],
      }) as RunState<TOutput>;
      let accepted = false;
      const accept = () => {
        if (accepted) throw new TypeError("A Run state transition cannot be accepted twice.");
        accepted = true;
        this.state = next;
        this.onCommit(next, current, bookkeepingInvocationId);
      };
      await this.persist?.(next, current, accept, bookkeepingInvocationId);
      if (!accepted) accept();
      return { state: next, value };
    });
  }

  commitState(
    transition: RunStateTransition<TOutput>,
    bookkeepingInvocationId: RunCommitBookkeeping = null,
  ): Promise<RunState<TOutput>> {
    return this.mutate(current => ({ payloads: [], patch: transition(current), value: undefined, bookkeepingInvocationId }))
      .then(result => result.state);
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(() => {
      if (this.failed) throw this.failure;
      return operation();
    });
    this.tail = result.catch(error => { this.fail(error); });
    return result;
  }

  private assertWritable(): void {
    if (["completed", "failed", "cancelled"].includes(this.state.status)) {
      throw new TypeError("A terminal Run cannot accept state mutations.");
    }
  }
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}
