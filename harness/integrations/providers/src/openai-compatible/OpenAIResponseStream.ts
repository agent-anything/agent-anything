import { createParser } from "eventsource-parser";
import type { ProviderDeliverySession } from "@agent-anything/model-interaction";
import type { FetchResponseLike } from "../http/ProviderHttpTransport.js";
import {
  appendStreamText, consumeResponseStream, incompleteStream, malformedStream,
  MAX_STREAM_CALLS, MAX_STREAM_FRAME_BYTES, parseStreamJson, streamLimit, streamRecord,
} from "../http/ProviderResponseStream.js";

interface AccumulatedCall { id: string; type: string; name: string; arguments: string }

export async function readOpenAIResponseStream(
  response: FetchResponseLike, signal: AbortSignal, delivery: ProviderDeliverySession,
): Promise<unknown> {
  let content = "";
  let refusal = "";
  let responseId: string | null = null;
  let finish: string | null = null;
  let usage: unknown = null;
  let done = false;
  const calls = new Map<number, AccumulatedCall>();
  const parser = createParser({
    // At most three UTF-8 bytes per UTF-16 code unit, in addition to the byte cap.
    maxBufferSize: Math.floor(MAX_STREAM_FRAME_BYTES / 3),
    onError(error) { if (error.type === "max-buffer-size-exceeded") streamLimit(); },
    onEvent(event) {
      signal.throwIfAborted();
      if (done) malformedStream();
      if (event.data === "[DONE]") {
        if (finish === null) malformedStream();
        done = true;
        return;
      }
      const frame = parseStreamJson(event.data);
      if (frame.error !== undefined) malformedStream();
      if (frame.id !== undefined && frame.id !== null) {
        if (typeof frame.id !== "string" || (responseId !== null && responseId !== frame.id)) malformedStream();
        responseId = frame.id;
      }
      if (frame.usage !== undefined && frame.usage !== null) usage = frame.usage;
      if (!Array.isArray(frame.choices) || frame.choices.length > 1) malformedStream();
      if (frame.choices.length === 0) return;
      if (finish !== null) malformedStream();
      const choice = streamRecord(frame.choices[0]);
      if (choice.index !== 0) malformedStream();
      const delta = streamRecord(choice.delta);
      if (delta.role !== undefined && delta.role !== "assistant") malformedStream();
      if (delta.function_call !== undefined && delta.function_call !== null) malformedStream();
      const previousLength = content.length;
      content = appendStreamText(content, delta.content);
      refusal = appendStreamText(refusal, delta.refusal);
      delivery.text(content.slice(previousLength));
      if (delta.tool_calls !== undefined && delta.tool_calls !== null) {
        if (!Array.isArray(delta.tool_calls)) malformedStream();
        for (const raw of delta.tool_calls) {
          const call = streamRecord(raw);
          if (!Number.isSafeInteger(call.index) || (call.index as number) < 0 || (call.index as number) >= MAX_STREAM_CALLS) malformedStream();
          const index = call.index as number;
          const prior = calls.get(index) ?? { id: "", type: "", name: "", arguments: "" };
          if (call.type !== undefined) {
            if (call.type !== "function") malformedStream();
            prior.type = call.type;
          }
          if (call.id !== undefined) {
            if (typeof call.id !== "string" || (prior.id && prior.id !== call.id)) malformedStream();
            prior.id = call.id;
          }
          const fn = call.function === undefined ? {} : streamRecord(call.function);
          prior.name = appendStreamText(prior.name, fn.name, 512);
          prior.arguments = appendStreamText(prior.arguments, fn.arguments, MAX_STREAM_FRAME_BYTES);
          calls.set(index, prior);
          delivery.tool(index, prior.name, typeof fn.arguments === "string" ? fn.arguments : "");
        }
      }
      if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
        if (typeof choice.finish_reason !== "string" || !choice.finish_reason) malformedStream();
        finish = choice.finish_reason;
      }
    },
  });
  await consumeResponseStream(response, signal, (text) => parser.feed(text), () => done);
  if (!done) incompleteStream();
  const ordered = [...calls].sort(([left], [right]) => left - right);
  const toolCalls = ordered.map(([index, call], ordinal) => {
    if (index !== ordinal || !call.id || call.type !== "function" || !call.name) malformedStream();
    return { id: call.id, type: call.type, function: { name: call.name, arguments: call.arguments } };
  });
  return { id: responseId, choices: [{ index: 0, finish_reason: finish,
    message: { role: "assistant", content, refusal: refusal || null, tool_calls: toolCalls },
  }], usage };
}
