import { copy, digest, token, validateNativePreparedEncoding, NativeProtocolError, type JsonObject } from "../NativeJson.js";
import { dispatchNativeHttp, type NativeHttpObservation, type NativeHttpOptions } from "../NativeHttp.js";
import { nativeHttpEndpoint } from "../NativeHttpEndpoint.js";

export const RESPONSES_INPUT_TOKEN_COUNT_REVISION = "openai.responses.input_tokens.2026-11-13.1";
export const RESPONSES_INPUT_TOKEN_COUNT_SOURCE = "https://developers.openai.com/api/reference/python/resources/responses/subresources/input_tokens/methods/count";
const CREATE_SOURCE = "https://developers.openai.com/api/reference/python/resources/responses/methods/create";

/** Stable input facts; current authority and custody are checked separately on every use. */
export interface ResponsesMeasurementBinding {
  readonly encodedInputId: string;
  readonly scope: { readonly id: string; readonly runId: string; readonly recipient: string; readonly purpose: string };
  /** Complete ordered content coverage and delivery boundary, not only the wire suffix. */
  readonly selectionDigest: string;
  /** Source/representation versions and instruction/catalog/setting provenance, not renewable holds. */
  readonly sourceDigest: string;
  /** Model, configuration, account/connection and disclosure revisions. */
  readonly targetDigest: string;
  /** Continuation scope/generation/coverage plus current content-resolution dependencies. */
  readonly dependencyDigest: string;
  readonly targetRevision: string;
  readonly targetValidity: { readonly basis: string; readonly validUntil: string } | null;
  readonly prefix:
    | { readonly kind: "none" }
    | { readonly kind: "persistent"; readonly responseId: string; readonly coverageDigest: string | null }
    | { readonly kind: "connection_memory"; readonly responseId: string };
  /** Includes remote item/file rendering and external resolution, not only retained local bytes. */
  readonly dependencies:
    | { readonly kind: "immutable"; readonly basis: string }
    | { readonly kind: "mutable" | "unknown"; readonly reason: string };
}

export interface ResponsesCountFieldMapping {
  readonly field: string;
  readonly disposition: "carried" | "measurement_neutral" | "uncovered";
  readonly basis: string;
}
export interface ResponsesInputTokenCountRequest {
  readonly id: string;
  readonly revision: typeof RESPONSES_INPUT_TOKEN_COUNT_REVISION;
  readonly binding: ResponsesMeasurementBinding;
  readonly bindingDigest: string;
  readonly generation: { readonly body: JsonObject; readonly encoded: string; readonly digest: string };
  readonly body: JsonObject;
  readonly encoded: string;
  readonly mappings: readonly ResponsesCountFieldMapping[];
  readonly coverage: "complete" | "partial";
  readonly uncovered: readonly string[];
  readonly dispatchBlock: "connection_memory_not_countable" | null;
}
export interface ResponsesMeasurementApplicability {
  readonly binding: ResponsesMeasurementBinding;
  readonly generationDigest: string;
  readonly now: string;
  /** Current authorization must include disclosure to the counting service. */
  readonly authorized: boolean;
  readonly dependenciesAvailable: boolean;
}

const carried = new Set(["model", "input", "instructions", "previous_response_id", "tools",
  "tool_choice", "parallel_tool_calls", "reasoning", "text", "personality", "truncation"]);
// These documented create fields control transport, response inclusion or persistence, not input rendering.
const neutral: Readonly<Record<string, string>> = Object.freeze({
  stream: "response_transport", stream_options: "response_transport", background: "response_execution_mode",
  store: "response_persistence", include: "response_data_inclusion", metadata: "request_metadata",
});
const verified = new WeakSet<ResponsesInputTokenCountRequest>();

export function prepareResponsesInputTokenCount(input: {
  readonly prepared: { readonly body: JsonObject; readonly encoded: string; readonly digest: string };
  readonly binding: ResponsesMeasurementBinding;
}): ResponsesInputTokenCountRequest {
  const generation = input.prepared;
  const wireBody = validateNativePreparedEncoding(generation,"responses_count_generation_changed");
  token(wireBody.model);
  if (Object.hasOwn(wireBody, "conversation")) throw new NativeProtocolError("responses_count_conversation_unsupported");
  if (wireBody.truncation !== undefined && wireBody.truncation !== "disabled")
    throw new NativeProtocolError("responses_count_truncation_forbidden");
  const binding = snapshotBinding(input.binding);
  checkPrefix(wireBody, binding.prefix);
  const body: JsonObject = {}, mappings: ResponsesCountFieldMapping[] = [], uncovered: string[] = [];
  for (const [field, value] of Object.entries(wireBody)) {
    if (carried.has(field)) {
      body[field] = value;
      mappings.push({ field, disposition: "carried", basis: RESPONSES_INPUT_TOKEN_COUNT_SOURCE });
    } else if (Object.hasOwn(neutral, field)) {
      mappings.push({ field, disposition: "measurement_neutral", basis: `${CREATE_SOURCE}#${neutral[field]}` });
    } else {
      const basis = field.startsWith("prompt_cache_") ? "cache_count_equivalence_unestablished" : "create_field_not_in_count_schema";
      mappings.push({ field, disposition: "uncovered", basis });
      uncovered.push(`field:${field}:${basis}`);
    }
  }
  if (binding.prefix.kind === "persistent" && !binding.prefix.coverageDigest)
    uncovered.push("remote_prefix_coverage_unknown");
  if (binding.prefix.kind === "connection_memory") uncovered.push("connection_memory_not_countable");
  if (binding.dependencies.kind !== "immutable") uncovered.push(`dependency_resolution_${binding.dependencies.kind}`);
  const value: Omit<ResponsesInputTokenCountRequest, "id"> = {
    revision: RESPONSES_INPUT_TOKEN_COUNT_REVISION, binding, bindingDigest: digest(binding),
    generation: {body:wireBody, encoded:generation.encoded, digest:generation.digest},
    body, encoded: JSON.stringify(body), mappings, coverage: uncovered.length ? "partial" as const : "complete" as const,
    uncovered, dispatchBlock: binding.prefix.kind === "connection_memory" ? "connection_memory_not_countable" as const : null,
  };
  const request = copy({ ...value, id: digest(value) });
  verified.add(request);
  return request;
}

/** Cold recovery validates the retained mapping once; ordinary observation never re-encodes input. */
export function restoreResponsesInputTokenCount(value: ResponsesInputTokenCountRequest): ResponsesInputTokenCountRequest {
  if (verified.has(value)) return value;
  if (value.revision !== RESPONSES_INPUT_TOKEN_COUNT_REVISION) throw new NativeProtocolError("responses_count_revision_changed");
  const restored = prepareResponsesInputTokenCount({ prepared:value.generation, binding:value.binding });
  if (digest(value) !== digest(restored)) throw new NativeProtocolError("responses_count_request_corrupt");
  return restored;
}

export function responsesMeasurementInvalidation(request: ResponsesInputTokenCountRequest,
  current: ResponsesMeasurementApplicability): readonly string[] {
  request = restoreResponsesInputTokenCount(request);
  const reasons: string[] = [];
  if (digest(snapshotBinding(current.binding)) !== request.bindingDigest) reasons.push("binding_changed");
  if (current.generationDigest !== request.generation.digest) reasons.push("generation_changed");
  if (!current.authorized) reasons.push("authorization_unavailable");
  if (!current.dependenciesAvailable) reasons.push("dependency_unavailable");
  const now = date(current.now);
  const validity = request.binding.targetValidity;
  if (!validity) reasons.push("target_validity_unknown");
  else if (now >= date(validity.validUntil)) reasons.push("target_validity_expired");
  if (request.binding.dependencies.kind !== "immutable") reasons.push("dependency_resolution_unstable");
  return Object.freeze(reasons);
}

/** One attempt only. Retry/resource accounting belongs to the original measurement activity. */
export async function dispatchResponsesInputTokenCount(request: ResponsesInputTokenCountRequest,
  connection: { readonly baseUrl: string; readonly apiKey: string; readonly targetDigest: string;
    readonly organization?: string; readonly project?: string },
  options: NativeHttpOptions & { readonly applicability: ResponsesMeasurementApplicability }): Promise<NativeHttpObservation> {
  request = restoreResponsesInputTokenCount(request);
  options.signal.throwIfAborted();
  if (connection.targetDigest !== request.binding.targetDigest) throw new NativeProtocolError("responses_count_target_changed");
  // Uncertain coverage may be measured, but missing authority or changed bindings may never disclose data.
  const invalid = responsesMeasurementInvalidation(request, options.applicability)
    .filter(reason => !["target_validity_unknown", "target_validity_expired", "dependency_resolution_unstable"].includes(reason));
  if (invalid.length) throw new NativeProtocolError("responses_count_not_authorized", { reasons:invalid });
  if (request.dispatchBlock) throw new NativeProtocolError(request.dispatchBlock);
  const deadline = AbortSignal.timeout(30_000), connect = new AbortController();
  const signal = AbortSignal.any([options.signal, deadline, connect.signal]);
  const timer = setTimeout(() => connect.abort(new NativeProtocolError("responses_count_connection_timeout")), 15_000);
  timer.unref();
  const fetcher = options.fetch ?? globalThis.fetch;
  try {
    return await dispatchNativeHttp({ url:nativeHttpEndpoint(connection.baseUrl, "responses/input_tokens"),
      body:request.encoded, framing:"json", headers:{"content-type":"application/json", authorization:`Bearer ${connection.apiKey}`,
        ...(connection.organization ? {"OpenAI-Organization":connection.organization} : {}),
        ...(connection.project ? {"OpenAI-Project":connection.project} : {})} },
    { ...options, signal, fetch:async (url, init) => {
      try { return await fetcher(url, init); } finally { clearTimeout(timer); }
    } });
  } finally { clearTimeout(timer); }
}

function snapshotBinding(binding: ResponsesMeasurementBinding): ResponsesMeasurementBinding {
  for (const value of [binding.encodedInputId, binding.selectionDigest, binding.sourceDigest, binding.targetDigest,
    binding.dependencyDigest, binding.targetRevision, binding.scope.id, binding.scope.runId, binding.scope.recipient, binding.scope.purpose]) token(value);
  if (binding.targetValidity) { token(binding.targetValidity.basis); date(binding.targetValidity.validUntil); }
  if (binding.dependencies.kind === "immutable") token(binding.dependencies.basis);
  else if (["mutable", "unknown"].includes(binding.dependencies.kind)) token(binding.dependencies.reason);
  else throw new NativeProtocolError("responses_count_dependencies_invalid");
  const prefix = binding.prefix;
  if (prefix.kind === "persistent" || prefix.kind === "connection_memory") token(prefix.responseId);
  else if (prefix.kind !== "none") throw new NativeProtocolError("responses_count_prefix_invalid");
  if (prefix.kind === "persistent" && prefix.coverageDigest !== null) token(prefix.coverageDigest);
  digest(binding);
  return copy(binding);
}
function checkPrefix(body: JsonObject, prefix: ResponsesMeasurementBinding["prefix"]): void {
  const previous = body.previous_response_id ?? null;
  if (prefix.kind === "none" ? previous !== null : previous !== prefix.responseId)
    throw new NativeProtocolError("responses_count_prefix_mismatch");
}
export function responsesMeasurementDate(value: string): number { return date(value); }
function date(value: string): number {
  token(value);
  const time = Date.parse(value);
  if (!Number.isFinite(time)) throw new NativeProtocolError("responses_count_time_invalid");
  return time;
}
