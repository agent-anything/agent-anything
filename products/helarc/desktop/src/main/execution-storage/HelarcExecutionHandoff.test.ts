import {describe, it, expect, vi} from "vitest";
import {executionEvidenceKey, type ExecutionEvidenceRecord, type ExecutionEvidenceRef, type ExecutionReferenceTransfer} from "@agent-anything/operation-catalog/evidence";
import type {HelarcExecutionStore} from "./HelarcExecutionStore.js";
import {createHelarcExecutionHandoff} from "./HelarcExecutionHandoff.js";

const at = "2026-10-16T00:00:00.000Z";
function fixture() {
  const reference = (kind: ExecutionEvidenceRef["kind"], id = kind): ExecutionEvidenceRef => ({owner: "files", kind, id, revision: "1"});
  const effect = reference("effect"), material = reference("material"), support = reference("support");
  const record = {ref: reference("execution"), source: {correlation: {kind: "run_action", run: {id: "child"}}},
    effects: [{ref: effect}], support: [{ref: support, effects: [effect], materials: [{ref: material}]}]} as unknown as ExecutionEvidenceRecord;
  const request = {ref: {id: "request-child", revision: "1"}, origin: {parent: {run: {id: "parent"}}, root: {run: {id: "parent"}}},
    task: {input: {}}, continuation: null};
  const admissions = new Map<string, unknown>([["child", request]]);
  const transfers: ExecutionReferenceTransfer[] = [];
  const store = {
    readRunCommit: vi.fn(async (id: string) => ({admission: {delegationRequest: admissions.get(id.replace(/:commit:0$/u, "")) ?? null,
      lineage: {root: {id: "parent"}}}, state: {startedAt: at}})),
    readLatestRun: vi.fn(async () => ({state: {settlement: {kind: "completed"}}})),
    readExecutionEvidence: vi.fn(async (ref: ExecutionEvidenceRef) => [record.ref, effect, support, material].some(value => executionEvidenceKey(value) === executionEvidenceKey(ref)) ? record : null),
    readExecutionReferenceTransfers: vi.fn(async (id: string) => transfers.filter(t => t.recipientRunId === id)),
    commitExecutionReferenceTransfer: vi.fn(async (t: ExecutionReferenceTransfer) => {if (!transfers.some(prior => prior.id === t.id)) transfers.push(t);}),
    readRunExecutionReferences: vi.fn(async () => ({references: [record.ref], next: null})),
    readProductRun: vi.fn(async () => ({sessionId: "session", identity: {id: "user"}})),
  };
  const service = createHelarcExecutionHandoff(store as unknown as HelarcExecutionStore);
  const result = {correlation: {child: {run: {id: "child"}}, origin: request.origin}, request: request.ref,
    ref: {id: "result-child", revision: "1"}, createdAt: at} as Parameters<typeof service.handoff.project>[0];
  const can = (runId: string, ref: ExecutionEvidenceRef = record.ref) => service.access.canInspect({runId, record, reference: ref});
  return {store, service, record, effect, support, material, request, admissions, transfers, result, can};
}

describe("accepted execution reference handoffs", () => {
  it("does not infer Parent access from ancestry; acknowledges the exact settled result before publication", async () => {
    const f = fixture();
    expect(await f.can("parent")).toBe(false);
    expect(await f.can("unrelated")).toBe(false);
    await expect(f.service.handoff.project(f.result)).resolves.toEqual({references: [f.record.ref], next: null});
    expect(await f.can("parent", f.material)).toBe(true);
    expect(await f.can("unrelated", f.material)).toBe(false);
    await f.service.handoff.project(f.result);
    expect(f.transfers).toHaveLength(1);
    await expect(f.service.handoff.project({...f.result, request: {...f.result.request, revision: "stale"}}))
      .rejects.toMatchObject({name: "OperationCommitError"});
  });
  it("only forwards selected disclosed references and linked material to a sibling", async () => {
    const f = fixture();
    await f.service.handoff.project(f.result);
    f.admissions.set("sibling", {...f.request, ref: {id: "request-sibling", revision: "1"}, task: {input: {execution_refs: [f.effect]}}});
    expect(await f.can("sibling", f.effect)).toBe(true);
    expect(await f.can("sibling", f.material)).toBe(true);
    expect(await f.can("sibling", f.record.ref)).toBe(false);
    await expect(f.service.collections.read({runId: "sibling", reference: f.effect, after: null, limit: 4}))
      .rejects.toMatchObject({code: "execution_collection_inaccessible"});
    await expect(f.service.handoff.validate("sibling", [{...f.effect, revision: "stale"}])).rejects.toThrow("not delivered");
    const restarted = createHelarcExecutionHandoff(f.store as unknown as HelarcExecutionStore);
    expect(await restarted.access.canInspect({runId: "sibling", record: f.record, reference: f.material})).toBe(true);
    expect(f.transfers).toHaveLength(2);
  });
  it("carries source visibility through an accepted continuation without granting unrelated access", async () => {
    const f = fixture();
    f.admissions.set("continued", {...f.request, ref: {id: "request-continued", revision: "1"}, continuation: {
      sourceChild: {id: "child"}, sourceRequest: f.request.ref, sourceResult: f.result.ref}});
    expect(await f.can("continued", f.material)).toBe(true);
    expect(await f.can("unrelated", f.material)).toBe(false);
    f.admissions.set("forged", {...f.request, continuation: {sourceChild: {id: "child"}, sourceRequest: {...f.request.ref, revision: "stale"}}});
    await expect(f.can("forged")).rejects.toMatchObject({name: "OperationCommitError"});
  });
  it("requires a settled collection and matching work context for a later Run transfer", async () => {
    const f = fixture();
    await f.service.handoff.project(f.result);
    await f.service.transferToLaterRun({sourceRunId: "parent", recipientRunId: "later", references: [f.effect],
      basis: {owner: "host", kind: "accepted_input", id: "input", revision: "1"}, acceptedAt: at});
    expect(await f.can("later", f.effect)).toBe(true);
    f.store.readProductRun.mockResolvedValueOnce({sessionId: "other", identity: {id: "user"}});
    await expect(f.service.transferToLaterRun({sourceRunId: "parent", recipientRunId: "later2", references: [f.effect],
      basis: {owner: "host", kind: "accepted_input", id: "input2", revision: "1"}, acceptedAt: at})).rejects.toThrow("same retained Product session");
    f.store.readLatestRun.mockResolvedValue({state: {settlement: null}} as never);
    await expect(f.service.collections.read({runId: "parent", reference: f.record.ref, after: null, limit: 4}))
      .rejects.toMatchObject({code: "execution_collection_not_settled"});
  });
  it.each(["read", "commit"])("does not publish a Child result after uncertain %s acknowledgement", async stage => {
    const f = fixture();
    (stage === "read" ? f.store.readLatestRun : f.store.commitExecutionReferenceTransfer).mockRejectedValueOnce(new Error("lost owner acknowledgement"));
    await expect(f.service.handoff.project(f.result)).rejects.toMatchObject({name: "OperationCommitError"});
    expect(f.store.readRunExecutionReferences).not.toHaveBeenCalled();
  });
});
