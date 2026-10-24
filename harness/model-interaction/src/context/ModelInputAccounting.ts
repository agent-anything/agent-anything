import { createHash } from "node:crypto";
import { snapshotJsonValue, type ModelJsonValue } from "../ModelInteractionContractValidation.js";
import type { ModelInputComposition } from "../input/ModelInput.js";
import type { ProviderUsage } from "../ProviderUsage.js";
import type { ModelContextCapacity, ModelInputMeasurement, ProviderRequestedOutput } from "./ModelContext.js";
import { allocateModelInput, type ModelInputAllocation } from "./ModelInputAllocation.js";

const POLICY = "model-input-planning.v1";
export interface ProviderInputAccounting {
  readonly evidence?: Readonly<Record<string, ModelJsonValue>>;
  readonly basis: Readonly<Record<string, ModelJsonValue>>;
  readonly inputUsage: "complete" | "unknown";
  readonly outputUsage: "complete" | "unknown";
  readonly defaultGenerationRoom: number | null;
  readonly limitations: readonly string[];
  project(composition: ModelInputComposition): ModelNativeInputFootprint;
}
export interface ModelNativeInputFootprint {
  readonly revision: "native-input-json-utf8.v1";
  readonly digest: string;
  readonly schemaDigest: string;
  readonly bytes: number;
  readonly bindingBytes: number;
  readonly conversationBytes: number;
  readonly framingBytes: number;
  readonly blockDigests: readonly string[];
}
export interface ModelInputUsageObservation {
  readonly id: string;
  readonly runId: string;
  readonly purpose: string;
  readonly requestId: string;
  readonly responseId: string | null;
  readonly basisKey: string;
  readonly seriesKey: string;
  readonly reportedIdentity: string | null;
  readonly footprint: ModelNativeInputFootprint;
  readonly inputTokens: number;
  readonly maximumGeneration: number | null;
  readonly maximumUnderestimate: number | null;
  readonly maximumGrowth: number | null;
  readonly growthPolicy: string;
  readonly prediction: number | null;
  readonly signedError: number | null;
  readonly absoluteError: number | null;
  readonly previousObservationId: string | null;
}
export interface ModelInputPlanning {
  readonly evidence: Readonly<Record<string, ModelJsonValue>>;
  readonly id: string;
  readonly revision: typeof POLICY;
  readonly requestId: string;
  readonly runId: string;
  readonly purpose: string;
  readonly basisKey: string;
  readonly basis: Readonly<Record<string, ModelJsonValue>>;
  readonly inputUsage: ProviderInputAccounting["inputUsage"];
  readonly outputUsage: ProviderInputAccounting["outputUsage"];
  readonly footprint: ModelNativeInputFootprint;
  readonly anchor: ModelInputUsageObservation | null;
  readonly excludedAnchor: { readonly id: string; readonly reason: string } | null;
  readonly measurement: ModelInputMeasurement;
  readonly capacity: ModelContextCapacity;
  readonly hardInputCeiling: number | null;
  readonly inputWindowAssessment: "proven_fit" | "proven_overflow" | "estimated_fit" | "estimated_overflow" | "unresolved";
  readonly generationRoom: number | null;
  readonly generationSource: "configured" | "service_default" | "accepted_usage" | "unspecified";
  readonly empiricalAllowance: number | null;
  readonly growthAllowance: number | null;
  readonly growthPolicy: string;
  readonly workingTarget: number | null;
  readonly releaseTarget: number | null;
  readonly allocation: ModelInputAllocation | null;
  readonly groupAttribution: {readonly method: "native-binding-and-source-byte-share"; readonly selectedMaterialFraction: number};
  readonly unchangedPrefixBlocks: number;
  readonly limitations: readonly string[];
}

/** Input-only native fields from the same encoder used for dispatch, never the transport envelope. */
export function createModelNativeInputFootprint(input: Readonly<Record<string, unknown>>): ModelNativeInputFootprint {
  const native = canonical(input);
  const messages = Array.isArray(input.messages) ? input.messages as Record<string, unknown>[] : [];
  const bindings: unknown[] = [];
  const conversation: unknown[] = [];
  for (const message of messages) (message.role === "system" || message.role === "developer" ? bindings : conversation).push(message);
  let bindingBytes = bindings.reduce<number>((sum, block) => sum + bytes(block), 0);
  let conversationBytes = conversation.reduce<number>((sum, block) => sum + bytes(block), 0);
  for (const key of ["tools", "response_format", "format", "system"]) if (input[key] !== undefined) {
    const field = {[key]: input[key]}; bindings.push(field); bindingBytes += bytes(field) - 2;
  }
  if (input.prompt !== undefined) {
    const field = {prompt: input.prompt}; conversation.push(field); conversationBytes += bytes(field) - 2;
  }
  // Component wrappers are an attribution proxy, not an additive token measurement.
  return Object.freeze({revision: "native-input-json-utf8.v1", digest: hash(native),
    schemaDigest: hash(canonical({tools: input.tools ?? null, response_format: input.response_format ?? null,
      format: input.format ?? null, system: input.system ?? null,
      instruction: messages.filter(message => message.role === "system" || message.role === "developer"),
      shape: Object.keys(input).sort()})), bytes: Buffer.byteLength(native, "utf8"), bindingBytes, conversationBytes,
    framingBytes: Buffer.byteLength(native, "utf8") - bindingBytes - conversationBytes,
    blockDigests: Object.freeze([...bindings, ...conversation].map(block => hash(canonical(block))))});
}

export function planModelInput(input: {
  readonly requestId: string; readonly runId: string; readonly purpose: string;
  readonly accounting: ProviderInputAccounting; readonly footprint: ModelNativeInputFootprint;
  readonly measurement: ModelInputMeasurement; readonly capacity: ModelContextCapacity;
  readonly previous: ModelInputUsageObservation | null; readonly growthPolicy: string;
  readonly sections?: ModelInputComposition["sections"];
  readonly requestedOutput?: ProviderRequestedOutput;
}): ModelInputPlanning {
  const basis = snapshotJsonValue(input.accounting.basis, "accounting.basis") as Readonly<Record<string, ModelJsonValue>>;
  const basisKey = hash(canonical({policy: POLICY, basis, schema: input.footprint.schemaDigest,
    inputUsage: input.accounting.inputUsage, outputUsage: input.accounting.outputUsage,
    defaultGenerationRoom: input.accounting.defaultGenerationRoom, capacity: input.capacity,
    requestedOutput: input.requestedOutput ?? null}));
  const previous = input.previous ? snapshotModelInputUsageObservation(input.previous) : null;
  const reason = previous === null ? null : previous.runId !== input.runId ? "different_run"
    : previous.purpose !== input.purpose ? "different_purpose" : previous.basisKey !== basisKey ? "accounting_basis_changed"
    : input.accounting.inputUsage !== "complete" ? "input_usage_scope_unknown" : null;
  const anchor = reason === null ? previous : null;
  let measurement = input.measurement;
  if (measurement.status === "unknown" && anchor && anchor.footprint.bytes > 0) {
    measurement = Object.freeze({status: "measured", amount: Math.ceil(anchor.inputTokens * input.footprint.bytes / anchor.footprint.bytes),
      estimator: {id: "accepted-usage-byte-delta", revision: POLICY, unit: "tokens" as const, accuracy: "estimated" as const},
      uncertainty: {kind: "unquantified" as const}, measuredCompositionId: input.requestId, measuredAt: input.measurement.measuredAt});
  }
  const generationRoom = input.requestedOutput?.maximum ?? input.accounting.defaultGenerationRoom ?? anchor?.maximumGeneration ?? null;
  const generationSource = input.requestedOutput?.maximum != null ? "configured"
    : input.accounting.defaultGenerationRoom !== null ? "service_default" : generationRoom !== null ? "accepted_usage" : "unspecified";
  const empiricalAllowance = anchor?.maximumUnderestimate ?? null;
  const growthAllowance = anchor?.growthPolicy === input.growthPolicy ? anchor.maximumGrowth : null;
  const ceiling = input.capacity.supported ? input.capacity.maximum : null;
  const inputWindowAssessment = ceiling === null || measurement.status === "unknown" ? "unresolved"
    : measurement.estimator.accuracy === "exact" ? measurement.amount <= ceiling ? "proven_fit" : "proven_overflow"
    : measurement.estimator.accuracy === "upper_bound" ? measurement.amount <= ceiling ? "proven_fit" : "unresolved"
    : measurement.amount <= ceiling ? "estimated_fit" : "estimated_overflow";
  const workingTarget = ceiling === null ? null : Math.max(0, ceiling -
    (input.capacity.supported && input.capacity.semantics === "input_and_output" ? generationRoom ?? 0 : 0) -
    (measurement.status === "measured" && measurement.estimator.accuracy === "estimated" ? empiricalAllowance ?? 0 : 0));
  const releaseTarget = workingTarget === null ? null : Math.max(0, workingTarget - (growthAllowance ?? 0));
  // Exact-only working views retain every occurrence. A measured whole cost may be attributed
  // proportionally for planning; those group estimates are never native component counts.
  const amount = measurement.status === "measured" ? measurement.amount : null;
  const bindingShare = input.footprint.bindingBytes / Math.max(1, input.footprint.bindingBytes + input.footprint.conversationBytes);
  const sourceBytes = (input.sections ?? []).filter(section => section.role !== "instruction")
    .map(section => ({bytes: bytes(section.content), material: section.provenance?.purpose === "selected_material"}));
  const selectedMaterialFraction = sourceBytes.filter(value => value.material).reduce((sum, value) => sum + value.bytes, 0) /
    Math.max(1, sourceBytes.reduce((sum, value) => sum + value.bytes, 0));
  const conversationAmount = amount === null ? 0 : amount * (1 - bindingShare);
  const allocation = amount === null ? null : allocateModelInput([
    {id: "bindings", group: "request_bindings", forms: [{id: "exact", cost: amount * bindingShare, requires: []}]},
    {id: "conversation", group: "working_conversation", forms: [{id: "exact", cost: conversationAmount * (1 - selectedMaterialFraction), requires: []}]},
    {id: "material", group: "selected_material", forms: [{id: "exact", cost: conversationAmount * selectedMaterialFraction, requires: []}]},
  ], {target: releaseTarget});
  let unchangedPrefixBlocks = 0;
  if (anchor) while (unchangedPrefixBlocks < input.footprint.blockDigests.length &&
    input.footprint.blockDigests[unchangedPrefixBlocks] === anchor.footprint.blockDigests[unchangedPrefixBlocks]) unchangedPrefixBlocks++;
  return seal({revision: POLICY, requestId: input.requestId, runId: input.runId, purpose: input.purpose, basisKey, basis,
    evidence: input.accounting.evidence ?? {},
    inputUsage: input.accounting.inputUsage, outputUsage: input.accounting.outputUsage, footprint: input.footprint, anchor,
    excludedAnchor: reason && previous ? {id: previous.id, reason} : null, measurement, capacity: input.capacity,
    hardInputCeiling: ceiling, inputWindowAssessment, generationRoom, generationSource, empiricalAllowance, growthAllowance, growthPolicy: input.growthPolicy,
    workingTarget, releaseTarget, allocation, groupAttribution: {method: "native-binding-and-source-byte-share", selectedMaterialFraction}, unchangedPrefixBlocks,
    limitations: [...input.accounting.limitations, ...(anchor === null ? ["no_compatible_accepted_anchor"] : ["empirical_not_a_bound"]),
      ...(generationRoom === null ? ["generation_room_unspecified"] : []),
      ...(empiricalAllowance === null ? ["prediction_error_unsampled"] : []),
      ...(growthAllowance === null ? ["future_growth_unspecified"] : []), "component_attribution_not_native_count",
      "native_template_overhead_not_independently_measured", ...(allocation?.limitations ?? [])]}) as ModelInputPlanning;
}

/** Called only for a response that will be attached to an accepted Controller exchange. */
export function observeModelInputUsage(planning: ModelInputPlanning, usage: ProviderUsage | null,
  responseId: string | null, complete: boolean): ModelInputUsageObservation | null {
  if (!complete || planning.inputUsage !== "complete" || !usage?.inputTokens || planning.footprint.bytes <= 0 ||
      usage.metadata.accountingConsistent === false || usage.metadata.inputTruncated === true) return null;
  const reportedIdentity = typeof usage.metadata.reportedIdentity === "string" ? usage.metadata.reportedIdentity : null;
  const compatible = !planning.anchor || planning.anchor.reportedIdentity === reportedIdentity;
  const previous = compatible ? planning.anchor : null;
  const prediction = compatible && planning.measurement.status === "measured" && planning.measurement.estimator.accuracy === "estimated"
    ? planning.measurement.amount : null;
  const signedError = prediction === null ? null : usage.inputTokens - prediction;
  const maximum = (a: number | null, b: number | null) => a === null ? b : b === null ? a : Math.max(a, b);
  const growth = previous?.growthPolicy === planning.growthPolicy ? Math.max(0, usage.inputTokens - previous.inputTokens) : null;
  return seal({runId: planning.runId, purpose: planning.purpose, requestId: planning.requestId, responseId,
    basisKey: planning.basisKey, seriesKey: hash(canonical({basis: planning.basisKey, reportedIdentity})), reportedIdentity,
    footprint: planning.footprint, inputTokens: usage.inputTokens,
    maximumGeneration: maximum(previous?.maximumGeneration ?? null, planning.outputUsage === "complete" ? usage.outputTokens : null),
    maximumUnderestimate: maximum(previous?.maximumUnderestimate ?? null, signedError === null ? null : Math.max(0, signedError)),
    maximumGrowth: maximum(previous?.growthPolicy === planning.growthPolicy ? previous.maximumGrowth : null, growth),
    growthPolicy: planning.growthPolicy, prediction, signedError, absoluteError: signedError === null ? null : Math.abs(signedError),
    previousObservationId: previous?.id ?? null}) as ModelInputUsageObservation;
}

export function snapshotModelInputUsageObservation(input: ModelInputUsageObservation): ModelInputUsageObservation {
  verify(input);
  if (!input.runId || !input.purpose || !input.requestId || !Number.isSafeInteger(input.inputTokens) || input.inputTokens <= 0 ||
      !Number.isSafeInteger(input.footprint.bytes) || input.footprint.bytes <= 0) throw new TypeError("Invalid accepted input usage observation.");
  return snapshotJsonValue(input, "inputUsageObservation") as unknown as ModelInputUsageObservation;
}
export function snapshotModelInputPlanning(input: ModelInputPlanning): ModelInputPlanning {
  verify(input);
  if (input.revision !== POLICY || input.measurement.measuredCompositionId !== input.requestId) throw new TypeError("Invalid input planning basis.");
  if (input.anchor) snapshotModelInputUsageObservation(input.anchor);
  return snapshotJsonValue(input, "inputPlanning") as unknown as ModelInputPlanning;
}

function seal<T extends object>(value: T): T & {readonly id: string} {
  return snapshotJsonValue({id: hash(canonical(value)), ...value}, "accounting") as unknown as T & {readonly id: string};
}
function verify(value: {readonly id: string}): void {
  const {id, ...basis} = value;
  if (id !== hash(canonical(basis))) throw new TypeError("Model input accounting identity mismatch.");
}
function bytes(value: unknown): number { return Buffer.byteLength(canonical(value), "utf8"); }
function hash(value: string): string { return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`; }
function canonical(value: unknown): string {
  const sort = (value: unknown): unknown => Array.isArray(value) ? value.map(sort) : value !== null && typeof value === "object"
    ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b, "en")).map(([key, item]) => [key, sort(item)])) : value;
  return JSON.stringify(sort(snapshotJsonValue(value, "nativeInput")));
}
