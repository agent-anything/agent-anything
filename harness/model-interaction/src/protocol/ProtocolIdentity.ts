import { createHash } from "node:crypto";
import { snapshotJsonValue } from "../ModelInteractionContractValidation.js";

export interface ProtocolRevisionRef { readonly id: string; readonly revision: string; }
export interface ModelInteractionProtocolRef extends ProtocolRevisionRef { readonly providerId: string; }

// Revisions identify our protocol definitions, not a vendor's API release number.
export const OPENAI_RESPONSES = Object.freeze({ providerId: "openai", id: "openai.responses", revision: "1" });
export const DEEPSEEK_CHAT_COMPLETIONS = Object.freeze({ providerId: "deepseek", id: "deepseek.chat-completions", revision: "1" });
export const OLLAMA_CHAT = Object.freeze({ providerId: "ollama", id: "ollama.chat", revision: "1" });

export class ModelProtocolBindingError extends Error {
  constructor(readonly code: string) { super(code); this.name = "ModelProtocolBindingError"; }
}

export function protocolRecord(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value)) || Object.getOwnPropertySymbols(value).length)
    throw new ModelProtocolBindingError("protocol_record_invalid");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.keys(descriptors).some(key => !keys.includes(key) || !descriptors[key]!.enumerable || !("value" in descriptors[key]!)))
    throw new ModelProtocolBindingError("protocol_record_invalid");
}

export function protocolToken(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value !== value.trim())
    throw new ModelProtocolBindingError("protocol_identity_invalid");
  return value;
}

export function snapshotProtocolRevisionRef(value: unknown): ProtocolRevisionRef {
  protocolRecord(value, ["id", "revision"]);
  return Object.freeze({ id: protocolToken(value.id), revision: protocolToken(value.revision) });
}

export function snapshotModelInteractionProtocol(value: unknown): ModelInteractionProtocolRef {
  protocolRecord(value, ["providerId", "id", "revision"]);
  const protocol = Object.freeze({ providerId: protocolToken(value.providerId), id: protocolToken(value.id), revision: protocolToken(value.revision) });
  const known = [OPENAI_RESPONSES, DEEPSEEK_CHAT_COMPLETIONS, OLLAMA_CHAT].find(entry => entry.id === protocol.id);
  if (known && known.providerId !== protocol.providerId) throw new ModelProtocolBindingError("protocol_provider_mismatch");
  return protocol;
}

export function protocolDigest(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(snapshotJsonValue(value, "protocol binding")), "utf8").digest("hex")}`;
}

export function sameProtocolRef(left: ModelInteractionProtocolRef, right: ModelInteractionProtocolRef): boolean {
  return left.id === right.id && left.revision === right.revision && left.providerId === right.providerId;
}
export function sameRevisionRef(left: ProtocolRevisionRef, right: ProtocolRevisionRef): boolean {
  return left.id === right.id && left.revision === right.revision;
}

export function protocolList<T>(value: unknown, snapshot: (item: unknown) => T, nonempty = false): readonly T[] {
  if (!Array.isArray(value) || (nonempty && !value.length) || Object.keys(value).length !== value.length ||
      Object.getOwnPropertySymbols(value).length || Object.getPrototypeOf(value) !== Array.prototype)
    throw new ModelProtocolBindingError("protocol_list_invalid");
  const result: T[] = [];
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) throw new ModelProtocolBindingError("protocol_list_invalid");
    result.push(snapshot(descriptor.value));
  }
  return Object.freeze(result);
}
