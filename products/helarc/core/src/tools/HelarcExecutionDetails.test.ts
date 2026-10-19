import {describe, it, expect, vi} from "vitest";
import {snapshotExecutionEvidence, type ExecutionEvidenceRecordPort} from "@agent-anything/operation-catalog/evidence";
import {createHelarcExecutionDetailsHandler, ExecutionMaterialAccessError, HELARC_EXECUTION_DETAILS_BINDING,
  type HelarcExecutionMaterialReader, type HelarcExecutionCollectionReader} from "./HelarcExecutionDetails.js";

function setup() {
  const binding = HELARC_EXECUTION_DETAILS_BINDING;
  const effect = {owner: "files", kind: "effect" as const, id: "effect", revision: "1"};
  const material = {owner: "files", kind: "material" as const, id: "material", revision: "1"};
  const coverage = {scope: "File bytes", extent: "partial" as const, limitations: ["No external-writer exclusion"]};
  const evidence = snapshotExecutionEvidence({ref: {owner: "files", kind: "execution", id: "result", revision: "1"},
    source: {result: {id: "result", invocation: {id: "original", operation: binding.operation}}, resultRevision: "1", binding,
      correlation: {kind: "run_action", run: {id: "run"}, runAction: {id: "action", run: {id: "run"}, sequence: 1},
        materializationRevision: 1, provenance: {kind: "automatic", trigger: {owner: "test", operationId: "test"}}}, lowerRefs: []},
    recordedAt: "2026-10-16T00:00:00.000Z", outcome: {status: "succeeded", effectCertainty: "confirmed", completionExtent: "complete"}, coverage,
    effects: [{ref: effect, schema: {owner: "files", id: "file-change", revision: "1"}, summary: "Content changed", coverage, evidence: [], value: {path: "sample.txt"}}],
    support: [{ref: {owner: "files", kind: "support", id: "support", revision: "1"}, effects: [effect], summary: "Prior content", coverage,
      materials: [{ref: material, label: "Prior bytes", mediaType: "application/octet-stream", byteLength: 8, digest: null, availability: "available", reason: null, expiresAt: null}],
      guidance: [], callables: [{binding, referenceInput: "change_ref", objective: "Restore prior bytes", preconditions: ["Current authority"], limitations: []}]}]});
  const read = vi.fn(async () => evidence), canInspect = vi.fn(async () => true);
  const materials = {describe: vi.fn(async () => ({availability: "expired", reason: "retention_expired"})),
    read: vi.fn<HelarcExecutionMaterialReader["read"]>(async () => ({text: "retained", next_offset: null}))};
  const collections = {read: vi.fn<HelarcExecutionCollectionReader["read"]>(async () => ({references: [evidence.ref], next: null}))};
  const callable = vi.fn(() => "RestoreFile_current");
  const handler = createHelarcExecutionDetailsHandler({records: {readExecutionEvidence: read} as unknown as ExecutionEvidenceRecordPort,
    access: {canInspect}, materials, collections, callable});
  const execute = (request: unknown) => handler.execute({runId: "run", binding: {request, binding,
    invocation: {id: "lookup", operation: binding.operation}}, interruption: {signal: new AbortController().signal}} as never);
  return {evidence, effect, material, read, canInspect, materials, collections, callable, execute};
}

describe("ExecutionDetails owner projection", () => {
  it("pages metadata and separates current availability/catalog names from immutable support", async () => {
    const f = setup();
    const first = await f.execute({reference: f.evidence.ref, limit: 1});
    expect(first).toMatchObject({status: "succeeded", output: {entries: [f.evidence.effects[0]], total: 2, next_offset: 1}});
    const next = await f.execute({reference: f.evidence.ref, offset: 1});
    expect(next).toMatchObject({status: "succeeded", output: {entries: [f.evidence.support[0]], next_offset: null,
      current_materials: [{reference: f.material, current: {availability: "expired"}}], callable_support: [{callable_name: "RestoreFile_current", availability: "exposed"}]}});
    expect(f.evidence.support[0]!.materials[0]!.availability).toBe("available");
    expect(f.materials.read).not.toHaveBeenCalled();
  });
  it("does not read content after reference access rejection and honors current material authority", async () => {
    const f = setup();
    f.canInspect.mockResolvedValueOnce(false);
    expect(await f.execute({reference: f.material, view: "content"})).toMatchObject({status: "invalid", failure: {code: "execution_reference_unavailable"}});
    expect(f.materials.read).not.toHaveBeenCalled();
    f.materials.read.mockRejectedValueOnce(new ExecutionMaterialAccessError("file_material_read_not_authorized", "Current authority denied"));
    expect(await f.execute({reference: f.material, view: "content"})).toMatchObject({status: "invalid", failure: {code: "file_material_read_not_authorized"}});
    expect(f.materials.read.mock.calls[0]?.[0]).toMatchObject({runId: "run", reference: f.material, offset: 0, length: 4096});
  });
  it("returns only the requested byte range or accepted collection cursor", async () => {
    const f = setup();
    expect(await f.execute({reference: f.material, view: "content", offset: 4, limit: 4})).toMatchObject({status: "succeeded"});
    expect(f.materials.read.mock.calls[0]?.[0]).toMatchObject({offset: 4, length: 4});
    expect(await f.execute({reference: f.evidence.ref, view: "executions", after: "cursor", limit: 16})).toMatchObject({status: "succeeded"});
    expect(f.collections.read.mock.calls[0]?.[0]).toMatchObject({after: "cursor", limit: 16});
  });
  it.each([{view: "summary", limit: 17}, {view: "content", limit: 16385}, {view: "summary", after: "cursor"}])("rejects invalid bounded input %j", async options => {
    const f = setup();
    expect(await f.execute({reference: f.evidence.ref, ...options})).toMatchObject({status: "invalid", failure: {code: "execution_details_input_invalid"}});
    expect(f.read).not.toHaveBeenCalled();
  });
  it("keeps owner storage uncertainty distinct from correctable lookup rejection", async () => {
    const f = setup();
    f.read.mockRejectedValueOnce(new Error("owner unreadable"));
    await expect(f.execute({reference: f.evidence.ref})).rejects.toMatchObject({name: "OperationCommitError"});
  });
});
