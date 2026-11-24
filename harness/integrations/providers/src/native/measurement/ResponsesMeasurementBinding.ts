import { OPENAI_RESPONSES } from "@agent-anything/model-interaction/protocol";
import { OPENAI_RESPONSES_ADAPTER } from "../OpenAIResponses.js";
import { copy, digest, token, validateNativePreparedEncoding, NativeProtocolError } from "../NativeJson.js";
import { assertNativeInputManifest, nativeInputGroupDigest, nativeInputSettings, type NativeInputManifest } from "../input/NativeInputManifest.js";
import { resolveResponsesInputContinuity, responsesInputStore, validateResponsesInputGroups, type ResponsesInputRealization } from "../input/ResponsesInputRealization.js";
import { responsesMeasurementDate, type ResponsesMeasurementApplicability, type ResponsesMeasurementBinding } from "./ResponsesInputTokenCount.js";

export interface ResponsesMeasurementBindingInput {
  readonly manifest: NativeInputManifest;
  readonly realization: ResponsesInputRealization;
  /** Target fact validity, not the current authority/custody lease. Null preserves unknown validity. */
  readonly targetValidity: ResponsesMeasurementBinding["targetValidity"];
  readonly dependencies: {
    /** Content/rendering/predecessor dependency version, never an observation or lease revision. */
    readonly revision: string;
    readonly resolution: ResponsesMeasurementBinding["dependencies"];
  };
}
export interface ResponsesMeasurementCurrentConditions {
  readonly now: string;
  /** Includes current holds; an old lease cannot authorize a different custody snapshot. */
  readonly manifestDigest: string;
  readonly authority: {
    readonly authorized: boolean;
    readonly basis: string;
    readonly checkedAt: string;
    readonly validUntil: string | null;
  };
  readonly dependencies: {
    readonly available: boolean;
    readonly basis: string;
    readonly checkedAt: string;
    readonly validUntil: string | null;
  };
}
interface InputFacts {
  readonly scope: ResponsesMeasurementBinding["scope"];
  readonly selectionDigest: string;
  readonly sourceDigest: string;
  readonly targetDigest: string;
  readonly targetRevision: string;
  readonly continuationDigest: string;
  readonly prefix: ResponsesMeasurementBinding["prefix"];
  readonly generationDigest: string;
  readonly encodedDigest: string;
}
const factsByRealization = new WeakMap<ResponsesInputRealization, InputFacts>();
const frozenJson = new WeakSet<object>();

/** Native measurement binding construction, not authority, input selection or a count operation. */
export function buildResponsesMeasurementBinding(input: ResponsesMeasurementBindingInput): ResponsesMeasurementBinding {
  const facts = inputFacts(input.manifest, input.realization);
  token(input.dependencies.revision);
  const resolution = input.dependencies.resolution;
  if (resolution.kind === "immutable") token(resolution.basis);
  else if (resolution.kind === "mutable" || resolution.kind === "unknown") token(resolution.reason);
  else throw new NativeProtocolError("responses_measurement_resolution_invalid");
  if (input.targetValidity !== null) {
    token(input.targetValidity.basis);
    responsesMeasurementDate(input.targetValidity.validUntil);
  }
  const dependencyDigest = digest({continuation:facts.continuationDigest, revision:input.dependencies.revision, resolution});
  const identity = {revision:"responses.measurement.binding.2", scope:facts.scope, selection:facts.selectionDigest,
    sources:facts.sourceDigest, target:facts.targetDigest, dependencies:dependencyDigest,
    generation:facts.generationDigest, encoded:facts.encodedDigest};
  return copy({encodedInputId:digest(identity), scope:facts.scope, selectionDigest:facts.selectionDigest,
    sourceDigest:facts.sourceDigest, targetDigest:facts.targetDigest, dependencyDigest,
    targetRevision:facts.targetRevision, targetValidity:input.targetValidity, prefix:facts.prefix, dependencies:resolution});
}

/** Conditions are deliberately evaluated on every call, even for an immutable cached realization. */
export function responsesMeasurementApplicabilityFromRealization(input: ResponsesMeasurementBindingInput,
  current: ResponsesMeasurementCurrentConditions): ResponsesMeasurementApplicability {
  const binding = buildResponsesMeasurementBinding(input);
  if (current.manifestDigest !== input.manifest.digest) throw new NativeProtocolError("responses_measurement_conditions_scope_changed");
  const now = responsesMeasurementDate(current.now);
  const authorityValid = validCondition(current.authority, now), dependenciesValid = validCondition(current.dependencies, now);
  if (typeof current.authority.authorized !== "boolean" || typeof current.dependencies.available !== "boolean")
    throw new NativeProtocolError("responses_measurement_conditions_invalid");
  return Object.freeze({binding, generationDigest:inputFacts(input.manifest, input.realization).generationDigest,
    now:current.now, authorized:current.authority.authorized && authorityValid,
    dependenciesAvailable:current.dependencies.available && dependenciesValid});
}

function inputFacts(manifest: NativeInputManifest, realization: ResponsesInputRealization): InputFacts {
  if (manifest !== realization.manifest) {
    assertNativeInputManifest(manifest); assertNativeInputManifest(realization.manifest);
    if (manifest.digest !== realization.manifest.digest) throw new NativeProtocolError("responses_measurement_manifest_mismatch");
  }
  const retained = factsByRealization.get(realization);
  if (retained) return retained;
  assertNativeInputManifest(manifest);
  if (digest(manifest.protocol) !== digest(OPENAI_RESPONSES)) throw new NativeProtocolError("responses_measurement_protocol_mismatch");
  const plan = resolveResponsesInputContinuity(manifest, realization.continuity);
  if (Object.entries(plan).some(([field, value]) => digest(value) !== digest(realization[field as keyof typeof plan])))
    throw new NativeProtocolError("responses_measurement_continuity_mismatch");
  const {prepared, next} = realization, body = prepared.body;
  validateNativePreparedEncoding(prepared,"responses_measurement_body_changed");
  if (Object.hasOwn(body,"conversation")) throw new NativeProtocolError("responses_count_conversation_unsupported");
  if (digest(nativeInputSettings(body)) !== digest(manifest.settings)) throw new NativeProtocolError("responses_measurement_settings_mismatch");
  if (digest(next.scope) !== digest(manifest.scope) || digest(next.target) !== digest(manifest.target) || next.pending !== null ||
    !Number.isSafeInteger(next.generation) || next.generation < 1 || !Number.isSafeInteger(realization.expectedRevision) ||
    realization.expectedRevision < 0 || next.revision !== realization.expectedRevision + 1)
    throw new NativeProtocolError("responses_measurement_continuation_mismatch");
  if (!["replay","establish","extend","reestablish"].includes(realization.path) ||
    (realization.path === "replay" ? next.policy!=="native_replay" : !["persistent_chain","connection_memory"].includes(next.policy)) ||
    body.store !== responsesInputStore(realization.continuity)) throw new NativeProtocolError("responses_measurement_path_mismatch");
  const coverage = manifest.groups.map(group => ({id:group.id, digest:nativeInputGroupDigest(group)}));
  const count = realization.prefixGroups;
  if (!Number.isSafeInteger(count) || count < 0 || count > coverage.length) throw new NativeProtocolError("responses_measurement_prefix_mismatch");
  let prefix: ResponsesMeasurementBinding["prefix"] = {kind:"none"};
  if (realization.path === "extend") {
    const previous = next.response;
    if (!previous || !count || previous.id !== realization.predecessor || previous.id !== body.previous_response_id ||
      digest(previous.coverage) !== digest(coverage.slice(0,count))) throw new NativeProtocolError("responses_measurement_prefix_mismatch");
    token(previous.id); token(previous.observation); token(previous.replayDigest);
    prefix = next.policy==="connection_memory"?{kind:"connection_memory",responseId:previous.id}:{kind:"persistent",responseId:previous.id,coverageDigest:digest({scope:manifest.scope, target:manifest.target,
      generation:next.generation, responseId:previous.id, coverage:previous.coverage, replayDigest:previous.replayDigest})};
  } else if (count || realization.predecessor !== null || next.response !== null || body.previous_response_id != null) {
    throw new NativeProtocolError("responses_measurement_prefix_mismatch");
  }
  const sent = manifest.groups.slice(count);
  if (sent.some(group => group.replay !== "local") || digest(body.input) !== digest(sent.flatMap(group => group.items)))
    throw new NativeProtocolError("responses_measurement_selected_input_mismatch");
  const remotePrefixItems = manifest.groups.slice(0,count).reduce((sum,group) => sum + group.items.length,0);
  validateResponsesInputGroups(manifest.groups.flatMap(group => group.items),remotePrefixItems);
  const scope = {id:manifest.scope.id,runId:manifest.scope.runId,recipient:manifest.scope.recipientId,purpose:manifest.scope.purpose.id};
  const facts: InputFacts = copy({scope,
    // Selection records and judgments remain current acceptance evidence, not numerical input identity.
    selectionDigest:digest({protocol:manifest.protocol,scope:manifest.scope,boundary:manifest.selection.boundary,coverage}),
    sourceDigest:digest({groups:manifest.groups.map(({id,representation,sources,requires}) => ({id,representation,sources,requires})),
      settingSources:manifest.settingSources,adapter:OPENAI_RESPONSES_ADAPTER,catalog:prepared.catalog.revision,format:prepared.format?.binding ?? null}),
    targetDigest:digest(manifest.target),targetRevision:manifest.target.configuration,
    continuationDigest:digest({scope:manifest.scope,target:manifest.target,policy:next.policy,generation:next.generation,prefix}),
    prefix,generationDigest:prepared.digest,encodedDigest:digest(prepared.encoded)});
  // Cache only immutable native facts. Mutable caller/recovery objects are validated on every use.
  if (frozenFields(realization,["manifest","prepared","continuity",...Object.keys(plan)]) && immutableJson(realization.continuity) &&
    frozenFields(prepared,["body","encoded","digest","catalog","format"]) && immutableJson(realization.manifest) && immutableJson(next) &&
    immutableJson(body) && frozenFields(prepared.catalog,["revision"]) && (prepared.format === null || frozenFields(prepared.format,["binding"])))
    factsByRealization.set(realization,facts);
  return facts;
}
function validCondition(value: {readonly basis:string;readonly checkedAt:string;readonly validUntil:string|null}, now:number): boolean {
  token(value.basis);
  const checked = responsesMeasurementDate(value.checkedAt);
  if (value.validUntil === null) return false;
  const until = responsesMeasurementDate(value.validUntil);
  if (until <= checked) throw new NativeProtocolError("responses_measurement_validity_invalid");
  return checked <= now && now < until;
}
function immutableJson(value: unknown): boolean {
  if (value === null || typeof value !== "object") return true;
  if (frozenJson.has(value)) return true;
  if (!Object.isFrozen(value) || !Object.values(Object.getOwnPropertyDescriptors(value)).every(property =>
    Object.hasOwn(property,"value") && immutableJson(property.value))) return false;
  frozenJson.add(value);
  return true;
}
function frozenFields(value: object, fields: readonly string[]): boolean {
  return Object.isFrozen(value) && fields.every(field => Object.hasOwn(Object.getOwnPropertyDescriptor(value,field) ?? {},"value"));
}
