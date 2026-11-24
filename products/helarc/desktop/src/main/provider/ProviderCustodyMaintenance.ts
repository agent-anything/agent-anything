import type { ProviderConfigurationService } from "./ProviderConfigurationService.js";
import type { ProviderCustodyObserver } from "./ProviderRegistryClient.js";

/** Host housekeeping, separate from publication and execution responsibility release. */
export class ProviderCustodyMaintenance {
  private pending = Promise.resolve();
  private requested = false;
  private running = false;
  private closed = false;
  constructor(private readonly service: Pick<ProviderConfigurationService, "reconcileUpdates" | "collect">,
    private readonly observed: () => Promise<void> = async () => {}, private readonly observer?: ProviderCustodyObserver,
    private readonly reconcileDependencies?:(after:string,limit:number)=>Promise<string|null>) {}
  request(): void {
    if (this.closed) return;
    this.requested = true;
    if (this.running) return;
    this.running = true;
    this.pending = Promise.resolve().then(() => this.run()).finally(() => {
      this.running = false;
      if (this.requested && !this.closed) this.request();
    });
  }
  async idle(): Promise<void> { while (this.running) await this.pending; }
  async close(): Promise<void> { this.closed = true; this.requested = false; await this.pending; }
  private async run(): Promise<void> {
    while (this.requested && !this.closed) {
      this.requested = false;
      const started = performance.now(); let outcome: "ok" | "rejected" = "ok";
      try {
        if(this.reconcileDependencies){
          let after:string|null="";
          do{
            await new Promise<void>(resolve=>setImmediate(resolve));
            if(this.closed)break;
            after=await this.reconcileDependencies(after,25);
          }while(after!==null&&!this.closed);
        }
        for (const operation of ["reconcileUpdates", "collect"] as const) {
          let after: string | null = "";
          do {
            await new Promise<void>(resolve => setImmediate(resolve));
            if (this.closed) break;
            const page: { next: string | null; failed?: number } = await this.service[operation](after, 25);
            after = page.next;
            if ("failed" in page && page.failed) outcome = "rejected";
          } while (after !== null && !this.closed);
        }
      } catch { outcome = "rejected"; }
      finally {
        try { this.observer?.({ operation: "maintenance", subjectId: null, stage: "maintenance", durationMs: performance.now() - started, outcome }); } catch { /* Independent observer. */ }
        await this.observed().catch(() => {});
      }
    }
  }
}
