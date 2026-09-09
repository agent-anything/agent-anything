import type { ProviderRequest } from "../ProviderRequest.js";
import type { ProviderCallResult } from "../Provider.js";
import type { ModelJsonValue } from "../ModelInteractionContractValidation.js";

export interface ProviderObservation {
  readonly attemptId: string;
  readonly requestId: string;
  readonly runId: string | null;
  readonly controllerRequestId: string | null;
  readonly providerId: string;
  readonly model: string;
  readonly occurredAt: string;
  readonly stage: "request" | "dispatch" | "http_response" | "response_body" | "settled";
  readonly endpoint: string | null;
  readonly httpStatus: number | null;
  readonly encodedBytes: number | null;
  readonly code: string | null;
  readonly status: string;
  readonly request: ProviderRequest | null;
  readonly result: ProviderCallResult | null;
  readonly body: ModelJsonValue | null;
  readonly representation: "semantic" | "encoded_json" | "parsed_json" | "error_diagnostic" | "normalized" | null;
  readonly contentUnavailable: boolean;
}
export interface ProviderObserver { observe(observation: ProviderObservation): void }

export function publishProviderObservation(observer: ProviderObserver | undefined, observation: ProviderObservation): void {
  if (!observer) return;
  try {
    const value: unknown = observer.observe(Object.freeze(observation));
    if (value && typeof (value as PromiseLike<unknown>).then === "function") void Promise.resolve(value).catch(() => {});
  } catch { /* Diagnostics cannot supply or change a Provider result. */ }
}

/** Detaches source-owned JSON without invoking accessors, with finite copy work. */
export function snapshotProviderDiagnostic(value: unknown): ModelJsonValue | undefined {
  let nodes = 0;
  let bytes = 0;
  function copy(input: unknown, depth: number): ModelJsonValue {
    if (++nodes > 50000 || depth > 32 || bytes > 8 * 1024 * 1024) throw new Error("Diagnostic limit");
    if (input === null || typeof input === "boolean") return input;
    if (typeof input === "number" && Number.isFinite(input)) return input;
    if (typeof input === "string") { bytes += input.length * 3; if (bytes > 8 * 1024 * 1024) throw new Error("Diagnostic limit"); return input; }
    if (typeof input !== "object" || !input) throw new Error("Diagnostic data only");
    if (!Array.isArray(input) && Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null) throw new Error("Diagnostic data only");
    const descriptors = Object.getOwnPropertyDescriptors(input);
    if (Object.keys(descriptors).length > 50000 || Object.values(descriptors).some((entry) => !Object.hasOwn(entry, "value"))) throw new Error("Diagnostic data only");
    if (Array.isArray(input)) return Object.freeze(input.map((entry) => copy(entry, depth + 1)));
    const output: Record<string, ModelJsonValue> = Object.create(null);
    for (const [key, descriptor] of Object.entries(descriptors)) {
      bytes += key.length * 3;
      if (descriptor.value !== undefined) output[key] = copy(descriptor.value, depth + 1);
    }
    return Object.freeze(output);
  }
  try { return copy(value, 0); } catch { return undefined; }
}
