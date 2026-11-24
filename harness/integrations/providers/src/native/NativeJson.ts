import { modelInputValueDigest } from "@agent-anything/model-interaction/input";

export type JsonObject = Record<string, unknown>;
export class NativeProtocolError extends Error {
  constructor(readonly code: string, readonly details: Readonly<Record<string, unknown>> = {}) {
    super(code); this.name = "NativeProtocolError";
  }
}
export function object(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new NativeProtocolError("native_object_required");
  return value as JsonObject;
}
export function string(value: unknown): string {
  if (typeof value !== "string") throw new NativeProtocolError("native_string_required");
  return value;
}
export function token(value: unknown): string {
  const text = string(value);
  if (!text || text.length > 4096) throw new NativeProtocolError("native_identity_invalid");
  return text;
}
export function list(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new NativeProtocolError("native_array_required");
  return value;
}
export function json(text: string, maximumBytes = 8 * 1024 * 1024): unknown {
  if (Buffer.byteLength(text) > maximumBytes) throw new NativeProtocolError("native_json_limit");
  let value:unknown;
  try { value=JSON.parse(text); } catch { throw new NativeProtocolError("native_json_invalid"); }
  const pending:{value:unknown;depth:number}[]=[{value,depth:0}];let nodes=0;
  while(pending.length){
    const current=pending.pop()!;
    if(++nodes>1_000_000||current.depth>128)throw new NativeProtocolError("native_json_structure_limit");
    if(typeof current.value==="number"&&!Number.isFinite(current.value))throw new NativeProtocolError("native_json_number_invalid");
    if(current.value&&typeof current.value==="object")for(const child of Object.values(current.value))pending.push({value:child,depth:current.depth+1});
  }
  return value;
}
export function digest(value: unknown): string {
  return modelInputValueDigest(value);
}
/** Storage may reorder parsed object keys; the original wire bytes remain authoritative. */
export function validateNativePreparedEncoding(prepared: {
  readonly body: JsonObject; readonly encoded: string; readonly digest: string;
}, code: string): JsonObject {
  // Validate the view before serialization can silently erase unsupported values.
  if (digest(prepared.body) !== prepared.digest) throw new NativeProtocolError(code);
  let wireBody: JsonObject;
  try { wireBody = object(JSON.parse(prepared.encoded)); }
  catch { throw new NativeProtocolError(code); }
  if (JSON.stringify(wireBody) !== prepared.encoded || digest(wireBody) !== prepared.digest)
    throw new NativeProtocolError(code);
  return wireBody;
}
export function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
export function copy<T>(value: T): T { return freeze(JSON.parse(JSON.stringify(value)) as T); }
