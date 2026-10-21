import {AsyncLocalStorage} from "node:async_hooks";
import type {HelarcHostRunComposition, PreparedHelarcHostRun} from "../HelarcHostRunComposition.js";

const current = new AsyncLocalStorage<ExecutionFixtureScope>();

/** Test-only ownership of late setup, active Runs and their stores. */
export class ExecutionFixtureScope {
  private closing = false;
  private disposal: Promise<void> | undefined;
  private body: Promise<unknown> = Promise.resolve();
  private readonly pending = new Set<Promise<unknown>>();
  private readonly runs = new Map<HelarcHostRunComposition, Promise<unknown>>();
  private readonly stores = new Set<{close(): Promise<void>}>();

  static current(): ExecutionFixtureScope | undefined {return current.getStore();}

  run<T>(body: () => Promise<T>): Promise<T> {
    this.assertOpen();
    return current.run(this, () => {
      const result = Promise.resolve().then(body);
      this.body = result.catch(() => undefined);
      return result;
    });
  }

  open<T extends {close(): Promise<void>}>(create: () => Promise<T>): Promise<T> {
    this.assertOpen();
    return this.track((async () => {
      const store = await create();
      this.stores.add(store);
      this.assertOpen();
      return store;
    })());
  }

  prepare(create: () => Promise<PreparedHelarcHostRun>): Promise<PreparedHelarcHostRun> {
    this.assertOpen();
    return this.track((async () => {
      const prepared = await create();
      this.assertOpen();
      return {...prepared,
        start: () => {this.assertOpen(); return this.adopt(prepared.start());},
        recover: intent => {
          this.assertOpen();
          return this.track(prepared.recover(intent).then(run => {
            this.adopt(run);
            this.assertOpen();
            return run;
          }));
        },
      };
    })());
  }

  close(): Promise<void> {
    if (this.disposal) return this.disposal;
    this.closing = true;
    this.disposal = this.dispose();
    return this.disposal;
  }

  private async dispose(): Promise<void> {
    // Cancellation is a request. Join real Run settlement and late creation
    // before closing stores or allowing the next test to begin.
    await Promise.allSettled([...this.runs.keys()].map(run => this.cancel(run)));
    while (this.pending.size) await Promise.allSettled([...this.pending]);
    await Promise.allSettled([...this.runs.values()]);
    await this.body;
    const closed = await Promise.allSettled([...this.stores].map(store => store.close()));
    this.stores.clear(); this.runs.clear();
    const errors = closed.flatMap(value => value.status === "rejected" ? [value.reason] : []);
    if (errors.length) throw new AggregateError(errors, "Execution fixture store cleanup failed");
  }

  private adopt(run: HelarcHostRunComposition): HelarcHostRunComposition {
    const settled = run.result.then(() => undefined, () => undefined);
    this.runs.set(run, settled);
    void settled.then(() => this.runs.delete(run));
    if (this.closing) void this.cancel(run).catch(() => undefined);
    return run;
  }

  private cancel(run: HelarcHostRunComposition): Promise<unknown> {
    return run.activeRun.cancel({origin: "host", reasonCode: "host_requested", reason: "Execution fixture finished or timed out."});
  }

  private track<T>(pending: Promise<T>): Promise<T> {
    this.pending.add(pending);
    void pending.then(() => this.pending.delete(pending), () => this.pending.delete(pending));
    return pending;
  }

  private assertOpen(): void {
    if (this.closing) throw new Error("execution_fixture_closed");
  }
}
