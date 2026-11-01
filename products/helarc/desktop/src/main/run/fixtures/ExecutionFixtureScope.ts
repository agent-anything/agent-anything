import {AsyncLocalStorage} from "node:async_hooks";
import type {HelarcHostRunComposition, PreparedHelarcHostRun} from "../HelarcHostRunComposition.js";
import {createHelarcActivityHost} from "../../context/HelarcActivityHost.js";
import type {HelarcExecutionStore} from "../../execution-storage/HelarcExecutionStore.js";

const current = new AsyncLocalStorage<ExecutionFixtureScope>();
type FixtureStore = {close(): Promise<void>};
type FixtureActivityHost = ReturnType<typeof createHelarcActivityHost>;
interface OwnedStore {
  readonly close: () => Promise<void>;
  host?: FixtureActivityHost;
  closing: boolean;
  disposal?: Promise<void>;
}

/** Test-only ownership of late setup, active Runs, Host services and their stores. */
export class ExecutionFixtureScope {
  private closing = false;
  private disposal: Promise<void> | undefined;
  private body: Promise<unknown> = Promise.resolve();
  private readonly pending = new Map<Promise<unknown>, FixtureStore | undefined>();
  private readonly runs = new Map<HelarcHostRunComposition, {settled: Promise<void>; store?: FixtureStore}>();
  private readonly stores = new Map<FixtureStore, OwnedStore>();

  static current(): ExecutionFixtureScope | undefined {return current.getStore();}

  run<T>(body: () => Promise<T>): Promise<T> {
    this.assertOpen();
    return current.run(this, () => {
      const result = Promise.resolve().then(body);
      this.body = result.catch(() => undefined);
      return result;
    });
  }

  open<T extends FixtureStore>(create: () => Promise<T>): Promise<T> {
    this.assertOpen();
    return this.track((async () => {
      const store = await create();
      this.own(store);
      this.assertOpen();
      return store;
    })());
  }

  activityHost(store: HelarcExecutionStore, options?: Parameters<typeof createHelarcActivityHost>[1]): FixtureActivityHost {
    this.assertOpen(store);
    const owned = this.own(store);
    if (owned.host && options) throw new Error("execution_fixture_activity_host_already_bound");
    return owned.host ??= createHelarcActivityHost(store, options);
  }

  prepare(create: () => Promise<PreparedHelarcHostRun>, store?: FixtureStore): Promise<PreparedHelarcHostRun> {
    this.assertOpen(store);
    if (store) this.own(store);
    return this.track((async () => {
      const prepared = await create();
      this.assertOpen(store);
      return {...prepared,
        start: () => {this.assertOpen(store); return this.adopt(prepared.start(), store);},
        recover: intent => {
          this.assertOpen(store);
          return this.track(prepared.recover(intent).then(run => {
            this.adopt(run, store);
            this.assertOpen(store);
            return run;
          }), store);
        },
      };
    })(), store);
  }

  close(): Promise<void> {
    if (this.disposal) return this.disposal;
    this.closing = true;
    this.disposal = this.dispose();
    return this.disposal;
  }

  private async dispose(): Promise<void> {
    // Cancellation is a request. Join real Run settlement and late creation
    // before closing Host services and then stores, or starting the next test.
    await Promise.allSettled([...this.runs.keys()].map(run => this.cancel(run)));
    while (this.pending.size) await Promise.allSettled([...this.pending.keys()]);
    await Promise.allSettled([...this.runs.values()].map(run => run.settled));
    await this.body;
    const errors: unknown[] = [];
    for (const store of this.stores.keys()) {
      try {await store.close();} catch (error) {errors.push(error);}
    }
    this.stores.clear(); this.runs.clear();
    if (errors.length) throw new AggregateError(errors, "Execution fixture Host/store cleanup failed");
  }

  private own(store: FixtureStore): OwnedStore {
    const existing = this.stores.get(store);
    if (existing) return existing;
    const owned: OwnedStore = {close: store.close.bind(store), closing: false};
    this.stores.set(store, owned);
    // Recovery tests also close stores inside their bodies, before scope teardown.
    store.close = () => {
      owned.closing = true;
      return owned.disposal ??= this.closeStore(store, owned);
    };
    return owned;
  }

  private async closeStore(store: FixtureStore, owned: OwnedStore): Promise<void> {
    const runs = () => [...this.runs].filter(([, value]) => value.store === store);
    await Promise.allSettled(runs().map(([run]) => this.cancel(run)));
    for (;;) {
      const pending = [...this.pending].filter(([, owner]) => owner === store).map(([promise]) => promise);
      if (!pending.length) break;
      await Promise.allSettled(pending);
    }
    await Promise.allSettled(runs().map(([, value]) => value.settled));
    if (owned.host) {
      const result = await owned.host.service.close();
      if (!result.localExecutionsFinished || result.localInFlight !== 0) {
        throw new Error("execution_fixture_activity_shutdown_unsettled");
      }
    }
    await owned.close();
  }

  private adopt(run: HelarcHostRunComposition, store?: FixtureStore): HelarcHostRunComposition {
    const settled = run.result.then(() => undefined, () => undefined);
    this.runs.set(run, {settled, store});
    void settled.then(() => this.runs.delete(run));
    if (this.closing || (store && this.stores.get(store)?.closing)) {
      void this.track(this.cancel(run), store).catch(() => undefined);
    }
    return run;
  }

  private cancel(run: HelarcHostRunComposition): Promise<unknown> {
    return run.activeRun.cancel({origin: "host", reasonCode: "host_requested", reason: "Execution fixture finished or timed out."});
  }

  private track<T>(pending: Promise<T>, store?: FixtureStore): Promise<T> {
    this.pending.set(pending, store);
    void pending.then(() => this.pending.delete(pending), () => this.pending.delete(pending));
    return pending;
  }

  private assertOpen(store?: FixtureStore): void {
    if (this.closing) throw new Error("execution_fixture_closed");
    if (store && this.stores.get(store)?.closing) throw new Error("execution_fixture_store_closed");
  }
}
