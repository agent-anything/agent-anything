import { describe, expect, it } from "vitest";
import { OPENAI_RESPONSES, DEEPSEEK_CHAT_COMPLETIONS, OLLAMA_CHAT } from "@agent-anything/model-interaction/protocol";
import { prepareResponses } from "../OpenAIResponses.js";
import { prepareDeepSeekChat } from "../DeepSeekChatCompletions.js";
import { prepareOllamaChat } from "../OllamaChat.js";
import { digest, type JsonObject } from "../NativeJson.js";
import { bindNativeInputManifest, nativeInputGroupDigest, nativeInputSettings, type NativeInputGroup, type NativeInputManifest } from "./NativeInputManifest.js";
import { realizeResponsesInput, resolveResponsesInputContinuity, reserveResponsesInput, acceptResponsesContinuation, reconcileResponsesNotGenerated, responsesOutputGroup, type ResponsesContinuation } from "./ResponsesInputRealization.js";
import { realizeDeepSeekChatInput, realizeOllamaChatInput } from "./ChatInputRealization.js";

const purpose = { id: "task", revision: "1" }, request = { model: "fixture", purpose, stream: false };
const conditions = { basis: "current-authority", authorized: true, disclosureRevision: "d1", remoteStorage: true,
  targetSupport: "established" as const, predecessor: "available" as const, reestablish: true, policyChange: false };
function group(id: string, items: readonly JsonObject[]): NativeInputGroup {
  return { id, representation: { id: `rep:${id}`, revision: "1" }, sources: [id], holds: [`hold:${id}`], deliveries: [], requires: [], items, replay: "local" };
}
const user = group("u1", [{ role: "user", content: "Please inspect the files; do not edit." }]);
const output = group("r1", [{ id: "msg1", type: "message", role: "assistant", phase: "commentary", content: [{ type: "output_text", text: "Found two files." }] }]);
function manifest(groups: readonly NativeInputGroup[] = [user], settings = nativeInputSettings(prepareResponses({ ...request, input: [], store: true }).body), protocol = OPENAI_RESPONSES): NativeInputManifest {
  return bindNativeInputManifest({ protocol, scope: { id: "root-task", runId: "root", recipientId: "root", purpose, compositionDigest: digest("composition") },
    target: { model: "fixture", configuration: "cfg:1", connection: "connection:1", disclosure: "d1" },
    selection: { id: "selection", revision: "1", boundary: "delivery:3", judgments: ["preservation:1"] }, groups, settings,
    settingSources: Object.keys(settings).map(field => ({ field, source: `configured:${field}`, digest: digest(settings[field]) })) });
}
function realize(m = manifest(), previous: ResponsesContinuation | null = null, cond = conditions) {
  return realizeResponsesInput({ manifest: m, request, policy: "persistent_chain", previous, conditions: cond });
}
function head() {
  const first = realize(), pending = reserveResponsesInput(first, "create1");
  return acceptResponsesContinuation({ pending, manifest: first.manifest, operationId: "create1", observation: "r1", outputGroup: output,
    response: { id: "resp1", object: "response", status: "completed", output: output.items } });
}

describe("native complete input and Responses continuity", () => {
  it("keeps connection memory scoped to its original carrier and requires explicit re-establishment after loss",()=>{
    const req={...request,stream:true,transport:"websocket" as const},settings=nativeInputSettings(prepareResponses({...req,input:[],store:false}).body);
    const current={...conditions,remoteStorage:false,connectionMemory:true,connectionIncarnation:"socket-1"};
    const first=realizeResponsesInput({manifest:manifest([user],settings),request:req,policy:"connection_memory",previous:null,conditions:current});
    const previous=acceptResponsesContinuation({pending:reserveResponsesInput(first,"create1"),manifest:first.manifest,operationId:"create1",observation:"r1",outputGroup:output,
      response:{id:"resp1",object:"response",status:"completed",output:output.items}});
    const selected=manifest([user,output,group("u2",[{role:"user",content:"continue"}])],settings);
    const extend=realizeResponsesInput({manifest:selected,request:req,policy:"connection_memory",previous,conditions:current});
    expect(extend.path).toBe("extend");expect(extend.prepared.body.previous_response_id).toBe("resp1");expect(extend.prepared.body.store).toBe(false);
    expect(extend.prepared.body).not.toHaveProperty("stream");
    expect(()=>realizeResponsesInput({manifest:selected,request:req,policy:"connection_memory",previous,conditions:{...current,connectionIncarnation:"socket-2",reestablish:false}})).toThrow("responses_reestablishment_not_accepted");
    const replacement=realizeResponsesInput({manifest:selected,request:req,policy:"connection_memory",previous,conditions:{...current,connectionIncarnation:"socket-2"}});
    expect(replacement.reason).toBe("connection_memory_lost");expect(replacement.prepared.body.previous_response_id).toBeUndefined();expect(replacement.prepared.body.input).toHaveLength(3);
    expect(()=>realizeResponsesInput({manifest:selected,request:req,policy:"connection_memory",previous:{...previous,pending:{operationId:"unknown-create",inputDigest:"unknown"}},conditions:current})).toThrow("responses_generation_unresolved");
  });
  it("retains remote reasoning without pretending it is locally replayable", () => {
    const first = realize(), response = { id: "reasoning-response", object: "response", status: "completed",
      output: [{ id: "reasoning", type: "reasoning", summary: [] }] };
    const group = responsesOutputGroup({ manifest: first.manifest, response, observation: "obs", id: "reasoning",
      representation: { id: "reasoning", revision: "1" }, holds: ["reasoning-hold"] })!;
    expect(group.replay).toBe("remote_only");
    const previous = acceptResponsesContinuation({ pending: reserveResponsesInput(first, "op"), manifest: first.manifest,
      operationId: "op", observation: "obs", outputGroup: group, response });
    const next = manifest([user, group]);
    expect(realize(next, previous).path).toBe("extend");
    expect(() => realize(next, previous, { ...conditions, predecessor: "unavailable" })).toThrow("responses_replay_material_unavailable");
  });
  it("encodes only explicitly supported native cache controls and preserves them in the full input", () => {
    const cache = { settings: { prompt_cache_key: "stable-key", prompt_cache_retention: "24h" },
      support: { basis: purpose, fields: ["prompt_cache_key", "prompt_cache_retention"] as const, modes: [], retentions: ["24h"] },
      disclosure: { basis: purpose, permittedRetentions: ["24h"] } };
    const req = { ...request, cache }, settings = nativeInputSettings(prepareResponses({ ...req, input: [], store: true }).body);
    const realized = realizeResponsesInput({ manifest: manifest([user], settings), request: req, policy: "persistent_chain", previous: null, conditions });
    expect(realized.prepared.body.prompt_cache_retention).toBe("24h");
    expect(() => prepareResponses({ ...req, input: [], store: true,
      cache: { ...cache, disclosure: { ...cache.disclosure, permittedRetentions: [] } } })).toThrow("accounting_cache_retention_unauthorized");
  });
  it("establishes, retains complete input, and extends only the exact prefix", () => {
    const next = realize(manifest([user, output, group("u2", [{ role: "user", content: "Now explain." }])]), head());
    expect(next.path).toBe("extend"); expect(next.prepared.body.previous_response_id).toBe("resp1");
    expect(next.prepared.body.input).toEqual([{ role: "user", content: "Now explain." }]);
    expect(next.manifest.groups).toHaveLength(3); expect(next.prepared.body).not.toHaveProperty("instructions");
    expect(next.prepared.body).not.toHaveProperty("max_output_tokens");
  });
  it("preserves an empty completed response without inventing an input item", () => {
    const first = realize(), response = { id: "empty", object: "response", status: "completed", output: [] };
    const group = responsesOutputGroup({ manifest: first.manifest, response, observation: "empty-observation", id: "empty",
      representation: { id: "empty", revision: "1" }, holds: ["hold"] });
    expect(group).toBeNull();
    const previous = acceptResponsesContinuation({ pending: reserveResponsesInput(first, "empty-op"), manifest: first.manifest,
      operationId: "empty-op", observation: "empty-observation", outputGroup: group, response });
    expect(realize(first.manifest, previous).prepared.body.input).toEqual([]);
  });
  it("reestablishes after selected prefix replacement instead of appending to old chain", () => {
    const next = realize(manifest([group("summary", [{ role: "user", content: "Selected replacement with retained obligations." }])]), head());
    expect(next.path).toBe("reestablish"); expect(next.next.generation).toBe(2);
    expect(next.prepared.body).not.toHaveProperty("previous_response_id");
  });
  it("rejects unresolved creation, unknown predecessor, changed scope and private Child cursor", () => {
    const first = realize(), pending = reserveResponsesInput(first, "create1");
    expect(() => realize(first.manifest, pending)).toThrow("responses_generation_unresolved");
    const next = manifest([user, output]);
    expect(() => realize(next, head(), { ...conditions, predecessor: "unknown" })).toThrow("responses_predecessor_unreconciled");
    const child = bindNativeInputManifest({ ...next, scope: { ...next.scope, runId: "child", id: "child", recipientId: "child" } });
    expect(() => realize(child, head())).toThrow("responses_continuation_scope_changed");
    const reconciled = reconcileResponsesNotGenerated(pending, "create1", { disposition: "proven_unsent", source: "transport:no-write" });
    expect(realize(first.manifest, reconciled).path).toBe("establish");
  });
  it("requires explicit replay policy and storage authority; cannot turn native IDs into local replay", () => {
    const replaySettings = nativeInputSettings(prepareResponses({ ...request, input: [], store: false }).body);
    const next = realizeResponsesInput({ manifest: manifest([user, output], replaySettings), request, policy: "native_replay", previous: head(), conditions: { ...conditions, policyChange: true } });
    expect(next.path).toBe("replay"); expect(next.prepared.body.store).toBe(false);
    expect(next.prepared.body.input).toEqual([...user.items, ...output.items]);
    expect(() => realize(manifest(), null, { ...conditions, remoteStorage: false })).toThrow("responses_storage_not_authorized");
    expect(() => realize(manifest([{ ...user, replay: "remote_only" }]))).toThrow("responses_replay_material_unavailable");
  });
  it("does not reuse top-level instructions; settings and their sources are exact", () => {
    const req = { ...request, instructions: "New instruction" };
    const settings = nativeInputSettings(prepareResponses({ ...req, input: [], store: true }).body);
    const m = manifest([user, output], settings);
    expect(() => realize(m, head())).toThrow("responses_current_settings_changed");
    const next = realizeResponsesInput({ manifest: m, request: req, policy: "persistent_chain", previous: head(), conditions });
    expect(next.prepared.body.instructions).toBe("New instruction"); expect(next.prepared.body.input).toEqual([]);
    expect(() => bindNativeInputManifest({ ...m, settingSources: [] })).toThrow("native_settings_source_mismatch");
  });
  it("enforces opaque/native companion provenance rather than guessing semantic equivalence", () => {
    const reasoning = group("reasoning", [{ type: "reasoning", id: "rr", encrypted_content: "opaque", summary: [] }]);
    const bound = { ...reasoning, requires: [{ id: user.id, digest: nativeInputGroupDigest(user) }] };
    expect(realize(manifest([user, bound])).prepared.body.input).toHaveLength(2);
    expect(() => manifest([{ ...user, items: [{ role: "user", content: "Different" }] }, bound])).toThrow("native_group_dependency_changed");
    expect(() => realize(manifest([group("missing", [{ type: "reasoning", id: "rr", summary: [] }])]))).toThrow("responses_opaque_replay_unavailable");
  });
  it("records reasoning's complete original prefix in order without absorbing a later suffix", () => {
    const original = manifest([user, output]);
    const response = { id: "reasoned", object: "response", status: "completed",
      output: [{ id: "rs", type: "reasoning", summary: [], encrypted_content: "opaque" }] };
    const reasoning = responsesOutputGroup({ manifest: original, response, observation: "reasoned-observation", id: "reasoned-output",
      representation: { id: "reasoned-representation", revision: "1" }, holds: ["reasoned-hold"] })!;
    expect(reasoning.requires).toEqual([
      { id: user.id, digest: nativeInputGroupDigest(user) }, { id: output.id, digest: nativeInputGroupDigest(output) },
    ]);
    const suffix = group("later", [{ role: "user", content: "Explain the conclusion." }]);
    const input = manifest([user, output, reasoning, suffix]);
    expect(realize(input).prepared.body.input).toEqual([...user.items, ...output.items, ...reasoning.items, ...suffix.items]);
    expect(reasoning.requires).toHaveLength(2);
  });
  it.each(["native_replay", "persistent_chain"] as const)("rejects reordered or incomplete reasoning prefixes under %s", policy => {
    const reasoning = { ...group("reasoning", [{ type: "reasoning", id: "rs", encrypted_content: "opaque", summary: [] }]),
      requires: [{ id: user.id, digest: nativeInputGroupDigest(user) }, { id: output.id, digest: nativeInputGroupDigest(output) }] };
    const settings = nativeInputSettings(prepareResponses({ ...request, input: [], store: policy === "persistent_chain" }).body);
    const prepare = (groups: readonly NativeInputGroup[]) => realizeResponsesInput({ manifest: manifest(groups, settings), request,
      policy, previous: null, conditions });
    expect(prepare([user, output, reasoning]).prepared.body.input).toEqual([...user.items, ...output.items, ...reasoning.items]);
    for (const groups of [
      [reasoning, user, output],
      [user, reasoning, output],
      [output, user, reasoning],
      [user, output, { ...reasoning, requires: [...reasoning.requires].reverse() }],
      [user, output, { ...reasoning, requires: reasoning.requires.slice(0, 1) }],
      [user, output, { ...reasoning, requires: [...reasoning.requires, reasoning.requires[0]] }],
    ]) expect(() => prepare(groups)).toThrow("responses_reasoning_prefix_basis_missing");
  });
  it("revalidates reasoning prefix order after cold restore without treating new holds as reordered content", () => {
    const reasoning = { ...group("reasoning", [{ type: "reasoning", id: "rs", encrypted_content: "opaque", summary: [] }]),
      requires: [{ id: user.id, digest: nativeInputGroupDigest(user) }, { id: output.id, digest: nativeInputGroupDigest(output) }] };
    const original = realize(manifest([user, output, reasoning]));
    const renewed = manifest([{ ...user, holds: ["renewed-user"] }, { ...output, holds: ["renewed-output"] }, reasoning]);
    const restored = JSON.parse(JSON.stringify({ manifest: renewed, continuity: original.continuity }));
    expect(resolveResponsesInputContinuity(restored.manifest, restored.continuity).path).toBe("establish");
    for (const groups of [[reasoning, user, output], [output, user, reasoning]]) {
      const changed = JSON.parse(JSON.stringify(manifest(groups)));
      expect(() => resolveResponsesInputContinuity(changed, restored.continuity)).toThrow("responses_reasoning_prefix_basis_missing");
    }
  });
  it("allows reasoning with an actually empty original prefix", () => {
    const response = { id: "empty-prefix", object: "response", status: "completed",
      output: [{ id: "rs-empty", type: "reasoning", summary: [], encrypted_content: "opaque" }] };
    const reasoning = responsesOutputGroup({ manifest: manifest([]), response, observation: "empty-prefix-observation", id: "reasoning-empty",
      representation: { id: "reasoning-empty", revision: "1" }, holds: ["reasoning-empty-hold"] })!;
    expect(reasoning.requires).toEqual([]);
    expect(realize(manifest([reasoning])).prepared.body.input).toEqual(reasoning.items);
  });
  it("validates whole function exchange before selecting a suffix", () => {
    const call = group("call", [{ type: "function_call", id: "fc", call_id: "call1", name: "Read", arguments: "{}" }]);
    expect(() => realize(manifest([user, call]))).toThrow("responses_history_exchange_incomplete");
    const result = group("result", [{ type: "function_call_output", call_id: "call1", output: "Actual file bytes" }]);
    expect(realize(manifest([user, call, result])).prepared.body.input).toHaveLength(3);
    expect(() => realize(manifest([user, result]))).toThrow("responses_history_result_unmatched");
  });
  it("rechecks disclosure and leaves a frozen input unchanged on later deliveries", () => {
    const old = manifest(), first = realize(old);
    const newer = manifest([user, group("later", [{ role: "user", content: "A later Child result" }])]);
    expect(first.manifest.digest).toBe(old.digest); expect(newer.digest).not.toBe(old.digest);
    const changed = bindNativeInputManifest({ ...newer, target: { ...newer.target, disclosure: "d2" } });
    expect(() => realize(changed, head())).toThrow("responses_input_authority_changed");
    expect(realize(changed, head(), { ...conditions, disclosureRevision: "d2" }).path).toBe("reestablish");
  });
  it("does not confuse renewed custody with changed prefix content", () => {
    const input = manifest([{ ...user, holds: ["new-input-hold"], deliveries: [] }, { ...output, holds: ["new-output-hold"] }]);
    expect(realize(input, head()).path).toBe("extend");
    expect(() => realize(input, head(), { ...conditions, authorized: false })).toThrow("responses_input_authority_changed");
  });
  it("keeps other native protocols independent and validates their own result correlation", () => {
    const ds = prepareDeepSeekChat({ ...request, messages: [user.items[0]] });
    const om = prepareOllamaChat({ ...request, messages: [user.items[0]], options: { num_ctx: 32768 } });
    expect(realizeDeepSeekChatInput(manifest([user], nativeInputSettings(ds.body), DEEPSEEK_CHAT_COMPLETIONS), request).prepared.body).toEqual(ds.body);
    expect(realizeOllamaChatInput(manifest([user], nativeInputSettings(om.body), OLLAMA_CHAT), { ...request, options: { num_ctx: 32768 } }).prepared.body).toEqual(om.body);
    expect(() => realizeOllamaChatInput(manifest([group("bad", [{ role: "tool", tool_name: "Read", content: "text" }])], nativeInputSettings(om.body), OLLAMA_CHAT), request)).toThrow("ollama_history_result_unmatched");
  });
});
