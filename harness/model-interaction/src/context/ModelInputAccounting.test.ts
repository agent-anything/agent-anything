import {describe, expect, it} from "vitest";
import {createModelNativeInputFootprint, observeModelInputUsage, planModelInput, snapshotModelInputPlanning,
  type ModelInputUsageObservation, type ProviderInputAccounting} from "./ModelInputAccounting.js";
import {assessModelContext, createUnknownModelInputMeasurement} from "./ModelContext.js";

const at = "2026-10-23T00:00:00Z";
const capacity = {supported: true, unit: "tokens", maximum: 1000, semantics: "input_and_output", source: "host_configured",
  providerId: "test", model: "model", revision: "1"} as const;
const footprint = (text: string, schema = {type: "object"}) => createModelNativeInputFootprint({messages: [{role: "user", content: text}],
  tools: [{type: "function", function: {name: "read", description: "Read complete bytes.", parameters: schema}}]});
const accounting: ProviderInputAccounting = {basis: {endpoint: "https://example.test/chat", model: "m", mode: "none", adapter: "1"},
  inputUsage: "complete", outputUsage: "complete", defaultGenerationRoom: null, limitations: ["preservation_unknown"], project: () => footprint("hello")};
function plan(text = "hello", previous: ModelInputUsageObservation | null = null, overrides: Partial<Parameters<typeof planModelInput>[0]> = {}) {
  return planModelInput({requestId: "request", runId: "root", purpose: "control", accounting, footprint: footprint(text),
    measurement: createUnknownModelInputMeasurement({compositionId: "request", measuredAt: at, reason: "unsupported"}),
    capacity, previous, growthPolicy: "exact", ...overrides});
}
const usage = (inputTokens: number, outputTokens = 30) => ({inputTokens, outputTokens, totalTokens: inputTokens + outputTokens, costUnits: null, metadata: {}});
describe("complete input planning", () => {
  it("attributes explicitly selected material without treating Call results or Child messages as extra shares", () => {
    const source = {owner: "fixture", kind: "input", id: "one", revision: "1"};
    const sections = ["selected_material", "accepted_exchange", "imported_history"].map(purpose => ({id: purpose,
      source, kind: "conversation", role: "user" as const, necessity: "mandatory" as const,
      content: {kind: "text" as const, text: "same amount"}, provenance: {purpose, recipientRunId: "root", author: "host",
        sources: [source], presenter: source, coverage: ["one"], limitations: []}}));
    const first = observeModelInputUsage(plan(), usage(300), "r1", true)!;
    const result = plan("hello", first, {sections});
    expect(result.groupAttribution.selectedMaterialFraction).toBeCloseTo(1 / 3);
    expect(result.allocation?.groups[2]?.used).toBeGreaterThan(0);
    expect(result.allocation?.used).toBeCloseTo(300);
  });
  it("separates exact input fit from unknown generation room and honors an existing caller cap without introducing one", () => {
    const measurement = {status: "measured" as const, amount: 100, estimator: {id: "native", revision: "1", unit: "tokens" as const,
      accuracy: "exact" as const}, uncertainty: {kind: "none" as const}, measuredCompositionId: "request", measuredAt: at};
    const result = plan("hello", null, {measurement});
    expect(result.inputWindowAssessment).toBe("proven_fit");
    expect(result.generationRoom).toBeNull();
    const configured = plan("hello", null, {measurement, requestedOutput: {unit: "tokens", maximum: 200, source: "host_configured", revision: "1"}});
    expect(configured.generationSource).toBe("configured");
    expect(configured.workingTarget).toBe(800);
  });
  it("counts native definitions and framing in the deterministic byte proxy without claiming tokens", () => {
    const native = {messages: [{role: "user", content: "hello"}], tools: [{name: "x", parameters: {type: "object"}}]};
    expect(createModelNativeInputFootprint(native).bytes).toBe(Buffer.byteLength(JSON.stringify(native)));
    expect(footprint("hello").bytes).toBeGreaterThan(5);
    expect(plan().measurement.status).toBe("unknown");
    expect(plan().allocation).toBeNull();
    expect(plan().generationRoom).toBeNull();
    const generated = createModelNativeInputFootprint({prompt: "hello", system: "role", format: {type: "object"}});
    expect(generated.framingBytes).toBeGreaterThan(0);
    expect(generated.bindingBytes + generated.conversationBytes + generated.framingBytes).toBe(generated.bytes);
  });
  it("uses only a prior accepted anchor and scores a later held-out prediction", () => {
    const cold = plan();
    const first = observeModelInputUsage(cold, usage(100), "response1", true)!;
    const predicted = plan("more text plus 中文", first);
    expect(predicted.measurement).toMatchObject({status: "measured", amount: Math.ceil(100 * footprint("more text plus 中文").bytes / footprint("hello").bytes),
      estimator: {accuracy: "estimated"}});
    expect(predicted.empiricalAllowance).toBeNull();
    const second = observeModelInputUsage(predicted, usage(250, 40), "response2", true)!;
    expect(second.signedError).toBe(250 - (predicted.measurement.status === "measured" ? predicted.measurement.amount : 0));
    expect(second.maximumGrowth).toBe(150);
    expect(second.maximumGeneration).toBe(40);
    expect(plan("next", second).empiricalAllowance).toBe(second.maximumUnderestimate);
    expect(predicted.empiricalAllowance).toBeNull();
    expect(snapshotModelInputPlanning(JSON.parse(JSON.stringify(predicted)))).toEqual(predicted);
  });
  it("isolates run, purpose, mode, schema and fingerprint changes", () => {
    const first = observeModelInputUsage(plan(), usage(100), "response1", true)!;
    for (const overrides of [{runId: "child"}, {purpose: "compaction"},
      {accounting: {...accounting, basis: {...accounting.basis, mode: "think"}}}, {footprint: footprint("hello", {type: "array"})}]) {
      expect(plan("hello", first, overrides).anchor).toBeNull();
    }
    const changed = observeModelInputUsage(plan("next", first), {...usage(200), metadata: {reportedIdentity: "new-model"}}, "r2", true)!;
    expect(changed.previousObservationId).toBeNull();
    expect(changed.signedError).toBeNull();
  });
  it("excludes incomplete, inconsistent, truncated and unqualified usage", () => {
    expect(observeModelInputUsage(plan(), usage(10), null, false)).toBeNull();
    expect(observeModelInputUsage(plan(), {...usage(10), metadata: {accountingConsistent: false}}, null, true)).toBeNull();
    expect(observeModelInputUsage(plan(), {...usage(10), metadata: {inputTruncated: true}}, null, true)).toBeNull();
    expect(observeModelInputUsage(plan("x", null, {accounting: {...accounting, inputUsage: "unknown"}}), usage(10), null, true)).toBeNull();
  });
  it("leaves estimated pressure advisory and never counts cached input as free", () => {
    const first = observeModelInputUsage(plan(), {...usage(2000), metadata: {cachedInputTokens: 2000}}, "r1", true)!;
    const planning = plan("hello", first);
    const assessed = assessModelContext({compositionId: "request", capacity, measurement: planning.measurement, planning,
      requestedOutput: {unit: "tokens", maximum: null, source: "unspecified", revision: "1"},
      headroom: {unit: "tokens", amount: 0, policy: {id: "none", revision: "1"}}, assessedAt: at, revision: "test"});
    expect(assessed.disposition).toBe("estimated_overflow");
    expect(planning.allocation?.used).toBe(2000);
    expect(planning.allocation?.limitations).toContain("required_baseline_exceeds_target");
  });
});
