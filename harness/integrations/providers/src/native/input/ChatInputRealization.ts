import { DEEPSEEK_CHAT_COMPLETIONS, OLLAMA_CHAT } from "@agent-anything/model-interaction/protocol";
import { prepareDeepSeekChat } from "../DeepSeekChatCompletions.js";
import { prepareOllamaChat } from "../OllamaChat.js";
import { digest, list, object, token, NativeProtocolError } from "../NativeJson.js";
import { assertNativeInputManifest, nativeInputSettings, type NativeInputManifest } from "./NativeInputManifest.js";

export function realizeDeepSeekChatInput(manifest: NativeInputManifest, request: Omit<Parameters<typeof prepareDeepSeekChat>[0], "messages">) {
  const messages = validateDeepSeekChatInputGroups(manifest);
  const prepared = prepareDeepSeekChat({ ...request, messages });
  if (digest(nativeInputSettings(prepared.body)) !== digest(manifest.settings)) throw new NativeProtocolError("deepseek_current_settings_changed");
  return Object.freeze({ manifest, prepared });
}

export function validateDeepSeekChatInputGroups(manifest: NativeInputManifest) {
  assertNativeInputManifest(manifest);
  if (digest(manifest.protocol) !== digest(DEEPSEEK_CHAT_COMPLETIONS)) throw new NativeProtocolError("deepseek_input_protocol_mismatch");
  if (manifest.groups.some(g => g.replay !== "local")) throw new NativeProtocolError("deepseek_input_material_unavailable");
  const messages = manifest.groups.flatMap(g => g.items), pending = new Set<string>(), seen = new Set<string>();
  for (const message of messages) {
    if (message.role === "tool") {
      if (!pending.delete(token(message.tool_call_id))) throw new NativeProtocolError("deepseek_history_result_unmatched");
    } else {
      if (pending.size) throw new NativeProtocolError("deepseek_history_exchange_incomplete");
      if (!["system", "user", "assistant"].includes(String(message.role))) throw new NativeProtocolError("deepseek_history_role_invalid");
      for (const raw of message.tool_calls === undefined ? [] : list(message.tool_calls)) {
        if (message.role !== "assistant") throw new NativeProtocolError("deepseek_history_call_role_invalid");
        const call = object(raw), id = token(call.id);
        if (seen.has(id)) throw new NativeProtocolError("deepseek_history_call_duplicate");
        seen.add(id); pending.add(id);
      }
    }
  }
  if (pending.size) throw new NativeProtocolError("deepseek_history_exchange_incomplete");
  return messages;
}

export function realizeOllamaChatInput(manifest: NativeInputManifest, request: Omit<Parameters<typeof prepareOllamaChat>[0], "messages">) {
  const messages = validateOllamaChatInputGroups(manifest);
  const prepared = prepareOllamaChat({ ...request, messages });
  if (digest(nativeInputSettings(prepared.body)) !== digest(manifest.settings)) throw new NativeProtocolError("ollama_current_settings_changed");
  return Object.freeze({ manifest, prepared });
}

export function validateOllamaChatInputGroups(manifest: NativeInputManifest) {
  assertNativeInputManifest(manifest);
  if (digest(manifest.protocol) !== digest(OLLAMA_CHAT)) throw new NativeProtocolError("ollama_input_protocol_mismatch");
  if (manifest.groups.some(g => g.replay !== "local")) throw new NativeProtocolError("ollama_input_material_unavailable");
  const messages = manifest.groups.flatMap(g => g.items), pending: string[] = [];
  for (const message of messages) {
    if (message.role === "tool") {
      const expected = pending.shift();
      if (!expected || expected !== message.tool_name) throw new NativeProtocolError("ollama_history_result_unmatched");
    } else {
      if (pending.length) throw new NativeProtocolError("ollama_history_exchange_incomplete");
      if (!["system", "user", "assistant"].includes(String(message.role))) throw new NativeProtocolError("ollama_history_role_invalid");
      for (const raw of message.tool_calls === undefined ? [] : list(message.tool_calls)) {
        if (message.role !== "assistant") throw new NativeProtocolError("ollama_history_call_role_invalid");
        pending.push(token(object(object(raw).function).name));
      }
    }
  }
  if (pending.length) throw new NativeProtocolError("ollama_history_exchange_incomplete");
  return messages;
}
