import { describe, expect, it, vi } from "vitest";
import type { ExecutionEvidenceRecord, CompensationAssociation } from "@agent-anything/operation-catalog/evidence";
import type { InspectionRecorder } from "../recording/index.js";
import { ExecutionEvidenceInspectionAdapter } from "./ExecutionEvidenceInspectionAdapter.js";

function setup() {
  const offer = vi.fn();
  const recorder = {offer, ref: (owner: string, kind: string, id: string, runId: string | null, revision?: string) =>
    ({owner, kind, id, runId, revision: revision ?? null})};
  return {offer, adapter: new ExecutionEvidenceInspectionAdapter(recorder as unknown as InspectionRecorder)};
}
function record(): ExecutionEvidenceRecord {
  const operation = {operation: {namespace: "files", name: "write"}, revision: "1"};
  const coverage = {scope: "file bytes", extent: "partial" as const, limitations: ["External writers are not excluded."]};
  const effect = {owner: "files", kind: "effect" as const, id: "effect-1", revision: "1"};
  return {ref: {owner: "files", kind: "execution", id: "execution-1", revision: "1"},
    source: {result: {id: "result-1", invocation: {id: "invocation-1", operation}}, resultRevision: "1", binding: {operation, revision: "1"},
      correlation: {kind: "run_request", run: {id: "child"}, requestId: "request-1", runBasisRevision: 1, purpose: "test"}, lowerRefs: []},
    recordedAt: "2026-10-15T00:00:00.000Z", outcome: {status: "succeeded", effectCertainty: "confirmed", completionExtent: "complete"}, coverage,
    effects: [{ref: effect, schema: {owner: "files", id: "file-change", revision: "1"}, summary: "File updated", coverage, evidence: [], value: {path: "example.txt"}}],
    support: [{ref: {owner: "files", kind: "support", id: "support-1", revision: "1"}, effects: [effect], summary: "Prior bytes retained", coverage,
      materials: [{ref: {owner: "files", kind: "material", id: "material-1", revision: "1"}, label: "Prior bytes", mediaType: "application/octet-stream",
        byteLength: 12, digest: null, availability: "available", reason: null, expiresAt: null}], guidance: [], callables: []}]};
}

describe("execution evidence inspection", () => {
  it("links an acknowledged collection handoff to its source Run and actual recipient", () => {
    const {adapter, offer} = setup();
    adapter.observe({kind: "references_transferred", transfer: {id: "transfer", sourceRunId: "child", recipientRunId: "parent",
      scope: {kind: "public_run"}, basis: {owner: "agent-runtime", kind: "delegation_result", id: "result", revision: "1"}, acceptedAt: "2026-10-16T00:00:00.000Z"}});
    const value = offer.mock.calls[0]![0];
    expect(value.payload.name).toBe("execution.references.transferred");
    expect(value.links).toEqual(expect.arrayContaining([
      expect.objectContaining({kind: "produces", from: expect.objectContaining({owner: "agent-runtime", kind: "contribution", id: "result", runId: "parent", revision: "1"})}),
      expect.objectContaining({kind: "delivers", to: expect.objectContaining({kind: "run", id: "parent"})}),
      expect.objectContaining({kind: "includes", from: expect.objectContaining({kind: "run", id: "child"})}),
    ]));
  });
  it("records acknowledged provenance and material metadata without reading protected content", () => {
    const {adapter, offer} = setup();
    const value = record();
    adapter.observe({kind: "evidence_committed", record: value});
    expect(offer.mock.calls.map(([input]) => input.payload.name)).toEqual([
      "execution.evidence.committed", "execution.effect.recorded", "execution.support.recorded", "execution.material.described",
    ]);
    const inputs = offer.mock.calls.map(([input]) => input);
    expect(inputs.every(input => input.subject.runId === "child" && input.occurredAt === value.recordedAt)).toBe(true);
    expect(inputs[0].links[0].from.id).toBe("invocation-1");
    expect(inputs[3].contents[0].value).toEqual(value.support[0]!.materials[0]);
    expect(inputs[3].contents[0].value).not.toHaveProperty("content");
  });
  it("keeps cross-Run target identity and labels compensation as intent, not verified success", () => {
    const {adapter, offer} = setup();
    const original = record();
    const association: CompensationAssociation = {id: "intent-2", invocation: {...original.source.result.invocation, id: "invocation-2"},
      correlation: {kind: "run_action", run: {id: "parent"}, runAction: {run: {id: "parent"}, id: "action-2", sequence: 2},
        provenance: {kind: "controller", turn: {run: {id: "parent"}, id: "turn-2", sequence: 2}, candidateIndex: 0}, materializationRevision: 3},
      call: {id: "call-2", turnId: "turn-2"},
      targets: [{requested: original.effects[0]!.ref, execution: original.ref, result: original.source.result,
        resultRevision: "1", sourceCorrelation: original.source.correlation}], explanation: "Restore prior bytes", acceptedAt: original.recordedAt};
    adapter.observe({kind: "compensation_intent_committed", association});
    const input = offer.mock.calls[0]![0];
    expect(input.subject.runId).toBe("parent");
    expect(input.links.at(-1).from).toMatchObject({runId: "child", id: "effect:effect-1"});
    expect(input.links.at(-1).operation).toBe("model_declared_compensation_target");
    expect(JSON.stringify(input)).not.toContain('"compensated":true');
  });
});
