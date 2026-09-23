import type { ProviderDeliverySession } from "@agent-anything/model-interaction";
import type { FetchResponseLike } from "../http/ProviderHttpTransport.js";
import {
  appendStreamText, consumeResponseStream, incompleteStream, malformedStream,
  MAX_STREAM_CALLS, MAX_STREAM_FRAME_BYTES, parseStreamJson, streamLimit, streamRecord,
} from "../http/ProviderResponseStream.js";

export async function readOllamaResponseStream(
  response: FetchResponseLike, signal: AbortSignal, delivery: ProviderDeliverySession,
): Promise<unknown> {
  let pending = "";
  let content = "";
  let thinking = "";
  const calls: unknown[] = [];
  let terminal: Record<string, unknown> | null = null;
  function line(text: string): void {
    signal.throwIfAborted();
    if (!text.trim()) return;
    if (terminal) malformedStream();
    const frame = parseStreamJson(text);
    if (frame.error !== undefined || typeof frame.done !== "boolean") malformedStream();
    if (frame.message !== undefined) {
      const message = streamRecord(frame.message);
      if (message.role !== undefined && message.role !== "assistant") malformedStream();
      const previousLength = content.length;
      content = appendStreamText(content, message.content);
      thinking = appendStreamText(thinking, message.thinking);
      delivery.text(content.slice(previousLength));
      if (message.tool_calls !== undefined) {
        if (!Array.isArray(message.tool_calls)) malformedStream();
        for (const call of message.tool_calls) {
          if (calls.length >= MAX_STREAM_CALLS) streamLimit();
          const candidate = streamRecord(call);
          const fn = streamRecord(candidate.function);
          if (typeof fn.name !== "string" || !fn.name.trim()) malformedStream();
          const args = streamRecord(fn.arguments);
          delivery.tool(calls.length, fn.name, JSON.stringify(args));
          calls.push(call);
        }
      }
    }
    if (frame.done) terminal = frame;
  }
  await consumeResponseStream(response, signal, (text) => {
    pending += text;
    let newline: number;
    while ((newline = pending.indexOf("\n")) !== -1) {
      line(pending.slice(0, newline));
      pending = pending.slice(newline + 1);
    }
    if (Buffer.byteLength(pending) > MAX_STREAM_FRAME_BYTES) streamLimit();
    if (terminal && pending.trim()) malformedStream();
  }, () => terminal !== null);
  if (pending.trim()) line(pending);
  if (!terminal) incompleteStream();
  return { ...(terminal as Record<string, unknown>), message: {
    role: "assistant", content, ...(thinking ? { thinking } : {}), tool_calls: calls,
  } };
}
