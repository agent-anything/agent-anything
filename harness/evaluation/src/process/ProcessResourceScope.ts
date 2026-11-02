export interface ProcessOwnedResource {
  readonly id: string;
  readonly kind: string;
  close(): Promise<void>;
}
export interface ProcessResourceRecord {
  readonly id: string;
  readonly kind: string;
  readonly state: "creating" | "active" | "closed" | "failed";
  readonly reason: string | null;
}
export interface ProcessCleanupReceipt {
  readonly status: "cleaned" | "quarantined";
  readonly resources: readonly ProcessResourceRecord[];
}

/** Tracks creation before awaiting it, including creations completing after cancellation. */
export class ProcessResourceScope {
  #accepting = true;
  readonly #entries = new Map<string, {record: ProcessResourceRecord; resource?: ProcessOwnedResource; creation: Promise<void>; closing?: Promise<void>}>();
  stopAdmission(): void { this.#accepting = false; }
  get accepting(): boolean { return this.#accepting; }
  async acquire<T extends ProcessOwnedResource>(id: string, kind: string, create: () => Promise<T>): Promise<T> {
    if (!this.#accepting) throw new Error("process_resource_admission_closed");
    if (!id || !kind || this.#entries.has(id)) throw new Error("process_resource_identity_invalid");
    const entry: {record: ProcessResourceRecord; resource?: ProcessOwnedResource; creation: Promise<void>; closing?: Promise<void>} = {
      record: {id, kind, state: "creating", reason: null}, creation: Promise.resolve(),
    };
    this.#entries.set(id, entry);
    const created = Promise.resolve().then(create);
    entry.creation = created.then(async resource => {
      entry.resource = resource;
      entry.record = {...entry.record, state: "active"};
      if (!this.#accepting || resource.id !== id || resource.kind !== kind) await this.#close(entry);
    }, error => { entry.record = {...entry.record, state: "failed", reason: String(error)}; });
    await entry.creation;
    const resource = await created;
    if (!this.#accepting || resource.id !== id || resource.kind !== kind) throw new Error("process_resource_admission_closed");
    return resource;
  }
  snapshot(): readonly ProcessResourceRecord[] { return [...this.#entries.values()].map(entry => ({...entry.record})); }
  async close(deadlineMs: number): Promise<ProcessCleanupReceipt> {
    if (!Number.isFinite(deadlineMs) || deadlineMs <= 0) throw new TypeError("Cleanup bound must be positive");
    this.stopAdmission();
    // Closing active resources must not wait behind a stalled creation.
    const work = [...this.#entries.values()].map(async entry => {
      if (entry.resource) await this.#close(entry);
      await entry.creation;
      if (entry.resource) await this.#close(entry);
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([Promise.all(work), new Promise<void>(resolve => { timer = setTimeout(resolve, deadlineMs); })]);
    } finally { if (timer) clearTimeout(timer); }
    const resources = this.snapshot();
    return {status: resources.every(value => value.state === "closed") ? "cleaned" : "quarantined", resources};
  }
  #close(entry: {record: ProcessResourceRecord; resource?: ProcessOwnedResource; closing?: Promise<void>}): Promise<void> {
    if (!entry.closing) entry.closing = Promise.resolve().then(() => entry.resource!.close()).then(() => {
      entry.record = {...entry.record, state: "closed", reason: null};
    }, error => { entry.record = {...entry.record, state: "failed", reason: String(error)}; });
    return entry.closing;
  }
}
