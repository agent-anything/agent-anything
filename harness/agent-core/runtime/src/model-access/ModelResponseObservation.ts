import type {
  ProviderDeliveryOptions, ProviderDeliveryProgress, ProviderResponsePartMapping,
} from "@agent-anything/model-interaction";
import type { TaskDecisionModelItem } from "../decision/TaskDecisionActivity.js";

export type ModelResponseObservation =
  | { readonly kind: "delivery"; readonly runId: string; readonly progress: ProviderDeliveryProgress }
  | { readonly kind: "interpretation"; readonly runId: string; readonly requestId: string;
      readonly controllerRequestId: string; readonly invocationId: string;
      readonly disposition: "validated" | "rejected" | "cancelled" | "interrupted";
      readonly parts: readonly (ProviderResponsePartMapping & { readonly modelItemId: string })[] };

export interface ModelResponseObserver { observe(event: ModelResponseObservation): void }
export interface ModelResponseDeliveryOptions {
  readonly mode: "buffered" | "streaming";
  readonly observer?: ModelResponseObserver;
}

/** One Controller call, never shared across simultaneous Runs or Child requests. */
export class ModelResponseDelivery {
  private completed: Extract<ProviderDeliveryProgress, { kind: "settled" }> | null = null;
  private generation = 0;
  constructor(private readonly runId: string, private readonly controllerRequestId: string,
    private readonly options: ModelResponseDeliveryOptions) {}

  invocation(invocationId: string, requestId: string, signal: AbortSignal): ProviderDeliveryOptions {
    this.completed = null;
    const generation = ++this.generation;
    let sequence = 0;
    let settled = false;
    return Object.freeze({ mode: this.options.mode, invocationId, observer: {
      observe: (progress: ProviderDeliveryProgress) => {
        if (generation !== this.generation || settled || progress.sequence <= sequence ||
            progress.invocationId !== invocationId || progress.requestId !== requestId ||
            progress.controllerRequestId !== this.controllerRequestId) return;
        if (signal.aborted && progress.kind !== "settled") return;
        sequence = progress.sequence;
        if (progress.kind === "settled") {
          settled = true;
          if (progress.disposition === "completed") this.completed = progress;
        }
        this.emit(Object.freeze({ kind: "delivery", runId: this.runId, progress }));
      },
    } });
  }

  finish(disposition: Extract<ModelResponseObservation, { kind: "interpretation" }>["disposition"],
    items: readonly TaskDecisionModelItem[] = []): void {
    const completed = this.completed;
    this.completed = null;
    ++this.generation;
    if (!completed) return;
    const parts = disposition !== "validated" ? [] : completed.parts.flatMap((part) => {
      const item = items.find((candidate) => candidate.kind === "assistant_text"
        ? candidate.turnId === part.turnId && candidate.contentBlockOrdinal === part.contentBlockOrdinal
        : candidate.kind === "model_tool_call" && candidate.call.modelCallRef.turnId === part.turnId &&
          candidate.call.ordinal === part.contentBlockOrdinal);
      return item ? [Object.freeze({ ...part, modelItemId: item.id })] : [];
    });
    this.emit(Object.freeze({ kind: "interpretation", runId: this.runId,
      requestId: completed.requestId, controllerRequestId: this.controllerRequestId,
      invocationId: completed.invocationId, disposition, parts: Object.freeze(parts),
    }));
  }

  private emit(event: ModelResponseObservation): void {
    try {
      const result: unknown = this.options.observer?.observe(event);
      if (result && typeof (result as PromiseLike<unknown>).then === "function") {
        void Promise.resolve(result).catch(() => {});
      }
    } catch { /* Presentation does not accept or reject a Controller decision. */ }
  }
}
