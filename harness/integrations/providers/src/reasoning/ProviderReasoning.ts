import { createHash } from "node:crypto";
import { snapshotModelReasoning, type ModelMessage, type ModelReasoning } from "@agent-anything/model-interaction";

export function reasoningBinding(baseUrl: string, model: string, format: string): string {
  return `sha256:${createHash("sha256").update(JSON.stringify({
    baseUrl: new URL(baseUrl).toString().replace(/\/+$/, ""), model, format,
  })).digest("hex")}`;
}

export function readProviderReasoning(value: unknown, format: string, binding: string): ModelReasoning | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new TypeError("Provider reasoning is not text.");
  return snapshotModelReasoning({ text: value, replay: { format, binding } });
}

export function replayReasoning(
  message: Extract<ModelMessage, { role: "assistant" }>, format: string, binding: string,
): string | undefined {
  if (message.reasoning === undefined) return undefined;
  const reasoning = snapshotModelReasoning(message.reasoning);
  if (reasoning.replay?.format !== format || reasoning.replay.binding !== binding) {
    throw new TypeError("Reasoning history does not match the selected Provider and model.");
  }
  return reasoning.text;
}
