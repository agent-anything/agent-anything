import { copy, digest, json, object, token, NativeProtocolError, type JsonObject } from "../NativeJson.js";
import type { NativeHttpObservation } from "../NativeHttp.js";
import { restoreResponsesInputTokenCount, responsesMeasurementDate, responsesMeasurementInvalidation,
  type ResponsesInputTokenCountRequest, type ResponsesMeasurementApplicability } from "./ResponsesInputTokenCount.js";

export type ResponsesCountUnknownReason = "endpoint_unsupported" | "transport_failure" | "cancelled" |
  "outcome_unknown" | "invalid_response" | "service_unavailable" | "connection_memory_not_countable" | "resource_unavailable";
export type ResponsesCountRefusal = "authentication" | "authorization" | "rate_limited" | "overflow" |
  "dependency_unavailable" | "invalid_request" | "other";
interface CountEvidenceBase {
  readonly id: string;
  readonly requestId: string;
  readonly operationId: string;
  readonly measuredAt: string;
  readonly observation: NativeHttpObservation | null;
  readonly raw: JsonObject | null;
}
export type ResponsesCountEvidence = CountEvidenceBase & (
  | { readonly status: "measured"; readonly inputTokens: number; readonly coverage: "complete" | "partial";
      readonly uncovered: readonly string[]; readonly precision: "exact_for_count_payload" }
  | { readonly status: "refused"; readonly category: ResponsesCountRefusal; readonly errorCode: string | null;
      readonly errorParameter: string | null }
  | { readonly status: "unknown"; readonly reason: ResponsesCountUnknownReason; readonly basis: string }
);
const verified = new WeakSet<ResponsesCountEvidence>();

export function interpretResponsesInputTokenCount(request: ResponsesInputTokenCountRequest,
  observation: NativeHttpObservation, operation: { readonly operationId: string; readonly measuredAt: string }): ResponsesCountEvidence {
  request = restoreResponsesInputTokenCount(request);
  token(operation.operationId); responsesMeasurementDate(operation.measuredAt);
  const base = { requestId:request.id, operationId:operation.operationId, measuredAt:operation.measuredAt, observation, raw:null as JsonObject | null };
  try { base.raw = object(json(observation.body)); } catch { /* Preserve the original failed observation below. */ }
  const raw = base.raw;
  if (!Number.isSafeInteger(observation.status) || observation.status < 100 || observation.status > 599)
    throw new NativeProtocolError("responses_count_http_status_invalid");
  if (observation.status >= 200 && observation.status < 300) {
    if (request.dispatchBlock || observation.frames.length || raw?.object !== "response.input_tokens" ||
      !Number.isSafeInteger(raw.input_tokens) || Number(raw.input_tokens) < 0 || raw.error != null)
      return retain({ ...base, status:"unknown", reason:"invalid_response", basis:"count_response_schema_mismatch" });
    return retain({ ...base, status:"measured", inputTokens:Number(raw.input_tokens), coverage:request.coverage,
      uncovered:request.uncovered, precision:"exact_for_count_payload" });
  }
  if (observation.status >= 500 || observation.status < 400)
    return retain({ ...base, status:"unknown", reason:"service_unavailable", basis:`http_status:${observation.status}` });
  const error = raw?.error && typeof raw.error === "object" && !Array.isArray(raw.error) ? raw.error as JsonObject : null;
  const code = typeof error?.code === "string" ? error.code : null;
  const parameter = typeof error?.param === "string" ? error.param : null;
  const status = observation.status;
  // HTTP 400/404 alone cannot prove overflow or an unsupported counting endpoint.
  const category: ResponsesCountRefusal = status === 401 ? "authentication" : status === 403 ? "authorization" :
    status === 429 ? "rate_limited" : code === "context_length_exceeded" ? "overflow" :
    status === 404 && (parameter === "previous_response_id" || parameter?.includes("file_id")) ? "dependency_unavailable" :
    status === 400 || status === 422 ? "invalid_request" : "other";
  return retain({ ...base, status:"refused", category, errorCode:code, errorParameter:parameter });
}

/** Capability evidence or a failed attempt, never a fabricated count of zero. */
export function unknownResponsesInputTokenCount(request: ResponsesInputTokenCountRequest, input: {
  readonly operationId: string; readonly measuredAt: string; readonly reason: ResponsesCountUnknownReason; readonly basis: string;
}): ResponsesCountEvidence {
  request = restoreResponsesInputTokenCount(request);
  token(input.operationId); token(input.basis); responsesMeasurementDate(input.measuredAt);
  if (!["endpoint_unsupported", "transport_failure", "cancelled", "outcome_unknown", "invalid_response", "service_unavailable", "connection_memory_not_countable", "resource_unavailable"].includes(input.reason))
    throw new NativeProtocolError("responses_count_unknown_reason_invalid");
  return retain({ requestId:request.id, operationId:input.operationId, measuredAt:input.measuredAt,
    reason:input.reason, basis:input.basis, status:"unknown", observation:null, raw:null });
}

/** Restore retained evidence without a POST or dependence on Inspector availability. */
export function restoreResponsesCountEvidence(request: ResponsesInputTokenCountRequest, evidence: ResponsesCountEvidence): ResponsesCountEvidence {
  request = restoreResponsesInputTokenCount(request);
  if (evidence.requestId !== request.id) throw new NativeProtocolError("responses_count_evidence_binding_changed");
  if (verified.has(evidence)) return evidence;
  const restored = evidence.observation ? interpretResponsesInputTokenCount(request, evidence.observation,
    {operationId:evidence.operationId, measuredAt:evidence.measuredAt}) : evidence.status === "unknown" ?
    unknownResponsesInputTokenCount(request, evidence) : null;
  if (!restored || digest(restored) !== digest(evidence)) throw new NativeProtocolError("responses_count_evidence_corrupt");
  return restored;
}

export function reuseResponsesInputTokenCount(request: ResponsesInputTokenCountRequest, evidence: ResponsesCountEvidence,
  current: ResponsesMeasurementApplicability): { readonly reusable: boolean; readonly reasons: readonly string[];
    readonly evidence: ResponsesCountEvidence } {
  request = restoreResponsesInputTokenCount(request);
  evidence = restoreResponsesCountEvidence(request, evidence);
  const reasons = [...responsesMeasurementInvalidation(request, current)];
  if (evidence.status !== "measured") reasons.push(`count_${evidence.status}`);
  if (responsesMeasurementDate(current.now) < responsesMeasurementDate(evidence.measuredAt)) reasons.push("measurement_from_future");
  if (request.binding.prefix.kind === "persistent" && !request.binding.prefix.coverageDigest)
    reasons.push("remote_prefix_coverage_unknown");
  return Object.freeze({ reusable:reasons.length === 0, reasons:Object.freeze(reasons), evidence });
}

function retain(value: Omit<CountEvidenceBase, "id"> & (
  | Omit<Extract<ResponsesCountEvidence, {status:"measured"}>, keyof CountEvidenceBase>
  | Omit<Extract<ResponsesCountEvidence, {status:"refused"}>, keyof CountEvidenceBase>
  | Omit<Extract<ResponsesCountEvidence, {status:"unknown"}>, keyof CountEvidenceBase>
)): ResponsesCountEvidence {
  const evidence = copy({ ...value, id:digest(value) }) as ResponsesCountEvidence;
  verified.add(evidence);
  return evidence;
}
