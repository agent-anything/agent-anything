import { describe, expect, it, vi } from "vitest";
import {
  OPENAI_RESPONSES, DEEPSEEK_CHAT_COMPLETIONS, OLLAMA_CHAT, bindModelAgentComposition,
  assertChildModelComposition, snapshotModelAgentCompositionBinding, snapshotModelInteractionProtocol,
  ModelCompositionRegistry, requireModelPurpose, snapshotNativeModelSource, nativeModelSourceKey,
  snapshotModelPurposeEvidence, decodeModelArguments,
  type ModelInteractionProtocolRef, type ModelAgentComposition, type NativeModelSourceRef, type ModelSchemaMappingBinding,
} from "./index.js";
import { createNativeModelCallRef, snapshotModelCallRef, modelCallRefKey, modelCallsShareDecisionBasis, requireModelCallTurn, snapshotModelToolResult } from "../ModelCall.js";

function composition(protocol: ModelInteractionProtocolRef = OPENAI_RESPONSES): ModelAgentComposition {
  const participant = (id: string) => ({ protocol, implementation: { id, revision: "1" } });
  return { agent: { id: "agent", revision: "1" }, protocol,
    configuration: { configuration: { id: "config", revision: "1" }, protocol, model: "fixture-model", connectionBinding: { id: "original-connection", revision: "1" } },
    adapter: participant("native-adapter"), task: { purpose: { id: "task", revision: "1" }, interpreter: participant("task-interpreter"), input: participant("task-input") },
    auxiliary: [{ purpose: { id: "assessment", revision: "1" }, interpreter: participant("assessment"), input: participant("assessment-input") }] };
}
function source(protocol: ModelInteractionProtocolRef = OPENAI_RESPONSES): NativeModelSourceRef {
  const binding = bindModelAgentComposition(composition(protocol));
  return { scope: { runId: "root", activityId: "activity", recipientId: "root-task", purpose: binding.composition.task.purpose, compositionDigest: binding.digest },
    protocol, interpretation: binding.composition.adapter.implementation, operationId: "original-operation",
    record: { id: "retained-observation", revision: "1" }, position: { format: "json-pointer", value: "/output/0" },
    nativeIdentity: { kind: "response", id: "resp_original" } };
}

describe("Provider-bound composition admission", () => {
  it.each([OPENAI_RESPONSES, DEEPSEEK_CHAT_COMPLETIONS, OLLAMA_CHAT])("binds %j without a universal Turn or request/response", protocol => {
    const original = composition(protocol);
    const binding = bindModelAgentComposition(original);
    expect(binding.composition.protocol).toEqual(protocol);
    expect(snapshotModelAgentCompositionBinding(JSON.parse(JSON.stringify(binding)))).toEqual(binding);
    expect(Object.isFrozen(binding.composition.task.input)).toBe(true);
    expect(Object.keys(binding.composition)).not.toContain("turn");
    expect(requireModelPurpose(binding, { id: "assessment", revision: "1" }).interpreter.implementation.id).toBe("assessment");
    expect(() => requireModelPurpose(binding, { id: "assessment", revision: "2" })).toThrow("protocol_purpose_unavailable");
  });

  it.each(["configuration", "adapter", "task-input", "auxiliary-interpreter"])("rejects a mismatched %s before any factory", location => {
    const value = structuredClone(composition());
    if (location === "configuration") value.configuration = { ...value.configuration, protocol: OLLAMA_CHAT };
    if (location === "adapter") value.adapter = { ...value.adapter, protocol: OLLAMA_CHAT };
    if (location === "task-input") value.task = { ...value.task, input: { ...value.task.input, protocol: OLLAMA_CHAT } };
    if (location === "auxiliary-interpreter") value.auxiliary = [{ ...value.auxiliary[0]!, interpreter: { ...value.auxiliary[0]!.interpreter, protocol: OLLAMA_CHAT } }];
    expect(() => bindModelAgentComposition(value)).toThrow("protocol_composition_mismatch");
  });

  it("cannot turn another Provider into OpenAI by changing the binding or adding a service", () => {
    expect(() => snapshotModelInteractionProtocol({ ...OPENAI_RESPONSES, providerId: "third-party" })).toThrow("protocol_provider_mismatch");
    expect(() => bindModelAgentComposition({ ...composition(), service: "third-party" })).toThrow("protocol_record_invalid");
    expect(() => bindModelAgentComposition({ ...composition(), configuration: { ...composition().configuration, apiKey: "secret" } })).toThrow("protocol_record_invalid");
  });

  it("rejects duplicate purpose ownership and corrupted retained bindings", () => {
    const value = composition();
    expect(() => bindModelAgentComposition({ ...value, auxiliary: [value.task] })).toThrow("protocol_purpose_duplicate");
    const binding = bindModelAgentComposition(value);
    expect(() => snapshotModelAgentCompositionBinding({ ...binding, composition: { ...value, agent: { id: "other", revision: "1" } } })).toThrow("protocol_composition_integrity_failed");
  });

  it("does not read accessors or erase non-plain identities during validation", () => {
    const getter = vi.fn(() => OPENAI_RESPONSES);
    const value = { ...composition() };
    Object.defineProperty(value, "protocol", { enumerable: true, get: getter });
    expect(() => bindModelAgentComposition(value)).toThrow("protocol_record_invalid");
    expect(getter).not.toHaveBeenCalled();
    expect(() => bindModelAgentComposition({ ...composition(), auxiliary: [new Date()] })).toThrow();
    expect(() => bindModelAgentComposition({ ...composition(), auxiliary: new Array(1) })).toThrow("protocol_list_invalid");
  });

  it("resolves only original registered composition; no changed-default or endpoint fallback", () => {
    const registry = new ModelCompositionRegistry<{ scope: string }>();
    const original = bindModelAgentComposition(composition());
    const factory = vi.fn(scope => ({ scope: scope.runId }));
    registry.register(original, factory);
    const changed = bindModelAgentComposition({ ...original.composition, configuration: { ...original.composition.configuration, model: "new-default" } });
    expect(() => registry.create(changed, { runId: "root", recipientId: "task" })).toThrow("original_protocol_composition_unavailable");
    expect(factory).not.toHaveBeenCalled();
    expect(registry.create(JSON.parse(JSON.stringify(original)), { runId: "root", recipientId: "task" })).toEqual({ scope: "root" });
    expect(() => registry.register(original, factory)).toThrow("protocol_composition_already_registered");
  });

  it("validates Child inheritance before creation and allocates independent participant state", () => {
    const root = bindModelAgentComposition(composition());
    const child = bindModelAgentComposition({ ...root.composition, agent: { id: "child-agent", revision: "1" } });
    const registry = new ModelCompositionRegistry<{ history: string[]; runId: string }>();
    const create = vi.fn(scope => ({ runId: scope.runId, history: [] as string[] }));
    registry.register(root, create); registry.register(child, create);
    expect(() => registry.requireChild(root, bindModelAgentComposition(composition(OLLAMA_CHAT)))).toThrow("child_protocol_binding_incompatible");
    const changedKey = bindModelAgentComposition({ ...child.composition, configuration: { ...child.composition.configuration, connectionBinding: { id: "new-key-binding", revision: "2" } } });
    expect(() => assertChildModelComposition(root, changedKey)).toThrow("child_protocol_binding_incompatible");
    expect(() => registry.createChild(root, { runId: "root", recipientId: "root-task" }, child, { runId: "root", recipientId: "child-task" }))
      .toThrow("child_interaction_scope_not_independent");
    expect(create).not.toHaveBeenCalled();
    const parentState = registry.create(root, { runId: "root", recipientId: "root-task" });
    const childState = registry.createChild(root, { runId: "root", recipientId: "root-task" }, child, { runId: "child", recipientId: "child-task" });
    childState.history.push("child private content");
    expect(parentState.history).toEqual([]);
    expect(childState.runId).toBe("child");
  });

  it("keeps native participant shapes, operations and state without a common response carrier", () => {
    const cases = [
      { protocol: OPENAI_RESPONSES, native: { output: [{ type: "compaction", encrypted_content: "opaque" }], id: "response" } },
      { protocol: DEEPSEEK_CHAT_COMPLETIONS, native: { choices: [{ message: { reasoning_content: "reason", content: "text" } }] } },
      { protocol: OLLAMA_CHAT, native: { message: { content: "text", tool_calls: [] }, done: true } },
    ];
    for (const entry of cases) {
      const registry = new ModelCompositionRegistry<typeof entry.native>();
      const binding = bindModelAgentComposition(composition(entry.protocol));
      registry.register(binding, () => entry.native);
      expect(registry.create(binding, { runId: "root", recipientId: "root-task" })).toBe(entry.native);
    }
  });
});

describe("Native source and purpose evidence", () => {
  it("separates immutable observations even when the remote response ID is identical", () => {
    const first = source(); const later = { ...first, record: { ...first.record, revision: "2" } };
    expect(nativeModelSourceKey(first)).not.toBe(nativeModelSourceKey(later));
    expect(nativeModelSourceKey(first)).toBe(nativeModelSourceKey(structuredClone(first)));
    expect(snapshotNativeModelSource({ ...source(OLLAMA_CHAT), nativeIdentity: null, position: { format: "json-pointer", value: "/message" } }).nativeIdentity).toBeNull();
  });
  it("rejects mixed recipients and duplicate sources, but retains distinct observations", () => {
    const first = source();
    const evidence = { scope: first.scope, interpreter: { id: "task-interpreter", revision: "1" }, acceptance: { id: "result-slot", revision: "1" }, sources: [first] };
    expect(() => snapshotModelPurposeEvidence({ ...evidence, sources: [first, first] })).toThrow("purpose_evidence_source_duplicate");
    expect(() => snapshotModelPurposeEvidence({ ...evidence, sources: [{ ...first, scope: { ...first.scope, runId: "child" } }] })).toThrow("purpose_evidence_scope_mismatch");
    expect(snapshotModelPurposeEvidence({ ...evidence, sources: [first, { ...first, record: { ...first.record, revision: "2" } }] }).sources).toHaveLength(2);
    expect(() => snapshotNativeModelSource({ ...first, turnId: "invented" })).toThrow("protocol_record_invalid");
  });
  it("binds local Calls to original purpose acceptance, not a newly observed response", () => {
    const nativeSource = source();
    const input = { providerRequestId: "request", controllerRequestId: "decision", branchId: "root", contentBlockOrdinal: 0, nativeSource, purposeAcceptance: { id: "result-slot", revision: "1" } };
    const call = createNativeModelCallRef(input);
    const later = createNativeModelCallRef({ ...input, nativeSource: { ...nativeSource, record: { ...nativeSource.record, revision: "2" } } });
    expect(call.turnId).toBeNull(); expect(later.id).toBe(call.id);
    expect(modelCallsShareDecisionBasis(call, later)).toBe(true);
    expect(modelCallsShareDecisionBasis(call, createNativeModelCallRef({ ...input, purposeAcceptance: { id: "another-slot", revision: "1" } }))).toBe(false);
    expect(modelCallRefKey(later)).not.toBe(modelCallRefKey(call));
    expect(snapshotModelCallRef(JSON.parse(JSON.stringify(call)))).toEqual(call);
    expect(() => snapshotModelCallRef({ ...call, id: "forged" })).toThrow("native_model_call_identity_invalid");
    expect(() => requireModelCallTurn(call)).toThrow("model_call_turn_convention_required");
    const result = snapshotModelToolResult({ modelCallRef: call, providerCallRef: null, name: "local_action", settlement: "succeeded",
      presentation: { presenter: { id: "presenter", revision: "1" }, disposition: "complete", failureCode: null }, content: { done: true },
      sourceRefs: [{ owner: "execution", kind: "result", id: "original-effect", revision: "1" }] });
    expect(result.modelCallRef).toEqual(call);
  });
});

describe("Purpose-bound schema mapping", () => {
  it("uses the original codec and retains omission, null and source identity", () => {
    const nativeSource = source();
    const mapping: ModelSchemaMappingBinding = { mapping: { id: "exact-mapping", revision: "1" }, protocol: OPENAI_RESPONSES, purpose: nativeSource.scope.purpose,
      canonicalSchema: { id: "contract", revision: "1" }, wireSchema: { id: "wire", revision: "1" } };
    type Canonical = { response?: string | null };
    type Wire = { present: boolean; value: string | null };
    const decode = vi.fn((wire: Wire): Canonical => wire.present ? { response: wire.value } : {});
    const codec = { binding: mapping, encode: (value: Canonical): Wire => ({ present: Object.hasOwn(value, "response"), value: value.response ?? null }), decode };
    for (const value of [{}, { response: null }, { response: "" }, { response: "reply" }]) {
      const decoded = decodeModelArguments({ retained: mapping, codec, source: nativeSource, raw: codec.encode(value) });
      expect(decoded.value).toEqual(value); expect(decoded.source).toEqual(nativeSource);
    }
    decode.mockClear();
    expect(() => decodeModelArguments({ retained: { ...mapping, mapping: { ...mapping.mapping, revision: "2" } }, codec, source: nativeSource, raw: { present: false, value: null } }))
      .toThrow("model_schema_original_mapping_unavailable");
    expect(decode).not.toHaveBeenCalled();
  });
});
