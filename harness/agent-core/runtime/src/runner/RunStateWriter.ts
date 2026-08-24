import type { RunItemPayload, RunState } from "../run/index.js";
import type { CreateRunnerIdentity } from "./RunnerDependencies.js";

export type RunStateTransition<TOutput> = (
  current: RunState<TOutput>,
) => Readonly<Record<string, unknown>>;

/** Invocation-local sole writer for one RunState revision chain. */
export class RunStateWriter<TOutput> {
  private state: RunState<TOutput>;

  constructor(
    initial: RunState<TOutput>,
    private readonly now: () => string,
    private readonly createId: CreateRunnerIdentity,
    private readonly onCommit: (state: RunState<TOutput>) => void,
  ) {
    this.state = deepFreeze(initial);
  }

  getSnapshot(): RunState<TOutput> {
    return this.state;
  }

  commit(
    payload: RunItemPayload<TOutput>,
    transition: RunStateTransition<TOutput> = () => Object.freeze({}),
  ): RunState<TOutput> {
    return this.commitItems(Object.freeze([payload]), transition);
  }

  commitItems(
    payloads: readonly RunItemPayload<TOutput>[],
    transition: RunStateTransition<TOutput> = () => Object.freeze({}),
  ): RunState<TOutput> {
    if (payloads.length === 0) {
      throw new TypeError("RunStateWriter.commitItems requires at least one RunItem payload.");
    }
    const current = this.state;
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
    this.state = deepFreeze({
      ...current,
      ...transition(current),
      revision,
      items: [...current.items, ...items],
    }) as RunState<TOutput>;
    this.onCommit(this.state);
    return this.state;
  }

  commitState(
    transition: RunStateTransition<TOutput>,
  ): RunState<TOutput> {
    const current = this.state;
    this.state = deepFreeze({
      ...current,
      ...transition(current),
      revision: current.revision + 1,
    }) as RunState<TOutput>;
    this.onCommit(this.state);
    return this.state;
  }
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}
