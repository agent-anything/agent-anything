import type { ProviderCallResult } from "./Provider.js";
import type { ProviderRequest } from "./ProviderRequest.js";

export interface ProviderDeliveryOptions {
  readonly mode: "buffered" | "streaming";
  readonly invocationId: string;
  readonly observer?: ProviderDeliveryObserver;
}

export interface ProviderResponsePartMapping {
  readonly partId: string;
  readonly turnId: string;
  readonly contentBlockOrdinal: number;
}

export type ProviderDeliveryEvent =
  | { readonly kind: "started"; readonly mode: "buffered" | "streaming" }
  | { readonly kind: "text_delta"; readonly partId: string; readonly offset: number; readonly text: string }
  | { readonly kind: "tool_call_delta"; readonly partId: string; readonly index: number;
      readonly name: string; readonly argumentsDelta: string }
  | { readonly kind: "settled";
      readonly disposition: "completed" | "interrupted" | "cancelled" | "failed" | "continuation_rejected";
      readonly code: string | null;
      readonly parts: readonly ProviderResponsePartMapping[] };

export type ProviderDeliveryProgress = ProviderDeliveryEvent & {
  readonly invocationId: string;
  readonly requestId: string;
  readonly controllerRequestId: string | null;
  readonly sequence: number;
};

export interface ProviderDeliveryObserver {
  observe(progress: ProviderDeliveryProgress): void;
}

/** Trusted in-process observation only; observer work must be synchronous and bounded. */
export function publishProviderDelivery(
  observer: ProviderDeliveryObserver | undefined,
  progress: ProviderDeliveryProgress,
): void {
  if (!observer) return;
  try {
    const result: unknown = observer.observe(Object.freeze(progress));
    if (result && typeof (result as PromiseLike<unknown>).then === "function") {
      void Promise.resolve(result).catch(() => {});
    }
  } catch { /* An observer cannot change a Provider result. */ }
}

export class ProviderDeliverySession {
  private sequence = 0;
  private ended = false;
  private textOffset = 0;
  private readonly requestId: string;
  private readonly controllerRequestId: string | null;
  readonly options: ProviderDeliveryOptions;

  constructor(options: ProviderDeliveryOptions, request: ProviderRequest) {
    if ((options.mode !== "buffered" && options.mode !== "streaming") ||
        typeof options.invocationId !== "string" || !options.invocationId.trim() ||
        options.invocationId.length > 2048) {
      throw new TypeError("Provider delivery requires a mode and bounded invocation identity.");
    }
    this.options = Object.freeze({ ...options });
    this.requestId = request.requestId;
    this.controllerRequestId = request.correlation?.controllerRequestId ?? null;
  }

  start(): void { this.emit({ kind: "started", mode: this.options.mode }); }
  text(text: string): void {
    if (!text || this.ended) return;
    const offset = this.textOffset;
    this.textOffset += text.length;
    this.emit({ kind: "text_delta", partId: "text:0", offset, text });
  }
  tool(index: number, name: string, argumentsDelta: string): void {
    this.emit({ kind: "tool_call_delta", partId: `call:${index}`, index, name, argumentsDelta });
  }
  settle(result: ProviderCallResult): void {
    if (this.ended) return;
    const parts: ProviderResponsePartMapping[] = [];
    if (result.kind === "succeeded" && result.response.kind === "native_tool_turn") {
      let callIndex = 0;
      const turn = result.response.turn;
      turn.assistant.content.forEach((block, contentBlockOrdinal) => {
        parts.push(Object.freeze({
          partId: block.kind === "text" ? "text:0" : `call:${callIndex++}`,
          turnId: turn.turnId, contentBlockOrdinal,
        }));
      });
    }
    const failure = "failure" in result ? result.failure : null;
    this.emit({ kind: "settled", parts: Object.freeze(parts), code: failure?.code ?? null,
      disposition: result.kind === "succeeded" ? "completed"
        : result.kind === "cancelled" ? "cancelled"
        : result.kind === "continuation_rejected" ? "continuation_rejected"
        : failure?.category === "transport" || failure?.category === "timeout" || failure?.category === "deadline"
          ? "interrupted" : "failed",
    });
    this.ended = true;
  }
  private emit(event: ProviderDeliveryEvent): void {
    if (this.ended) return;
    publishProviderDelivery(this.options.observer, Object.freeze({
      ...event, invocationId: this.options.invocationId,
      requestId: this.requestId,
      controllerRequestId: this.controllerRequestId,
      sequence: ++this.sequence,
    }));
  }
}
