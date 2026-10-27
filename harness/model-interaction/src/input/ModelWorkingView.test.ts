import {describe, expect, it} from "vitest";
import {createModelCallRef, type ModelCallableRequest, type ModelToolResult} from "../ModelCall.js";
import {modelInputFromSections, type ModelInputSection} from "./ModelInput.js";
import {createExactModelWorkingView, selectModelWorkingView} from "./ModelWorkingView.js";
import {applyModelInputOwnerForms, modelInputOccurrenceDigest, type ModelInputOwnerForm} from "./ModelInputForms.js";

const section = (id: string, content: ModelInputSection["content"], role: ModelInputSection["role"] = "user"): ModelInputSection => ({
  id, source: {owner: "test", kind: "source", id, revision: "1", runId: "root"}, kind: "history", role,
  necessity: "mandatory", content, provenance: {purpose: "fixture", recipientRunId: "root", author: "user",
    sources: [{owner: "test", kind: "source", id, revision: "1", runId: "root"}],
    presenter: {owner: "test", kind: "presenter", id: "exact", revision: "1"}, coverage: [`${id}@1`], limitations: []},
});
function exchange() {
  const calls: ModelCallableRequest[] = [0, 1].map(ordinal => ({name: "Read", ordinal, input: {path: `${ordinal}.txt`},
    modelCallRef: createModelCallRef({providerRequestId: "request", controllerRequestId: "controller", turnId: "turn",
      contentBlockOrdinal: ordinal, branchId: "main"}), providerCallRef: {providerId: "provider", id: `call-${ordinal}`}}));
  const results: ModelToolResult[] = calls.map(call => ({name: call.name, modelCallRef: call.modelCallRef,
    providerCallRef: call.providerCallRef, settlement: "succeeded", content: {text: "identical output"},
    presentation: {presenter: {id: "read", revision: "1"}, disposition: "complete", failureCode: null},
    sourceRefs: [{owner: "test", kind: "result", id: `result-${call.ordinal}`, revision: "1"}]}));
  return {calls, results, sections: [
    section("task", {kind: "text", text: "Read both files."}),
    section("turn", {kind: "model_message", message: {role: "assistant", content: calls.map(call => ({kind: "model_tool_call", call}))}}, "assistant"),
    ...results.map((result, index) => section(`result-${index}`, {kind: "model_message", message: {role: "tool",
      content: [{kind: "model_tool_result", result}]}}, "tool")),
  ]};
}
describe("Exact model working views", () => {
  it("allows a source-owned closed result body, but protects active groups and every Call binding", () => {
    const {sections, results} = exchange();
    const admitted = sections.map(value => ({...value, provenance: {...value.provenance!, retainedPresentation: value.source},
      preservation: {obligations: [{id: value.id, requirement: "account" as const, basis: "Source owner account"}], relationships: []}}));
    const result = admitted[2]!;
    const replacement: ModelInputOwnerForm = {id: "read-account", sectionId: result.id, sourceDigest: modelInputOccurrenceDigest(result),
      owner: {owner: "test", kind: "presenter", id: "read-account", revision: "1"}, method: "owner_presentation", satisfies: [result.id],
      companions: ["turn"], dependencies: [], limitations: ["Owner account, not the complete body"],
      content: {kind: "model_message", message: {role: "tool", content: [{kind: "model_tool_result", result: {...results[0]!, content: {text: "Account"}}}]}}};
    expect(() => applyModelInputOwnerForms(admitted, [replacement], "root")).toThrow();
    const closed = [...admitted, section("next-turn", {kind: "text", text: "Proceed with both findings"}, "assistant")];
    const selected = applyModelInputOwnerForms(closed, [replacement], "root");
    expect(selected[1]).toEqual(closed[1]);
    expect(selected[3]).toEqual(closed[3]);
    expect(selected[2]?.content).toEqual(replacement.content);
    const wrong: ModelInputOwnerForm = {...replacement, content: {kind: "model_message", message: {role: "tool", content: [
      {kind: "model_tool_result", result: {...results[0]!, name: "Other", content: {text: "Account"}}}]}}};
    expect(() => applyModelInputOwnerForms(closed, [wrong], "root")).toThrow("correlation");
    expect(() => applyModelInputOwnerForms(closed, [replacement], "child")).toThrow("recipient");
  });
  it("selects exact content in delivery order without duplicating identical occurrences or obligations", () => {
    const first = section("first", {kind: "text", text: "same text"});
    const second = {...section("second", first.content), preservation: {obligations: [
      {id: "objective", requirement: "account" as const, basis: "Maintain the objective."},
      {id: "evidence", requirement: "exact" as const, basis: "Exact quoted evidence."},
    ], relationships: [{kind: "qualifies" as const, source: first.source}]}};
    const available = [first, second];
    const view = createExactModelWorkingView({sections: available, recipientRunId: "root", boundary: "request"});
    expect(view.entries.map(entry => entry.sectionId)).toEqual(["first", "second"]);
    expect(view.entries[1]?.preservation.obligations).toHaveLength(2);
    expect(view.entries[1]?.permittedForms).toEqual(["exact"]);
    expect(JSON.stringify(view)).not.toContain("same text");
    expect(modelInputFromSections(selectModelWorkingView(JSON.parse(JSON.stringify(view)), available)).messages).toEqual([
      {role: "user", content: [{kind: "text", text: "same text"}, {kind: "text", text: "same text"}]},
    ]);
    expect(() => selectModelWorkingView({...view, entries: view.entries.slice(1)}, available)).toThrow();
    expect(() => selectModelWorkingView(view, [...available].reverse())).toThrow("reorders");
    expect(() => selectModelWorkingView(view, [first, {...second, content: {kind: "text", text: "changed"}}])).toThrow("binding mismatch");
    expect(() => selectModelWorkingView({...view, recipientRunId: "child"}, available)).toThrow("another recipient");
  });
  it("groups normalized multiple Calls with all results and never groups text mentioning Calls", () => {
    const {sections, calls, results} = exchange();
    const view = createExactModelWorkingView({sections, recipientRunId: "root", boundary: "request"});
    expect(view.nativeGroups).toEqual([{turnId: "turn", originRunId: "root", sectionIds: ["turn", "result-0", "result-1"],
      callIds: calls.map(call => call.modelCallRef.id), settledCallIds: calls.map(call => call.modelCallRef.id),
      status: "settled", protection: "active_exchange"}]);
    const after = createExactModelWorkingView({sections: [...sections,
      section("later-turn", {kind: "text", text: "Historical text: call Read and final_result."}, "assistant")], recipientRunId: "root", boundary: "request"});
    expect(after.nativeGroups).toHaveLength(1);
    expect(after.nativeGroups[0]?.protection).toBe("required_account");
    const pending = sections.slice(0, 3);
    expect(createExactModelWorkingView({sections: pending, recipientRunId: "root", boundary: "history"}).nativeGroups[0]?.status).toBe("unsettled");
    expect(() => createExactModelWorkingView({sections: pending, recipientRunId: "root", boundary: "request"})).toThrow("unsettled Calls");
    expect(() => createExactModelWorkingView({sections: [sections[0]!, sections[2]!], recipientRunId: "root", boundary: "request"})).toThrow("no matching Call");
    expect(() => createExactModelWorkingView({sections: [sections[1]!, sections[0]!, ...sections.slice(2)], recipientRunId: "root", boundary: "request"})).toThrow("interrupts");
    expect(() => createExactModelWorkingView({sections: [...sections, {...sections[2]!, id: "duplicate-result"}], recipientRunId: "root", boundary: "request"})).toThrow("no matching Call");
    const changedResult = section("result-0", {kind: "model_message", message: {role: "tool", content: [{kind: "model_tool_result",
      result: {...results[0]!, providerCallRef: {providerId: "other-provider", id: "call-0"}}}]}}, "tool");
    expect(() => createExactModelWorkingView({sections: [sections[0]!, sections[1]!, changedResult, sections[3]!],
      recipientRunId: "root", boundary: "request"})).toThrow("changes its correlation");
    expect(() => selectModelWorkingView({...view, nativeGroups: [{...view.nativeGroups[0]!, settledCallIds: []}]}, sections)).toThrow("binding mismatch");
  });
  it("protects first delivery separately from source obligations and does not treat IDs as content evidence", () => {
    const original = section("source", {kind: "text", text: "first"});
    const fresh = createExactModelWorkingView({sections: [original], recipientRunId: "root", boundary: "request"});
    expect(fresh.entries[0]?.protection).toEqual(["first_delivery"]);
    const replay = {...original, provenance: {...original.provenance!, retainedPresentation: original.source}};
    const replayed = createExactModelWorkingView({sections: [replay], recipientRunId: "root", boundary: "request"});
    expect(replayed.entries[0]?.protection).toEqual([]);
    expect(() => selectModelWorkingView(fresh, [{...original, preservation: {obligations: [
      {id: "weaker", requirement: "account", basis: "Unaccepted alteration"}], relationships: []}}])).toThrow("binding mismatch");
    expect(() => selectModelWorkingView({...fresh, unexpected: true} as typeof fresh, [original])).toThrow();
  });
});
