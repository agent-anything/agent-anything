import type { ProviderFailure } from "@agent-anything/model-interaction";
import type { FetchResponseLike } from "./ProviderHttpTransport.js";

export const MAX_STREAM_FRAME_BYTES = 1024 * 1024;
export const MAX_STREAM_RESPONSE_BYTES = 8 * 1024 * 1024;
export const MAX_STREAM_TEXT_LENGTH = 64_000;
export const MAX_STREAM_CALLS = 256;

export class ProviderStreamError extends Error {
  constructor(readonly failure: ProviderFailure) { super(failure.message); }
}

export function malformedStream(): never {
  throw new ProviderStreamError({ category: "response", code: "provider_response_malformed",
    message: "Provider stream did not satisfy its response protocol.", metadata: {} });
}
export function incompleteStream(): never {
  throw new ProviderStreamError({ category: "transport", code: "provider_response_incomplete",
    message: "Provider stream ended before protocol completion.", metadata: {} });
}
export function streamLimit(): never {
  throw new ProviderStreamError({ category: "response", code: "provider_response_too_large",
    message: "Provider stream exceeded its response limit.", metadata: {} });
}
export function streamRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) malformedStream();
  return value as Record<string, unknown>;
}
export function parseStreamJson(text: string): Record<string, unknown> {
  if (Buffer.byteLength(text) > MAX_STREAM_FRAME_BYTES) streamLimit();
  try { return streamRecord(JSON.parse(text)); }
  catch (error) { if (error instanceof ProviderStreamError) throw error; malformedStream(); }
}
export function appendStreamText(current: string, fragment: unknown, limit = MAX_STREAM_TEXT_LENGTH): string {
  if (fragment === undefined || fragment === null) return current;
  if (typeof fragment !== "string") malformedStream();
  if (current.length + fragment.length > limit) streamLimit();
  return current + fragment;
}

/** Abort competes with body reads as well as fetch; a stalled body cannot outlive its attempt. */
export async function consumeResponseStream(
  response: FetchResponseLike,
  signal: AbortSignal,
  feed: (text: string) => void,
  isComplete: () => boolean,
): Promise<void> {
  if (!response.body) malformedStream();
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let rejectAbort: (reason: unknown) => void = () => {};
  const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
  void aborted.catch(() => {});
  const onAbort = () => rejectAbort(signal.reason);
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    signal.throwIfAborted();
    while (!isComplete()) {
      const item = await Promise.race([reader.read(), aborted]);
      signal.throwIfAborted();
      if (item.done) {
        let tail: string;
        try { tail = decoder.decode(); } catch { malformedStream(); }
        if (tail) feed(tail);
        return;
      }
      bytes += item.value.byteLength;
      if (bytes > MAX_STREAM_RESPONSE_BYTES) streamLimit();
      let text: string;
      try { text = decoder.decode(item.value, { stream: true }); } catch { malformedStream(); }
      feed(text);
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
    // Cleanup cannot wait on a remote peer's cancellation acknowledgement.
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
