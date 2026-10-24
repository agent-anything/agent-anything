export interface ProviderAdmissionPolicy {
  readonly revision: string;
  readonly maximumActive: number;
  readonly maximumBackground: number;
  readonly maximumQueued: number;
}
export interface ProviderAdmissionLease {
  settle(confirmation: "confirmed" | "unconfirmed"): void;
}
interface Entry {
  readonly id: string;
  readonly background: boolean;
  readonly signal: AbortSignal;
  readonly resolve: (lease: ProviderAdmissionLease) => void;
  readonly reject: (error: unknown) => void;
  abort(): void;
}
/** Physical request admission. This does not order model Calls or retry business work. */
export class ProviderRequestAdmission {
  private readonly queued: Entry[] = [];
  private readonly active = new Map<string, {background: boolean; state: "active" | "unconfirmed"}>();
  constructor(readonly policy: ProviderAdmissionPolicy) {
    if (!policy.revision || ![policy.maximumActive, policy.maximumBackground, policy.maximumQueued].every(value => Number.isSafeInteger(value) && value > 0) ||
        policy.maximumBackground >= policy.maximumActive) throw new TypeError("Invalid Provider admission policy.");
  }
  snapshot(): {active: number; background: number; queued: number; unconfirmed: number} {
    const leases = [...this.active.values()];
    return {active: leases.length, background: leases.filter(value => value.background).length,
      queued: this.queued.length, unconfirmed: leases.filter(value => value.state === "unconfirmed").length};
  }
  acquire(input: {readonly id: string; readonly background: boolean; readonly signal: AbortSignal}): Promise<ProviderAdmissionLease> {
    input.signal.throwIfAborted();
    if (!input.id || this.active.has(input.id) || this.queued.some(entry => entry.id === input.id)) throw new TypeError("Provider admission identity is already in use.");
    if (this.queued.length >= this.policy.maximumQueued) return Promise.reject(new Error("provider_admission_queue_full"));
    return new Promise((resolve, reject) => {
      const entry: Entry = {...input, resolve, reject, abort: () => {
        const index = this.queued.indexOf(entry);
        if (index < 0) return;
        this.queued.splice(index, 1); input.signal.removeEventListener("abort", entry.abort);
        reject(input.signal.reason); this.drain();
      }};
      this.queued.push(entry); input.signal.addEventListener("abort", entry.abort, {once: true});
      if (input.signal.aborted) entry.abort(); else this.drain();
    });
  }
  private drain(): void {
    while (this.active.size < this.policy.maximumActive && this.queued.length) {
      let index = this.queued.findIndex(entry => !entry.background);
      if (index < 0) {
        if (this.snapshot().background >= this.policy.maximumBackground) return;
        index = 0;
      }
      const entry = this.queued.splice(index, 1)[0]!;
      entry.signal.removeEventListener("abort", entry.abort);
      if (entry.signal.aborted) {entry.reject(entry.signal.reason); continue;}
      const active = {background: entry.background, state: "active" as const};
      this.active.set(entry.id, active);
      let settled = false;
      entry.resolve({settle: confirmation => {
        if (settled) throw new TypeError("Provider admission lease already settled.");
        settled = true;
        if (confirmation === "unconfirmed") this.active.set(entry.id, {...active, state: "unconfirmed"});
        else this.active.delete(entry.id);
        this.drain();
      }});
    }
  }
}
