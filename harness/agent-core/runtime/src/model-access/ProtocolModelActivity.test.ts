import { describe, expect, it } from "vitest";
import { bindModelAgentComposition, OPENAI_RESPONSES, type ModelPurposeEvidence, type NativeModelSourceRef } from "@agent-anything/model-interaction/protocol";
import { createNativeModelCallRef } from "@agent-anything/model-interaction";
import { bindProtocolModelActivity, assertProtocolModelActivityOriginal, assertProtocolPurposeEvidence } from "./ProtocolModelActivity.js";
import { createNativeTaskModelItems } from "../decision/TaskDecisionModelItems.js";
import { snapshotTaskModelExchange } from "../decision/TaskDecisionValidation.js";
import type { TaskDecisionInputSources } from "../decision/TaskDecisionActivity.js";

const ref = (id: string) => ({ id, revision: "1" });
function fixture() {
  const participant = (id: string) => ({ implementation: ref(id), protocol: OPENAI_RESPONSES });
  const composition = bindModelAgentComposition({ agent: ref("agent"), protocol: OPENAI_RESPONSES,
    configuration: { configuration: ref("config"), protocol: OPENAI_RESPONSES, model: "model", connectionBinding: ref("original-connection") },
    adapter: participant("adapter"), task: { purpose: ref("task"), interpreter: participant("task-interpreter"), input: participant("task-input") }, auxiliary: [] });
  const scope = { runId: "root", activityId: "native-activity", recipientId: "task", purpose: ref("task"), compositionDigest: composition.digest };
  const activity = bindProtocolModelActivity({ composition, scope, conditions: { input: ref("input"), authority: ref("authority"), resources: ref("resources"), control: ref("control") } });
  const source: NativeModelSourceRef = { scope, protocol: OPENAI_RESPONSES, interpretation: ref("adapter"), operationId: "native-operation",
    record: ref("native-observation"), position: { format: "json-pointer", value: "/output/0" }, nativeIdentity: null };
  const evidence: ModelPurposeEvidence = { scope, interpreter: ref("task-interpreter"), acceptance: ref("purpose-acceptance"), sources: [source] };
  return { activity, evidence, source };
}

describe("Protocol-owned activity handoffs", () => {
  it("restores original conditions, not latest configuration or inferred native state", () => {
    const { activity } = fixture();
    expect(() => assertProtocolModelActivityOriginal(activity, JSON.parse(JSON.stringify(activity)))).not.toThrow();
    const changed = bindProtocolModelActivity({ ...activity, conditions: { ...activity.conditions, input: ref("different-input") } });
    expect(() => assertProtocolModelActivityOriginal(activity, changed)).toThrow("protocol_activity_original_binding_unavailable");
    expect(() => assertProtocolModelActivityOriginal({ ...activity, digest: "corrupt" }, activity)).toThrow("protocol_activity_integrity_failed");
  });
  it.each(["recipient", "activity", "interpreter", "native-reader"])("rejects changed %s evidence before acceptance", field => {
    const { activity, evidence } = fixture();
    const scope = { ...evidence.scope, ...(field === "recipient" ? { recipientId: "child-private" } : field === "activity" ? { activityId: "auxiliary" } : {}) };
    const changed = { ...evidence, scope, interpreter: field === "interpreter" ? ref("other") : evidence.interpreter,
      sources: evidence.sources.map(source => ({ ...source, scope, interpretation: field === "native-reader" ? ref("new-reader") : source.interpretation })) };
    expect(() => assertProtocolPurposeEvidence(activity, changed)).toThrow("protocol_purpose_evidence_binding_mismatch");
  });
  it("accepts source-only evidence without creating a universal Turn or terminal state", () => {
    const { activity, evidence } = fixture();
    expect(assertProtocolPurposeEvidence(activity, evidence)).toEqual(evidence);
    expect(createNativeTaskModelItems(evidence, [])).toEqual([{ id: "purpose-evidence:purpose-acceptance:1", kind: "native_purpose_evidence", evidence, metadata: {} }]);
    expect("turnId" in evidence).toBe(false);
    expect("status" in evidence).toBe(false);
  });
  it("validates native RunItem evidence and local Call references without finish/correlation items", () => {
    const { evidence, source } = fixture();
    const call = { modelCallRef: createNativeModelCallRef({ providerRequestId: "request", controllerRequestId: "decision", branchId: "root", contentBlockOrdinal: 0,
      nativeSource: source, purposeAcceptance: evidence.acceptance }), providerCallRef: null, name: "Read", input: { path: "file" }, ordinal: 0 };
    const modelItems = createNativeTaskModelItems(evidence, [call]);
    // Only fields read by the exchange validator are supplied; no model/network execution is involved.
    const input = { runId: "root", agent: { id: "agent" }, toolExposure: { controllerRequestId: "decision" }, interaction: { opening: null, latestTurn: null } } as
      Pick<TaskDecisionInputSources, "runId" | "inputDelivery" | "interaction" | "toolExposure"> & { agent: { id: string } };
    const exchange = snapshotTaskModelExchange({ modelItems }, input);
    expect(exchange.modelItems).toEqual(modelItems);
    expect(() => snapshotTaskModelExchange({ modelItems }, { ...input, runId: "child" })).toThrow();
    const wrong = { ...call, modelCallRef: createNativeModelCallRef({ providerRequestId: "request", controllerRequestId: "decision", branchId: "root", contentBlockOrdinal: 0,
      nativeSource: source, purposeAcceptance: ref("other") }) };
    expect(() => createNativeTaskModelItems(evidence, [wrong])).toThrow("native_task_call_source_mismatch");
    expect(() => snapshotTaskModelExchange({ modelItems: [...modelItems, modelItems[0]!] }, input)).toThrow();
  });
});
