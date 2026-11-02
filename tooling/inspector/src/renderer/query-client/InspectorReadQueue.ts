interface PendingRead { start(): void; cancel(): void }

export class InspectorReadQueue {
  private active = 0;
  private readonly pending: PendingRead[] = [];
  constructor(private readonly concurrency = 2, private readonly capacity = 32) {}

  run<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) return Promise.reject(new Error("inspection_query_cancelled"));
    if (this.active >= this.concurrency && this.pending.length >= this.capacity) return Promise.reject(new Error("inspection_query_busy"));
    return new Promise<T>((resolve, reject) => {
      const item: PendingRead = {
        start: () => {
          signal?.removeEventListener("abort", item.cancel);
          this.active++;
          void Promise.resolve().then(operation).then(resolve, reject).finally(() => {
            this.active--;
            this.drain();
          });
        },
        cancel: () => {
          const index = this.pending.indexOf(item);
          if (index < 0) return;
          this.pending.splice(index, 1);
          signal?.removeEventListener("abort", item.cancel);
          reject(new Error("inspection_query_cancelled"));
        },
      };
      signal?.addEventListener("abort", item.cancel, {once: true});
      this.pending.push(item);
      this.drain();
    });
  }

  private drain(): void {
    while (this.active < this.concurrency && this.pending.length) this.pending.shift()!.start();
  }
}
