import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";
import { snapshotExecutionEvidence, resolveCompensationAssociation, type ExecutionEvidenceRecord, type CompensationAssociation } from "@agent-anything/operation-catalog/evidence";
import { ExecutionDatabase } from "./ExecutionDatabase.js";
import { HelarcExecutionStore } from "./HelarcExecutionStore.js";

const directories: string[] = [];
const resources: {close(): void | Promise<void>}[] = [];
afterEach(async () => {
  for (const resource of resources.splice(0).reverse()) await resource.close();
  for (const path of directories.splice(0)) rmSync(path, {recursive: true});
});
function directory() { const path = mkdtempSync(join(tmpdir(), "execution-evidence-")); directories.push(path); return path; }
function evidence(): ExecutionEvidenceRecord {
  const operation = {operation: {namespace: "local", name: "command"}, revision: "1"};
  const coverage = {scope: "process lifecycle and captured output", extent: "partial" as const, limitations: ["Arbitrary command effects are not inventoried."]};
  return snapshotExecutionEvidence({ref: {owner: "commands", kind: "execution", id: "command-invocation-1", revision: "1"},
    source: {result: {id: "result-1", invocation: {id: "invocation-1", operation}}, resultRevision: "1", binding: {operation, revision: "1"},
      correlation: {kind: "owner_operation", owner: "commands", operationId: "command-1", operationRevision: "1"}, lowerRefs: []},
    recordedAt: "2026-10-15T00:00:00.000Z", outcome: {status: "failed", effectCertainty: "unknown", completionExtent: "unknown"}, coverage,
    effects: [], support: [{ref: {owner: "commands", kind: "support", id: "logs-1", revision: "1"}, effects: [], summary: "Inspect retained output", coverage,
      materials: [{ref: {owner: "commands", kind: "material", id: "stdout-1", revision: "1"}, label: "Captured stdout", mediaType: "text/plain",
        byteLength: 100, digest: null, availability: "available", reason: null, expiresAt: null}], guidance: [], callables: []}]});
}
function association(value: ExecutionEvidenceRecord): CompensationAssociation {
  return {id: "association-2", invocation: {...value.source.result.invocation, id: "invocation-2"},
    correlation: {kind: "run_action", run: {id: "run-1"}, runAction: {run: {id: "run-1"}, id: "action-2", sequence: 2},
      provenance: {kind: "controller", turn: {run: {id: "run-1"}, id: "turn-2", sequence: 2}, candidateIndex: 0}, materializationRevision: 8},
    call: {id: "call-2", turnId: "turn-2"}, targets: [{requested: value.ref, execution: value.ref, result: value.source.result,
      resultRevision: value.source.resultRevision, sourceCorrelation: value.source.correlation}],
    explanation: "Investigate and compensate the earlier command.", acceptedAt: value.recordedAt};
}

describe("execution evidence persistence", () => {
  it("commits every member atomically, rejects conflicting identities and preserves unknown effects", () => {
    const database = new ExecutionDatabase(directory()); resources.push(database);
    const value = evidence();
    database.commitExecutionEvidence(database.generation, value);
    database.commitExecutionEvidence(database.generation, value);
    expect(database.readExecutionEvidence(value.support[0]!.materials[0]!.ref)).toEqual(value);
    expect(database.readExecutionEvidence({...value.ref, revision: "2"})).toBeNull();
    expect(() => database.commitExecutionEvidence(database.generation, {...value, outcome: {...value.outcome, status: "succeeded"}})).toThrow("execution_evidence_conflict");
    const conflicting = {...value, ref: {...value.ref, id: "different-execution"}};
    expect(() => database.commitExecutionEvidence(database.generation, conflicting)).toThrow("execution_evidence_member_conflict");
    expect(database.readExecutionEvidence(conflicting.ref)).toBeNull();
    expect(database.readExecutionEvidence(value.ref)?.outcome.effectCertainty).toBe("unknown");
  });
  it("requires retained exact target results before accepting a compensation intent", () => {
    const database = new ExecutionDatabase(directory()); resources.push(database);
    const value = evidence();
    const intent = association(value);
    expect(() => database.commitCompensationAssociation(database.generation, intent)).toThrow("execution_compensation_source_invalid");
    expect(database.readCompensationAssociation(intent.invocation.id)).toBeNull();
    database.commitExecutionEvidence(database.generation, value);
    expect(() => database.commitCompensationAssociation(database.generation, {...intent, targets: [{...intent.targets[0]!, resultRevision: "2"}]})).toThrow("execution_compensation_source_invalid");
    database.commitCompensationAssociation(database.generation, intent);
    database.commitCompensationAssociation(database.generation, intent);
    expect(() => database.commitCompensationAssociation(database.generation, {...intent, explanation: "Different intent"})).toThrow("execution_compensation_conflict");
    expect(database.readExecutionEvidence(value.ref)).toEqual(value);
  });
  it("retains exact support and model intent through a real Worker restart without granting access", async () => {
    const path = directory();
    const worker = pathToFileURL(join(process.cwd(), "dist/main/execution-storage/ExecutionStoreWorker.js"));
    const original = await HelarcExecutionStore.open(path, worker); resources.push(original);
    const value = evidence();
    await original.commitExecutionEvidence(value);
    const intent = association(value);
    await original.commitCompensationAssociation(intent);
    await original.close();
    const restored = await HelarcExecutionStore.open(path, worker); resources.push(restored);
    expect(restored.generation).toBeGreaterThan(original.generation);
    expect(await restored.readExecutionEvidence(value.support[0]!.ref)).toEqual(value);
    expect(await restored.readCompensationAssociation(intent.invocation.id)).toEqual(intent);
    await expect(resolveCompensationAssociation({runId: "run-1", records: restored, access: {async canInspect() {return false;}},
      proposal: {...intent, targets: [value.ref]}})).rejects.toMatchObject({code: "execution_reference_unavailable"});
    await restored.commitExecutionEvidence(value);
    await restored.commitCompensationAssociation(intent);
  });
  it("rejects stale writers and damaged evidence rather than returning a partial replacement", () => {
    const path = directory();
    const first = new ExecutionDatabase(path); resources.push(first);
    const value = evidence();
    first.commitExecutionEvidence(first.generation, value);
    const generation = first.generation;
    first.close();
    const current = new ExecutionDatabase(path); resources.push(current);
    expect(() => current.commitExecutionEvidence(generation, value)).toThrow("execution_owner_stale");
    const tamper = new Database(join(path, "execution.sqlite"));
    tamper.prepare("UPDATE execution_evidence SET value=?").run(JSON.stringify({...value, support: []}));
    tamper.close();
    expect(() => current.readExecutionEvidence(value.ref)).toThrow("execution_evidence_corrupt");
  });
});
