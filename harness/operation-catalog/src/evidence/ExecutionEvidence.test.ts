import { describe, expect, it } from "vitest";
import { evidenceMemberRefs, snapshotExecutionEvidence, validateExecutionEffectSchemas, type ExecutionEvidenceRecord } from "./ExecutionEvidence.js";
import { resolveCompensationAssociation, resolveExecutionEvidence } from "./ExecutionEvidenceLookup.js";
import type { ExecutionEvidenceRecordPort } from "./ExecutionEvidencePort.js";

function evidence(): ExecutionEvidenceRecord {
  const operation = {operation: {namespace: "local", name: "write"}, revision: "1"};
  const effect = {owner: "files", kind: "effect" as const, id: "change-1", revision: "1"};
  const coverage = {scope: "one file content", extent: "complete" as const, limitations: ["Other resource effects not assessed."]};
  return {ref: {owner: "files", kind: "execution", id: "execution-1", revision: "1"},
    source: {result: {id: "result-1", invocation: {id: "invocation-1", operation}}, resultRevision: "1",
      binding: {operation, revision: "1"}, correlation: {kind: "owner_operation", owner: "files", operationId: "invocation-1", operationRevision: "1"}, lowerRefs: []},
    recordedAt: "2026-10-15T00:00:00.000Z", outcome: {status: "succeeded", effectCertainty: "confirmed", completionExtent: "complete"}, coverage,
    effects: [{ref: effect, schema: {owner: "files", id: "file-change", revision: "1"}, summary: "File bytes changed", coverage, evidence: [], value: {before: "a", after: "b"}}],
    support: [{ref: {owner: "files", kind: "support", id: "support-1", revision: "1"}, effects: [effect], summary: "Earlier bytes retained", coverage,
      materials: [{ref: {owner: "files", kind: "material", id: "bytes-1", revision: "1"}, label: "Previous content", mediaType: "application/octet-stream",
        byteLength: 1, digest: "sha256:abc", availability: "available", reason: null, expiresAt: null}],
      guidance: ["Inspect the earlier bytes before choosing a new operation."], callables: []}]};
}
function records(value: ExecutionEvidenceRecord): ExecutionEvidenceRecordPort {
  return {async readExecutionEvidence() {return value;}, async commitExecutionEvidence() {}, async commitCompensationAssociation() {}, async readCompensationAssociation() {return null;}};
}

describe("capability execution evidence", () => {
  it("separates evidence, materials and guidance without requiring an inverse", () => {
    const original = evidence();
    const saved = snapshotExecutionEvidence(original);
    expect(evidenceMemberRefs(saved).map(ref => ref.kind)).toEqual(["execution", "effect", "support", "material"]);
    expect(saved.support[0]!.callables).toEqual([]);
    (original.effects[0]!.value as {before: string}).before = "changed";
    expect(saved.effects[0]!.value).toEqual({before: "a", after: "b"});
    expect(Object.isFrozen(saved.effects[0]!.value)).toBe(true);
  });
  it.each(["failed", "partial", "cancelled", "unknown_effect"] as const)("retains known support on a %s outcome", status => {
    const value = evidence();
    const saved = snapshotExecutionEvidence({...value, outcome: {status, effectCertainty: "unknown", completionExtent: "unknown"}});
    expect(saved.support).toHaveLength(1);
    expect(saved.outcome.effectCertainty).toBe("unknown");
  });
  it("does not infer no effects from an empty inventory", () => {
    const value = snapshotExecutionEvidence({...evidence(), effects: [], support: [],
      coverage: {scope: "arbitrary command effects", extent: "not_assessed", limitations: ["No complete effect inventory."]}});
    expect(value.coverage.extent).toBe("not_assessed");
    expect(value.outcome.effectCertainty).toBe("confirmed");
  });
  it("requires exact owner schemas for domain claims", () => {
    const value = snapshotExecutionEvidence(evidence());
    expect(() => validateExecutionEffectSchemas(value, [])).toThrow("schema validation");
    expect(() => validateExecutionEffectSchemas(value, [{owner: "files", id: "file-change", revision: "1", validate: () => false}])).toThrow();
    validateExecutionEffectSchemas(value, [{owner: "files", id: "file-change", revision: "1", validate: data => typeof data === "object"}]);
  });
  it("rejects duplicate or unrelated member and support identities", () => {
    const value = evidence();
    expect(() => snapshotExecutionEvidence({...value, effects: [value.effects[0]!, value.effects[0]!]})).toThrow();
    expect(() => snapshotExecutionEvidence({...value, effects: [{...value.effects[0]!, ref: {...value.effects[0]!.ref, owner: "other"}}]})).toThrow();
    expect(() => snapshotExecutionEvidence({...value, effects: []})).toThrow("support effect link");
  });
  it("rejects malformed source, payload and unavailable material without a reason", () => {
    const value = evidence();
    expect(() => snapshotExecutionEvidence({...value, source: {...value.source, binding: {...value.source.binding, operation: {...value.source.binding.operation, revision: "2"}}}})).toThrow("source binding");
    expect(() => snapshotExecutionEvidence({...value, effects: [{...value.effects[0]!, value: {bad: Infinity}}]})).toThrow();
    const support = value.support[0]!;
    expect(() => snapshotExecutionEvidence({...value, support: [{...support, materials: [{...support.materials[0]!, availability: "expired", reason: null}]}]})).toThrow("availability");
  });
  it("checks current access and exact membership even when the store found a record", async () => {
    const value = evidence();
    const input = {runId: "recipient", reference: value.ref, records: records(value), access: {async canInspect() {return false;}}};
    await expect(resolveExecutionEvidence(input)).rejects.toMatchObject({code: "execution_reference_unavailable"});
    await expect(resolveExecutionEvidence({...input, reference: {...value.ref, revision: "2"}, access: {async canInspect() {return true;}}})).rejects.toMatchObject({code: "execution_reference_unavailable"});
    expect(await resolveExecutionEvidence({...input, access: {async canInspect() {return true;}}})).toEqual(value);
  });
  it("resolves all compensation targets and preserves model intent independently of success", async () => {
    const value = evidence();
    const proposal = {id: "intent-1", invocation: {...value.source.result.invocation, id: "new-invocation"},
      correlation: {kind: "run_action" as const, run: {id: "run-1"}, runAction: {id: "action-2", run: {id: "run-1"}, sequence: 2},
        provenance: {kind: "controller" as const, turn: {id: "turn-2", run: {id: "run-1"}, sequence: 2}, candidateIndex: 0}, materializationRevision: 9},
      call: {id: "call-2", turnId: "turn-2"}, targets: [value.effects[0]!.ref], explanation: "The objective changed.", acceptedAt: value.recordedAt};
    const input = {proposal, runId: "run-1", records: records(value), access: {async canInspect() {return true;}}};
    const resolved = await resolveCompensationAssociation(input);
    expect(resolved.targets[0]).toMatchObject({execution: value.ref, result: value.source.result});
    expect(resolved).not.toHaveProperty("compensated");
    await expect(resolveCompensationAssociation({...input, proposal: {...proposal, targets: [...proposal.targets, {...value.ref, id: "unknown"}]}})).rejects.toMatchObject({code: "execution_reference_unavailable"});
    await expect(resolveCompensationAssociation({...input, proposal: {...proposal, targets: [value.effects[0]!.ref, value.effects[0]!.ref]}})).rejects.toThrow("duplicate");
    await expect(resolveCompensationAssociation({...input, runId: "other-run"})).rejects.toThrow("requesting Run");
  });
});
