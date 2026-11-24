import { OPENAI_RESPONSES } from "@agent-anything/model-interaction/protocol";
import { prepareResponses, mapResponsesReplay, type ResponsesPreparation } from "../OpenAIResponses.js";
import { copy, digest, object, list, token, NativeProtocolError, type JsonObject } from "../NativeJson.js";
import { assertNativeInputManifest, nativeInputCoverage, nativeInputGroupDigest, nativeInputSettings, type NativeInputManifest, type NativeInputScope } from "./NativeInputManifest.js";

export type ResponsesContinuityPolicy = "native_replay" | "persistent_chain" | "connection_memory";
export interface ResponsesContinuation {
  readonly scope: NativeInputScope;
  readonly target: NativeInputManifest["target"];
  readonly revision: number;
  readonly policy: ResponsesContinuityPolicy;
  readonly generation: number;
  readonly response: null | {
    readonly id: string;
    readonly coverage: readonly { readonly id: string; readonly digest: string }[];
    readonly observation: string;
    readonly replayDigest: string;
  };
  readonly pending: null | { readonly operationId: string; readonly inputDigest: string };
  readonly connectionIncarnation?:string;
}
export interface ResponsesInputConditions {
  readonly basis: string;
  readonly authorized: boolean;
  readonly disclosureRevision: string;
  readonly remoteStorage: boolean;
  readonly storeResponse?: boolean;
  readonly targetSupport: "established" | "unknown" | "unsupported";
  readonly predecessor: "available" | "unavailable" | "unknown";
  readonly reestablish: boolean;
  readonly policyChange: boolean;
  readonly connectionMemory?:boolean;
  readonly connectionIncarnation?:string;
}
export interface ResponsesInputContinuity {
  readonly policy: ResponsesContinuityPolicy;
  readonly previous: ResponsesContinuation | null;
  readonly conditions: ResponsesInputConditions;
}
export interface ResponsesInputPlan {
  readonly path: "replay" | "establish" | "extend" | "reestablish";
  readonly reason: string;
  readonly predecessor: string | null;
  readonly prefixGroups: number;
  readonly expectedRevision: number;
  readonly next: ResponsesContinuation;
  readonly conditionBasis: string;
}
export interface ResponsesInputRealization extends ResponsesInputPlan {
  readonly manifest: NativeInputManifest;
  readonly prepared: ResponsesPreparation;
  readonly continuity: ResponsesInputContinuity;
}

/** Native path choice implements accepted selection; it never chooses a different representation. */
export function realizeResponsesInput(input: {
  readonly manifest: NativeInputManifest;
  readonly request: Omit<Parameters<typeof prepareResponses>[0], "input" | "store" | "previous_response_id">;
  readonly policy: ResponsesContinuityPolicy;
  readonly previous: ResponsesContinuation | null;
  readonly conditions: ResponsesInputConditions;
}): ResponsesInputRealization {
  const { manifest, previous, conditions, policy } = input, continuity = copy({ previous, conditions, policy });
  const plan = resolveResponsesInputContinuity(manifest, continuity);
  const prepared = prepareResponses({ ...input.request, input: manifest.groups.slice(plan.prefixGroups).flatMap(g => g.items), store: responsesInputStore(continuity),
    ...(plan.predecessor ? { previous_response_id: plan.predecessor } : {}) });
  if (digest(nativeInputSettings(prepared.body)) !== digest(manifest.settings)) throw new NativeProtocolError("responses_current_settings_changed");
  return Object.freeze({ manifest, prepared, ...plan, continuity });
}

/** Revalidates original native coverage at preparation, handoff and recovery without re-encoding a request. */
export function resolveResponsesInputContinuity(manifest: NativeInputManifest, continuity: ResponsesInputContinuity): ResponsesInputPlan {
  const { previous, conditions, policy } = continuity;
  assertNativeInputManifest(manifest);
  if (digest(manifest.protocol) !== digest(OPENAI_RESPONSES)) throw new NativeProtocolError("responses_input_protocol_mismatch");
  token(conditions.basis);
  if (!["native_replay", "persistent_chain","connection_memory"].includes(policy) || !["available", "unavailable", "unknown"].includes(conditions.predecessor))
    throw new NativeProtocolError("responses_continuity_policy_invalid");
  if (conditions.authorized !== true || conditions.disclosureRevision !== manifest.target.disclosure)
    throw new NativeProtocolError("responses_input_authority_changed");
  if (conditions.targetSupport !== "established") throw new NativeProtocolError("responses_input_support_unestablished");
  if (policy === "persistent_chain" && !conditions.remoteStorage) throw new NativeProtocolError("responses_storage_not_authorized");
  const store=responsesInputStore(continuity);
  if (store&&!conditions.remoteStorage||policy==="persistent_chain"&&!store) throw new NativeProtocolError("responses_storage_not_authorized");
  if(policy==="connection_memory"){
    if(conditions.connectionMemory!==true||!conditions.connectionIncarnation||manifest.settings.stream!==undefined||manifest.settings.background!==undefined)
      throw new NativeProtocolError("responses_connection_memory_not_authorized");
    token(conditions.connectionIncarnation);
  }
  if (previous) {
    validateContinuation(previous);
    if (digest(previous.scope) !== digest(manifest.scope) || digest(stableTarget(previous.target)) !== digest(stableTarget(manifest.target)))
      throw new NativeProtocolError("responses_continuation_scope_changed");
    if (previous.pending) throw new NativeProtocolError("responses_generation_unresolved");
    if (previous.policy !== policy && !conditions.policyChange) throw new NativeProtocolError("responses_policy_change_not_accepted");
  }
  const coverage = nativeInputCoverage(manifest), prior = previous?.response;
  for (let i = 0; i < manifest.groups.length; i++) {
    const group = manifest.groups[i];
    // Reasoning requires its original ordered prefix, not an unordered dependency set.
    if (group.items.some(item => item.type === "reasoning") && (group.requires.length !== i ||
      group.requires.some((required, index) => digest(required) !== digest(coverage[index]))))
      throw new NativeProtocolError("responses_reasoning_prefix_basis_missing");
  }
  const matches = prior && previous?.target.disclosure === manifest.target.disclosure && prior.coverage.length <= coverage.length && prior.coverage.every((v, i) => digest(v) === digest(coverage[i]));
  let path: ResponsesInputRealization["path"] = policy === "native_replay" ? "replay" : "establish";
  let reason = policy === "native_replay" ? "explicit_native_replay" : "initial_generation";
  const sameConnection=policy!=="connection_memory"||previous?.connectionIncarnation===conditions.connectionIncarnation;
  if (policy !== "native_replay" && previous && prior) {
    if (previous.policy === policy && matches && sameConnection && conditions.predecessor === "available") { path = "extend"; reason = "selected_prefix_matches"; }
    else {
      if (conditions.predecessor === "unknown" && matches && sameConnection && previous.policy === policy)
        throw new NativeProtocolError("responses_predecessor_unreconciled");
      if (!conditions.reestablish) throw new NativeProtocolError("responses_reestablishment_not_accepted");
      path = "reestablish";
      reason = previous.policy !== policy ? "accepted_policy_change" : !sameConnection?"connection_memory_lost":!matches ? "selected_prefix_changed" : "predecessor_unavailable";
    }
  }
  const prefixGroups = path === "extend" ? prior!.coverage.length : 0;
  const sent = manifest.groups.slice(prefixGroups);
  if (sent.some(g => g.replay !== "local")) throw new NativeProtocolError("responses_replay_material_unavailable");
  validateResponsesInputGroups(manifest.groups.flatMap(g => g.items), manifest.groups.slice(0, prefixGroups).reduce((n, g) => n + g.items.length, 0));
  const next: ResponsesContinuation = { scope: manifest.scope, target: manifest.target, policy, revision: (previous?.revision ?? 0) + 1,
    generation: path === "extend" ? previous!.generation : (previous?.generation ?? 0) + 1,
    response: path === "extend" ? prior! : null, pending: null,...(policy==="connection_memory"?{connectionIncarnation:conditions.connectionIncarnation}:{} ) };
  return copy({ path, reason, predecessor: path === "extend" ? prior!.id : null, prefixGroups,
    expectedRevision: previous?.revision ?? 0, next: copy(next), conditionBasis: conditions.basis });
}

export function reserveResponsesInput(realization: ResponsesInputRealization, operationId: string): ResponsesContinuation {
  token(operationId); assertNativeInputManifest(realization.manifest);
  return copy({ ...realization.next, pending: { operationId, inputDigest: realization.manifest.digest } });
}

/** Accepted observation advances only its original sequence, never a Child or auxiliary cursor. */
export function acceptResponsesContinuation(input: {
  readonly pending: ResponsesContinuation;
  readonly manifest: NativeInputManifest;
  readonly operationId: string;
  readonly response: JsonObject;
  readonly observation: string;
  readonly outputGroup: import("./NativeInputManifest.js").NativeInputGroup | null;
}): ResponsesContinuation {
  const { pending, manifest, response } = input;
  validateContinuation(pending); assertNativeInputManifest(manifest); token(input.observation);
  if (pending.pending?.operationId !== input.operationId || pending.pending.inputDigest !== manifest.digest ||
    digest(pending.scope) !== digest(manifest.scope) || digest(pending.target) !== digest(manifest.target))
    throw new NativeProtocolError("responses_acceptance_original_mismatch");
  const replay = mapResponsesReplay(response);
  if (input.outputGroup === null ? replay.items.length !== 0 :
    digest(replay.items) !== digest(input.outputGroup.items) || !input.outputGroup.sources.includes(input.observation))
    throw new NativeProtocolError("responses_output_coverage_mismatch");
  if (input.outputGroup && manifest.groups.some(g => g.id === input.outputGroup!.id)) throw new NativeProtocolError("responses_output_group_duplicate");
  return copy({ ...pending, revision: pending.revision + 1, pending: null,
    response: { id: token(response.id), observation: input.observation, replayDigest: digest(replay.items),
      coverage: [...nativeInputCoverage(manifest), ...(input.outputGroup ? [{ id: input.outputGroup.id, digest: nativeInputGroupDigest(input.outputGroup) }] : [])] } });
}

export function responsesOutputGroup(input: {
  readonly manifest: NativeInputManifest; readonly response: JsonObject; readonly observation: string;
  readonly id: string; readonly representation: import("@agent-anything/model-interaction/protocol").ProtocolRevisionRef;
  readonly holds: readonly string[];
}): import("./NativeInputManifest.js").NativeInputGroup | null {
  assertNativeInputManifest(input.manifest);
  const items = mapResponsesReplay(input.response).items;
  if (!items.length) return null;
  return copy({ id: input.id, representation: input.representation, sources: [input.observation], holds: input.holds,
    deliveries: [], replay: items.some(item => item.type === "reasoning" && !item.encrypted_content) ? "remote_only" : "local",
    items, requires: items.some(item => item.type === "reasoning") ? nativeInputCoverage(input.manifest) : [] });
}

export function reconcileResponsesNotGenerated(pending: ResponsesContinuation, operationId: string,
  evidence: { readonly disposition: "proven_unsent" | "rejected_without_generation"; readonly source: string }): ResponsesContinuation {
  validateContinuation(pending); token(evidence.source);
  if (pending.pending?.operationId !== operationId || !["proven_unsent", "rejected_without_generation"].includes(evidence.disposition))
    throw new NativeProtocolError("responses_generation_reconciliation_invalid");
  return copy({ ...pending, revision: pending.revision + 1, pending: null });
}

function validateContinuation(value: ResponsesContinuation): void {
  object(value); const scope = object(value.scope), purpose = object(scope.purpose), target = object(value.target);
  for (const v of [scope.id, scope.runId, scope.recipientId, scope.compositionDigest, purpose.id, purpose.revision,
    target.model, target.configuration, target.connection, target.disclosure]) token(v);
  if (!Number.isSafeInteger(value.revision) || value.revision < 1 || !Number.isSafeInteger(value.generation) || value.generation < 1 ||
    !["native_replay", "persistent_chain","connection_memory"].includes(value.policy)) throw new NativeProtocolError("responses_continuation_invalid");
  if(value.policy==="connection_memory")token(value.connectionIncarnation);
  if (value.response) {
    object(value.response); list(value.response.coverage);
    token(value.response.id); token(value.response.observation); token(value.response.replayDigest);
    if (new Set(value.response.coverage.map(v => v.id)).size !== value.response.coverage.length) throw new NativeProtocolError("responses_coverage_duplicate");
    value.response.coverage.forEach(v => { token(v.id); token(v.digest); });
  }
  if (value.pending !== null) { const pending = object(value.pending); token(pending.operationId); token(pending.inputDigest); }
  if (value.response === undefined) throw new NativeProtocolError("responses_continuation_invalid");
}

export function restoreResponsesContinuation(value: unknown): ResponsesContinuation {
  const candidate = object(value) as unknown as ResponsesContinuation;
  validateContinuation(candidate);
  return copy(candidate);
}
export function responsesInputStore(continuity:ResponsesInputContinuity):boolean {
  const value=continuity.conditions.storeResponse??(continuity.policy==="persistent_chain");
  if(typeof value!=="boolean")throw new NativeProtocolError("responses_storage_choice_invalid");
  return value;
}
function stableTarget(target: NativeInputManifest["target"]) {
  const { disclosure: _, ...stable } = target;
  return stable;
}

/** Checks recorded native call relationships, not semantic success or scheduling intent. */
export function validateResponsesInputGroups(items: readonly JsonObject[], remotePrefixItems = 0): void {
  if (!Number.isSafeInteger(remotePrefixItems) || remotePrefixItems < 0 || remotePrefixItems > items.length)
    throw new NativeProtocolError("responses_remote_coverage_invalid");
  const pending = new Set<string>(), seen = new Set<string>();
  for (const [index, raw] of items.entries()) {
    const item = object(raw);
    if (item.type === "function_call") {
      const id = token(item.call_id); if (seen.has(id)) throw new NativeProtocolError("responses_history_call_duplicate");
      token(item.name); if (typeof item.arguments !== "string") throw new NativeProtocolError("responses_history_arguments_invalid");
      seen.add(id); pending.add(id);
    } else if (item.type === "function_call_output") {
      const id = token(item.call_id); if (!pending.delete(id)) throw new NativeProtocolError("responses_history_result_unmatched");
      if (typeof item.output !== "string" && !Array.isArray(item.output)) throw new NativeProtocolError("responses_history_result_invalid");
    } else if (item.type === "reasoning" || item.type === "compaction") {
      if (index >= remotePrefixItems && (typeof item.encrypted_content !== "string" || !item.encrypted_content))
        throw new NativeProtocolError("responses_opaque_replay_unavailable");
    } else if (item.type === "message" || item.type === undefined && typeof item.role === "string") {
      if (pending.size && item.role !== "assistant") throw new NativeProtocolError("responses_history_exchange_incomplete");
      if (!["system", "developer", "user", "assistant"].includes(String(item.role))) throw new NativeProtocolError("responses_history_role_invalid");
    } else throw new NativeProtocolError("responses_history_item_unsupported", { type: item.type });
  }
  if (pending.size) throw new NativeProtocolError("responses_history_exchange_incomplete");
}
