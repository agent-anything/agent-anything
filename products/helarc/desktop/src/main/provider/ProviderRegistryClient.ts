import { Worker } from "node:worker_threads";
import { ProviderConfigurationError } from "../../shared/ProviderConfiguration.js";
import type { ProviderRegistryCommand, ProviderRegistryPort, ProviderRegistryValue } from "./ProviderRegistryProtocol.js";

export interface ProviderCustodyObservation {
  readonly operation: string;
  readonly stage: "registry" | "vault" | "maintenance";
  readonly outcome: "ok" | "rejected" | "unknown";
  readonly durationMs: number;
  readonly workerMs?: number;
  readonly work?: {readonly queries:number;readonly rowsRead:number;readonly rowsChanged:number;readonly statementsPrepared:number};
  readonly subjectId: string | null;
}
export type ProviderCustodyObserver = (event: ProviderCustodyObservation) => void;

/** Bounded metadata RPC. Failure means unknown acknowledgement, never permission to redo a save. */
export class ProviderRegistryClient implements ProviderRegistryPort {
  private readonly pending = new Map<number, { resolve(value: ProviderRegistryValue): void; reject(error: Error): void;
    timer: ReturnType<typeof setTimeout>; command: ProviderRegistryCommand; started: number }>();
  private nextId = 0;
  private failed = false;
  private closing: Promise<void> | null = null;
  private readonly exited: Promise<void>;
  private constructor(private readonly worker: Worker, private readonly observer?: ProviderCustodyObserver) {
    this.exited = new Promise(resolve => worker.once("exit", () => { this.fail(); resolve(); }));
    worker.on("error", () => this.fail());
    worker.on("message", reply => {
      if (reply.kind === "ready" || reply.kind === "startup_failed") return;
      const pending = this.pending.get(reply.id); if (!pending) return this.fail();
      this.pending.delete(reply.id); clearTimeout(pending.timer);
      const outcome = reply.kind === "result" ? "ok" : "rejected";
      this.observe(pending.command, pending.started, outcome, reply.durationMs, reply.work);
      if (reply.kind === "result") pending.resolve(reply.value);
      else pending.reject(new ProviderConfigurationError(typeof reply.code === "string" ? reply.code : "provider_registry_failed"));
    });
  }
  static async open(path: string, observer?: ProviderCustodyObserver): Promise<ProviderRegistryClient> {
    const worker = new Worker(new URL("./ProviderRegistryWorker.js", import.meta.url), { workerData: { path } });
    const client = new ProviderRegistryClient(worker, observer);
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => finish(new ProviderConfigurationError("provider_registry_start_timeout")), 30_000);
        const finish = (error?: Error) => { clearTimeout(timer); worker.off("message", message); worker.off("error", failed); worker.off("exit", failed); error ? reject(error) : resolve(); };
        const message = (reply: { kind: string }) => { if (reply.kind === "ready") finish(); else if (reply.kind === "startup_failed") failed(); };
        const failed = () => finish(new ProviderConfigurationError("provider_registry_unavailable"));
        worker.on("message", message); worker.once("error", failed); worker.once("exit", failed);
      });
      return client;
    } catch (error) { await worker.terminate(); throw error; }
  }
  request(command: ProviderRegistryCommand): Promise<ProviderRegistryValue> {
    if (this.failed || (this.closing && command.kind !== "close")) return Promise.reject(new ProviderConfigurationError("provider_registry_unavailable"));
    if (this.pending.size >= 64 || Buffer.byteLength(JSON.stringify(command)) > 65536) return Promise.reject(new ProviderConfigurationError("provider_registry_request_limit"));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.fail(); void this.worker.terminate(); }, 30_000);
      this.pending.set(id, { resolve, reject, timer, command, started: performance.now() });
      try { this.worker.postMessage({ id, command }); } catch { this.fail(); void this.worker.terminate(); }
    });
  }
  close(): Promise<void> {
    return this.closing ??= (async () => {
      try { if (!this.failed) await this.request({ kind: "close" }); }
      finally { await this.worker.terminate(); await this.exited; }
    })();
  }
  private fail(): void {
    this.failed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer); this.observe(pending.command, pending.started, "unknown");
      pending.reject(new ProviderConfigurationError("provider_registry_acknowledgement_unknown"));
    }
    this.pending.clear();
  }
  private observe(command: ProviderRegistryCommand, started: number, outcome: ProviderCustodyObservation["outcome"], workerMs?: number, work?:ProviderCustodyObservation["work"]): void {
    try { this.observer?.({ operation: command.kind, stage: "registry", outcome, durationMs: performance.now() - started,
      ...(workerMs === undefined ? {} : { workerMs }), ...(work ? {work} : {}), subjectId: "id" in command ? command.id : command.kind === "begin_update" ? command.update.id : null }); }
    catch { /* Diagnostics cannot change custody acknowledgement. */ }
  }
}
