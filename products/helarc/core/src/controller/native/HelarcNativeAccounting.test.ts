import { describe, expect, it, vi } from "vitest";
import type { SharedAcceptancePort, SharedAcceptanceProposal, SharedAcceptanceReceipt } from "@agent-anything/agent-runtime/activity";
import type { ProtocolEvidenceRevision, ProtocolEvidenceWrite, ProtocolExecutionJournal, ProtocolJournalCommand,
  ProtocolJournalValue, ProtocolUsageMerge, ProtocolUsageMergeProposal, ProtocolUsageRetirement } from "@agent-anything/agent-runtime/model-access";
import { modelInputValueDigest as digest } from "@agent-anything/model-interaction/input";
import { OPENAI_RESPONSES } from "@agent-anything/model-interaction/protocol";
import { applyNativeAccountingCommand as apply, calculateNativeCost, createNativeAccountingState,
  nativeAccountingWorkSnapshot, nativeWorkForSubmission, restoreNativeAccountingState,
  type NativeAccountingState, type NativeWorkSubmission } from "@agent-anything/provider-integrations/native";
import { readHelarcNativeWorkPage, retainHelarcNativeWork } from "./HelarcNativeAccounting.js";

const basis = { id: "original", revision: "1" }, at = "2026-11-13T00:00:00.000Z";
const scope = { id: "scope", runId: "run", recipientId: "recipient", purpose: basis, compositionDigest: digest("composition"), owner: "accounting" };
const fence = { activityId: "activity", generation: 1, epoch: 1, controlRevision: 0 };
function submission(id: string): NativeWorkSubmission {
  return { id, protocol: OPENAI_RESPONSES, scope: { runId: scope.runId, activityId: fence.activityId,
    recipientId: scope.recipientId, purpose: scope.purpose, compositionDigest: scope.compositionDigest },
    endpoint: "https://fixture.invalid", account: "fixture", operation: "generation", submittedAt: at, model: "fixture",
    requestedTier: null, reportedTier: null, region: null, modality: "text", reconciliationOwner: scope.owner,
    beneficiaries: ["parent", `child-${id}`], stage: null };
}
function source(id: string, remote: boolean) {
  return { protocol: OPENAI_RESPONSES, scope: submission(id).scope, interpretation: basis, operationId: id, record: { id, revision: "1" },
    position: { format: "json-pointer" as const, value: "/usage" }, nativeIdentity: remote ? { kind: "response", id: "same-response" } : null };
}
function reserved(state: NativeAccountingState, id: string, name = `reserve-${id}`): NativeAccountingState {
  return apply(state, { id: name, kind: "reserve", reservation: { id: name, submissionId: id, resource: "budget", amount: "1.1",
    unit: "USD", guarantee: "estimate", admissionBasis: basis } });
}
function bound(state: NativeAccountingState, id: string): NativeAccountingState {
  return apply(state, { id: `bind-${id}`, kind: "bind_remote", submissionId: id,
    remote: { kind: "response", id: "same-response" }, evidence: source(id, true) });
}
function stateFor(id: string): NativeAccountingState {
  let state = reserved(apply(createNativeAccountingState(), { id: `register-${id}`, kind: "register", submission: submission(id) }), id);
  state = apply(state, { id: `usage-${id}`, kind: "observe", observation: { id: `usage-${id}`, submissionId: id,
    source: source(id, false), receivedAt: at, channel: "stream", finality: "terminal", authority: "fixture", revisionDomain: "response",
    cumulativeRevision: null, profile: { kind: "openai.responses", revision: "1", cacheWrites: "not_applicable", basis },
    usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120, input_tokens_details: { cached_tokens: 0 } } } });
  const any = { match: "any" as const };
  const calculation = calculateNativeCost({ work: nativeWorkForSubmission(state, id), calculation: { id: `price-${id}`, revision: "1" }, decisionAt: at,
    context: { protocol: OPENAI_RESPONSES, endpoint: submission(id).endpoint, account: "fixture", operation: "generation", occurredAt: at,
      model: "fixture", reportedTier: null, region: null, modality: "text", basis }, rates: [{ ref: { id: `rate-${id}`, revision: "1" },
      source: "synthetic original price", kind: "synthetic", protocol: OPENAI_RESPONSES, effectiveFrom: at, effectiveUntil: null,
      endpoint: any, account: any, model: any, reportedTier: any, region: any, modality: any, operation: "generation", inputBand: null,
      currency: "USD", rates: [{ component: "input_tokens.ordinary", unit: "tokens", amount: "2", perUnits: "1000000" }] }],
    additional: [], chargeCoverage: { state: "unknown", basis } });
  return apply(state, { id: `cost:${calculation.revision}`, kind: "record_cost", submissionId: id, calculation });
}
function combined(...states: NativeAccountingState[]): NativeAccountingState {
  let result = createNativeAccountingState();
  for (const state of states) for (const receipt of Object.values(state.commands).sort((a, b) => a.sequence - b.sequence)) result = apply(result, receipt.command);
  return result;
}

/** Core contract fixture only. The storage owner tests SQLite transaction isolation. */
function storage() {
  const heads = new Map<string, ProtocolEvidenceRevision>(), history = new Map<string, ProtocolEvidenceRevision>();
  const aliases = new Map<string, ProtocolUsageRetirement>(), merges = new Map<string, ProtocolUsageMerge>();
  const receipts = new Map<string, SharedAcceptanceReceipt>(), contents = new Map<string, Buffer>();
  let version = 0, beforeAccept: (() => void) | null = null;
  const command = vi.fn(async (command: ProtocolJournalCommand): Promise<ProtocolJournalValue> => {
    switch (command.kind) {
      case "content_begin": if (!contents.has(command.content.id)) contents.set(command.content.id, Buffer.alloc(0)); return command.content;
      case "content_append": {
        const old = contents.get(command.content.id)!, bytes = Buffer.from(command.bytesBase64, "base64");
        if (old.length === command.offset) contents.set(command.content.id, Buffer.concat([old, bytes]));
        return command.content;
      }
      case "content_complete": return command.content;
      case "content_read": {
        const bytes = contents.get(command.content.id)!, end = Math.min(command.offset + command.length, bytes.length);
        return { bytesBase64: bytes.subarray(command.offset, end).toString("base64"), next: end === bytes.length ? null : end };
      }
      case "evidence": return (command.revision === undefined ? heads.get(command.key) : history.get(`${command.key}:${command.revision}`)) ?? null;
      case "usage_retirement": return aliases.get(command.key) ?? null;
      case "usage_merge": return merges.get(command.mergeId) ?? null;
      case "evidence_list": {
        if (command.expectedVersion !== undefined && command.expectedVersion !== version) throw new Error("protocol_evidence_page_version_conflict");
        const all = [...heads.values()].filter(value => (!command.membership || value.memberships.includes(command.membership)) &&
          (command.afterKey === null || value.key > command.afterKey)).sort((a, b) => a.key.localeCompare(b.key));
        const entries = all.slice(0, command.limit);
        return { entries, version, next: all.length > entries.length ? entries.at(-1)!.key : null };
      }
      default: throw new Error(`unexpected command: ${command.kind}`);
    }
  });
  const journal: ProtocolExecutionJournal = { command };
  const accept = vi.fn(async (proposal: SharedAcceptanceProposal): Promise<SharedAcceptanceReceipt> => {
    const prior = receipts.get(proposal.id);
    if (prior) { if (prior.digest !== digest(proposal)) throw new Error("identity_conflict"); return prior; }
    beforeAccept?.();
    const part = proposal.parts[0]!, merge = part.kind === "usage_merge" ? part.proposal as ProtocolUsageMergeProposal : null;
    const write = merge ? merge.survivor : part.proposal as ProtocolEvidenceWrite;
    const valid = (key: string, revision: number | null) => !aliases.has(key) && (heads.get(key)?.revision ?? null) === revision;
    const allowed = valid(write.evidence.key, write.expectedRevision) && (!merge || merge.retired.every(value => valid(value.key, value.expectedRevision)));
    const receipt: SharedAcceptanceReceipt = { id: proposal.id, scope: proposal.scope, sequence: receipts.size + 1, digest: digest(proposal),
      outcome: allowed ? "accepted" : "rejected", rejection: allowed ? null : { owner: "protocol_execution", code: "revision_conflict" } };
    receipts.set(receipt.id, receipt);
    if (!allowed) return receipt;
    const evidence = write.evidence;
    heads.set(evidence.key, evidence); history.set(`${evidence.key}:${evidence.revision}`, evidence); version++;
    if (merge) {
      const retired = merge.retired.map(entry => {
        const original = heads.get(entry.key);
        const alias: ProtocolUsageRetirement = { scopeId: merge.scopeId, key: entry.key, owner: proposal.actor,
          activityId: entry.fence.activityId, mergeId: merge.mergeId, acceptanceId: proposal.id,
          previous: original ? { revision: original.revision, content: original.content } : null,
          survivor: { key: evidence.key, revision: evidence.revision, content: evidence.content } };
        aliases.set(entry.key, alias); heads.delete(entry.key); return alias;
      });
      merges.set(merge.mergeId, { scopeId: merge.scopeId, mergeId: merge.mergeId, owner: proposal.actor, acceptanceId: proposal.id,
        version, survivor: evidence, retired, proposal: merge });
    }
    return receipt;
  });
  const query = vi.fn(async (id: string) => receipts.get(id) ?? null);
  const acceptance: SharedAcceptancePort = { accept, query };
  const args = (state: NativeAccountingState, submissionId: string, expectedRevision: number | null) => ({ journal, acceptance,
    scope, fence, state, submissionId, expectedRevision, cost: null, references: [], dependencies: [] });
  const packet = (evidence: ProtocolEvidenceRevision) => JSON.parse(contents.get(evidence.content.id)!.toString("utf8")) as { state: NativeAccountingState };
  return { journal, acceptance, command, accept, query, heads, history, aliases, merges, receipts, args, packet,
    beforeAccept: (fn: () => void) => { beforeAccept = fn; } };
}
async function twoWorks() {
  const store = storage(), a = stateFor("a"), b = bound(stateFor("b"), "b");
  const originalA = await retainHelarcNativeWork(store.args(a, "a", null));
  const originalB = await retainHelarcNativeWork(store.args(b, "b", null));
  const state = bound(combined(a, b), "a");
  return { store, a, b, originalA, originalB, state, args: store.args(state, "a", 0) };
}

describe("durable native accounting merge", () => {
  it("reads both originals and accepts one survivor plus retirement with replayable obligations and prices", async () => {
    const f = await twoWorks(); f.store.command.mockClear();
    const saved = await retainHelarcNativeWork(f.args);
    expect(f.store.heads.size).toBe(1); expect(f.store.history.size).toBe(3);
    expect(f.store.aliases.get(f.originalA.key)?.previous).toEqual({ revision: 0, content: f.originalA.content });
    const part = f.store.accept.mock.calls.at(-1)![0].parts[0]!;
    expect(part.kind).toBe("usage_merge");
    expect((part.proposal as ProtocolUsageMergeProposal).retired).toEqual([{ key: f.originalA.key, fence, expectedRevision: 0 }]);
    expect(f.store.command.mock.calls.filter(([c]) => c.kind === "content_read")).toHaveLength(2);
    const restored = restoreNativeAccountingState(f.store.packet(saved).state);
    expect(restored).toEqual(nativeAccountingWorkSnapshot(f.state, "a"));
    expect(Object.values(restored.reservations).map(value => value.status)).toEqual(["held", "held"]);
    expect(nativeWorkForSubmission(restored, "a").costCalculations.map(value => value.rateBases[0]!.ref.id)).toEqual(["rate-b", "rate-a"]);
    expect(saved.memberships).toEqual(["child-a", "child-b", "parent"]);
    const page = await readHelarcNativeWorkPage({ journal: f.store.journal, activityId: fence.activityId, scopeId: scope.id,
      afterKey: null, limit: 10, membership: "parent" });
    expect(page.entries).toHaveLength(1); expect(page.entries[0]!.inputTokens).toBe(100); expect(page.version).toBe(3);
  });
  it("rejects lost durable progress on either participant before staging or accepting", async () => {
    for (const id of ["a", "b"]) {
      const f = await twoWorks(), later = reserved(id === "a" ? f.a : f.b, id, `late-${id}`);
      await retainHelarcNativeWork(f.store.args(later, id, 0));
      f.store.accept.mockClear(); f.store.command.mockClear();
      await expect(retainHelarcNativeWork({ ...f.args, expectedRevision: id === "b" ? 1 : 0 })).rejects.toThrow("progress_not_preserved");
      expect(f.store.accept).not.toHaveBeenCalled();
      expect(f.store.command.mock.calls.some(([command]) => command.kind === "content_begin")).toBe(false);
    }
  });
  it("binds both read revisions to CAS and does not retire anyone if a participant advances", async () => {
    const f = await twoWorks();
    f.store.beforeAccept(() => f.store.heads.set(f.originalA.key, { ...f.originalA, revision: 1 }));
    await expect(retainHelarcNativeWork(f.args)).rejects.toThrow("revision_conflict");
    expect(f.store.heads.get(f.originalB.key)).toEqual(f.originalB); expect(f.store.aliases.size).toBe(0); expect(f.store.merges.size).toBe(0);
  });
  it("recovers a whole lost ACK under a new generation before reading newer snapshots", async () => {
    const f = await twoWorks();
    const losing: SharedAcceptancePort = { query: f.store.query, accept: async proposal => { await f.store.accept(proposal); throw new Error("lost_ack"); } };
    await expect(retainHelarcNativeWork({ ...f.args, acceptance: losing })).rejects.toThrow("lost_ack");
    const original = [...f.store.merges.values()][0]!;
    const advanced = reserved(f.state, "a", "post-merge-reservation");
    await retainHelarcNativeWork(f.store.args(advanced, "a", 1));
    f.store.accept.mockClear(); f.store.command.mockClear(); f.store.query.mockClear();
    const recovered = await retainHelarcNativeWork({ ...f.args, fence: { ...fence, generation: 2, epoch: 9, controlRevision: 2 } });
    expect(recovered).toEqual(original.survivor); expect(f.store.accept).not.toHaveBeenCalled();
    expect(f.store.query).toHaveBeenCalledWith(original.acceptanceId);
    expect(f.store.command.mock.calls.map(([command]) => command.kind)).toEqual(["usage_merge"]);
  });
  it("requires the original complete acceptance receipt, not only the survivor or a differently fenced receipt", async () => {
    const f = await twoWorks(); await retainHelarcNativeWork(f.args);
    const original = [...f.store.merges.values()][0]!, receipt = f.store.receipts.get(original.acceptanceId)!;
    f.store.receipts.set(receipt.id, { ...receipt, digest: digest({ wrongFence: 2 }) });
    await expect(retainHelarcNativeWork({ ...f.args, fence: { ...fence, generation: 2 } })).rejects.toThrow("merge_receipt_invalid");
    f.store.receipts.clear(); f.store.merges.clear(); f.store.aliases.clear();
    f.store.heads.set(f.originalA.key, f.originalA);
    await expect(retainHelarcNativeWork(f.args)).rejects.toThrow("merge_receipt_missing");
    expect(f.store.aliases.size).toBe(0);
  });
  it("uses a new attempt identity after a rejected fence while keeping the logical merge stable", async () => {
    const f = await twoWorks();
    f.store.accept.mockImplementationOnce(async proposal => {
      const receipt: SharedAcceptanceReceipt = { id: proposal.id, scope: proposal.scope, digest: digest(proposal), sequence: 3,
        outcome: "rejected", rejection: { owner: "protocol_execution", code: "fence_changed" } };
      f.store.receipts.set(receipt.id, receipt); return receipt;
    });
    await expect(retainHelarcNativeWork(f.args)).rejects.toThrow("fence_changed");
    const rejected = f.store.accept.mock.calls.at(-1)![0];
    await retainHelarcNativeWork({ ...f.args, fence: { ...fence, generation: 2, epoch: 2 } });
    const accepted = f.store.accept.mock.calls.at(-1)![0];
    expect(accepted.id).not.toBe(rejected.id);
    expect((accepted.parts[0]!.proposal as ProtocolUsageMergeProposal).mergeId).toBe((rejected.parts[0]!.proposal as ProtocolUsageMergeProposal).mergeId);
    expect([...f.store.merges.values()][0]!.proposal.survivor.fence.generation).toBe(2);
  });
  it("retires unpublished identities too, without substituting zero usage", async () => {
    const store = storage(), a = stateFor("a"), b = bound(stateFor("b"), "b");
    await retainHelarcNativeWork(store.args(b, "b", null));
    await retainHelarcNativeWork(store.args(bound(combined(a, b), "a"), "a", 0));
    const alias = [...store.aliases.values()][0]!;
    expect(alias.previous).toBeNull();
    await expect(retainHelarcNativeWork(store.args(a, "a", null))).rejects.toThrow("survivor_retired");
  });
  it("confirms an old ordinary lost ACK after retirement but rejects any new revision without writes", async () => {
    const f = await twoWorks(); await retainHelarcNativeWork(f.args);
    f.store.accept.mockClear(); f.store.command.mockClear();
    expect(await retainHelarcNativeWork({ ...f.store.args(f.a, "a", null), fence: { ...fence, generation: 2 } })).toEqual(f.originalA);
    expect(f.store.accept).not.toHaveBeenCalled();
    expect(f.store.command.mock.calls.some(([command]) => command.kind === "content_read")).toBe(false);
    await expect(retainHelarcNativeWork(f.store.args(reserved(f.a, "a", "new-after-retirement"), "a", 0))).rejects.toThrow("survivor_retired");
    expect(f.store.accept).not.toHaveBeenCalled();
  });
  it("preserves chained retirements and recovers both the older merge and a later ordinary write", async () => {
    const f = await twoWorks(), firstMerge = await retainHelarcNativeWork(f.args);
    const advanced = reserved(f.state, "a", "between-merges"), ordinaryArgs = f.store.args(advanced, "a", 1);
    const losing: SharedAcceptancePort = { query: f.store.query, accept: async proposal => { await f.store.accept(proposal); throw new Error("lost_ack"); } };
    await expect(retainHelarcNativeWork({ ...ordinaryArgs, acceptance: losing })).rejects.toThrow("lost_ack");
    const ordinary = f.store.history.get(`${firstMerge.key}:2`)!;
    const c = bound(stateFor("c"), "c"); await retainHelarcNativeWork(f.store.args(c, "c", null));
    const nextState = combined(c, advanced), saved = await retainHelarcNativeWork(f.store.args(nextState, "c", 0));
    expect(f.store.heads.size).toBe(1); expect(saved.memberships).toEqual(["child-a", "child-b", "child-c", "parent"]);
    expect(f.store.aliases.get(f.originalA.key)!.survivor.key).toBe(firstMerge.key);
    expect(f.store.aliases.get(firstMerge.key)!.survivor.key).toBe(saved.key);
    expect(restoreNativeAccountingState(f.store.packet(saved).state)).toEqual(nativeAccountingWorkSnapshot(nextState, "c"));
    f.store.accept.mockClear(); f.store.command.mockClear();
    expect(await retainHelarcNativeWork({ ...f.args, fence: { ...fence, generation: 2 } })).toEqual(firstMerge);
    expect(await retainHelarcNativeWork({ ...ordinaryArgs, fence: { ...fence, generation: 2 } })).toEqual(ordinary);
    expect(f.store.accept).not.toHaveBeenCalled();
    expect(f.store.command.mock.calls.some(([command]) => command.kind === "content_read")).toBe(false);
  });
  it("keeps aliases inside the original scope and rejects cyclic or unrelated targets", async () => {
    const f = await twoWorks(); await retainHelarcNativeWork(f.args);
    const alias = f.store.aliases.get(f.originalA.key)!;
    const later = f.store.args(reserved(f.state, "a", "later"), "a", 1);
    for (const bad of [{ ...alias, scopeId: "other-scope" }, { ...alias, survivor: { ...alias.survivor, key: alias.key } },
      { ...alias, survivor: { ...alias.survivor, key: "outside-plan" } }]) {
      f.store.aliases.set(alias.key, bad);
      await expect(retainHelarcNativeWork(later)).rejects.toThrow(/alias_scope_changed|alias_invalid/);
    }
    await expect(retainHelarcNativeWork({ ...later, scope: { ...scope, runId: "another" } })).rejects.toThrow("scope_changed");
  });
  it("carries paging versions and rejects mixed-version continuation without hydrating raw bodies", async () => {
    const f = await twoWorks(); f.store.command.mockClear();
    const args = { journal: f.store.journal, activityId: fence.activityId, scopeId: scope.id, afterKey: null, limit: 1 };
    const first = await readHelarcNativeWorkPage(args); expect(first.next).not.toBeNull();
    expect(f.store.command.mock.calls.map(([command]) => command.kind)).toEqual(["evidence_list"]);
    await expect(readHelarcNativeWorkPage({ ...args, afterKey: first.next })).rejects.toThrow("page_version_required");
    const next = await readHelarcNativeWorkPage({ ...args, afterKey: first.next, expectedVersion: first.version });
    expect(next.version).toBe(first.version);
    await retainHelarcNativeWork(f.args);
    await expect(readHelarcNativeWorkPage({ ...args, afterKey: first.next, expectedVersion: first.version })).rejects.toThrow("page_version_conflict");
  });
});
