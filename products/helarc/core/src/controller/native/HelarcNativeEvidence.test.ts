import { describe, expect, it, vi } from "vitest";
import { modelInputValueDigest as digest } from "@agent-anything/model-interaction/input";
import { snapshotModelJsonValue } from "@agent-anything/model-interaction";
import type { SharedAcceptanceProposal, SharedAcceptanceReceipt } from "@agent-anything/agent-runtime/activity";
import type { ProtocolEvidencePart, ProtocolEvidenceRevision, ProtocolExecutionFence, ProtocolJournalCommand,
  ProtocolJournalValue } from "@agent-anything/agent-runtime/model-access";
import { retainHelarcNativeEvidence } from "./HelarcNativeEvidence.js";

type EvidencePart = Extract<ProtocolEvidencePart, { kind: "evidence" }>;
const evidenceKey = (value: Pick<ProtocolEvidenceRevision, "scopeId" | "kind" | "key" | "revision">) =>
  digest([value.scopeId, value.kind, value.key, value.revision]);

function fixture(loseAcceptedAck = false) {
  const retained = new Map<string, ProtocolEvidenceRevision>(), receipts = new Map<string, SharedAcceptanceReceipt>();
  let currentFence: ProtocolExecutionFence = { activityId: "count:1", generation: 1, epoch: 1, controlRevision: 0 };
  const command = vi.fn(async (command: ProtocolJournalCommand): Promise<ProtocolJournalValue> => {
    if (command.kind === "evidence") {
      if (command.revision === undefined) throw new TypeError("fixture_requires_exact_revision");
      return retained.get(evidenceKey({ scopeId: command.scopeId, kind: command.evidenceKind, key: command.key, revision: command.revision })) ?? null;
    }
    if (command.kind === "content_begin" || command.kind === "content_append" || command.kind === "content_complete") return command.content;
    throw new TypeError(`unexpected_journal_command:${command.kind}`);
  });
  const accept = vi.fn(async (proposal: SharedAcceptanceProposal): Promise<SharedAcceptanceReceipt> => {
    const proposalDigest = digest(proposal), prior = receipts.get(proposal.id);
    if (prior) {
      if (prior.digest !== proposalDigest) throw new TypeError("acceptance_identity_conflict");
      return prior;
    }
    expect(proposal.parts).toHaveLength(1);
    const part = proposal.parts[0] as EvidencePart;
    expect(part).toMatchObject({ owner: "protocol_execution", kind: "evidence" });
    const rejection = digest(part.proposal.fence) === digest(currentFence) ? null : { owner: "protocol_execution", code: "fenced" };
    const receipt: SharedAcceptanceReceipt = { id: proposal.id, digest: proposalDigest, sequence: receipts.size + 1,
      scope: proposal.scope, outcome: rejection ? "rejected" : "accepted", rejection };
    receipts.set(proposal.id, receipt);
    if (!rejection) {
      retained.set(evidenceKey(part.proposal.evidence), structuredClone(part.proposal.evidence));
      if (loseAcceptedAck) { loseAcceptedAck = false; throw new Error("fixture_ack_lost"); }
    }
    return receipt;
  });
  const input: Parameters<typeof retainHelarcNativeEvidence>[0] = {
    journal: { command }, acceptance: { accept, query: async id => receipts.get(id) ?? null },
    scope: { id: "measurement-scope", runId: "run", recipientId: "recipient", purpose: { id: "measurement", revision: "1" },
      compositionDigest: digest("composition"), owner: "adapter" },
    fence: currentFence, kind: "measurement", key: "prepared-input", expectedRevision: 2,
    value: { binding: { scope: { id: "task-scope", purpose: "task" } }, inputTokens: 73 },
    references: [{ id: "count-response", activityId: currentFence.activityId, bytes: 2, digest: digest({}) }],
    dependencies: [{ activityId: currentFence.activityId, ref: { id: "count-observation", revision: "1" } }],
    metadata: { status: "measured" }, memberships: [],
  };
  return { input, command, accept, receipts, retained, renew: (fence: ProtocolExecutionFence) => { currentFence = fence; } };
}

function expectAttemptIdentity(proposal: SharedAcceptanceProposal) {
  const { id, ...payload } = proposal;
  expect(id).toBe(`native-evidence:${digest(payload)}`);
}

describe("native evidence acceptance recovery", () => {
  it.each(["generation", "epoch", "controlRevision"] as const)("retries rejected evidence under renewed %s without changing evidence identity", async field => {
    const f = fixture(), renewed = { ...f.input.fence, [field]: f.input.fence[field] + 1 };
    f.renew(renewed);
    await expect(retainHelarcNativeEvidence(f.input)).rejects.toThrow("native_evidence_not_accepted:fenced");
    await expect(retainHelarcNativeEvidence(f.input)).rejects.toThrow("native_evidence_not_accepted:fenced");
    expect(f.receipts.size).toBe(1);
    expect(f.retained.size).toBe(0);
    const evidence = await retainHelarcNativeEvidence({ ...f.input, fence: renewed });
    const [old, replay, fresh] = f.accept.mock.calls.map(([proposal]) => proposal);
    for (const proposal of [old, replay, fresh]) expectAttemptIdentity(proposal);
    expect(replay).toEqual(old);
    expect(fresh.id).not.toBe(old.id);
    const oldPart = old.parts[0] as EvidencePart, freshPart = fresh.parts[0] as EvidencePart;
    expect(oldPart.proposal).toEqual({ fence: f.input.fence, expectedRevision: 2, evidence });
    expect(fresh).toEqual({ id: fresh.id, scope: f.input.scope.runId, actor: f.input.scope.owner,
      parts: [{ owner: "protocol_execution", kind: "evidence", proposal: { fence: renewed, expectedRevision: 2, evidence } }] });
    expect(freshPart.proposal.evidence).toEqual(oldPart.proposal.evidence);
    expect(evidence).toMatchObject({ scopeId: f.input.scope.id, activityId: f.input.fence.activityId, kind: "measurement",
      key: f.input.key, revision: 3, references: f.input.references, dependencies: f.input.dependencies, metadata: f.input.metadata });
    expect(evidence.content.id).toBe(`${f.input.fence.activityId}:measurement:${digest(f.input.value)}`);
    expect(f.receipts.get(old.id)?.outcome).toBe("rejected");
    expect(f.receipts.get(fresh.id)?.outcome).toBe("accepted");
    expect(f.receipts.size).toBe(2);
    expect(f.retained.size).toBe(1);
    const staging = f.command.mock.calls.map(([command]) => command).filter(command => command.kind === "content_append");
    expect(staging).toHaveLength(3);
    for (const command of staging) {
      expect(command.content).toEqual(evidence.content);
      expect(command.offset).toBe(0);
      expect(Buffer.from(command.bytesBase64, "base64").toString("utf8")).toBe(JSON.stringify(snapshotModelJsonValue(f.input.value,"native evidence")));
    }
  });

  it("recovers an accepted lost ACK by exact revision after a newer revision exists, without another submission", async () => {
    const f = fixture(true);
    await expect(retainHelarcNativeEvidence(f.input)).rejects.toThrow("fixture_ack_lost");
    const proposal = f.accept.mock.calls[0][0], accepted = (proposal.parts[0] as EvidencePart).proposal.evidence;
    expectAttemptIdentity(proposal);
    expect(f.receipts.get(proposal.id)?.outcome).toBe("accepted");
    const later = { ...accepted, revision: accepted.revision + 1, metadata: { status: "later" } };
    f.retained.set(evidenceKey(later), later);
    const renewed = { ...f.input.fence, generation: 2, epoch: 2, controlRevision: 1 };
    f.renew(renewed);
    const recovered = await retainHelarcNativeEvidence({ ...f.input, fence: renewed });
    expect(recovered).toEqual(accepted);
    expect(recovered).not.toEqual(later);
    expect(f.accept).toHaveBeenCalledTimes(1);
    expect(f.receipts.size).toBe(1);
    const reads = f.command.mock.calls.map(([command]) => command).filter(command => command.kind === "evidence");
    expect(reads).toEqual(Array.from({ length: 2 }, () => ({ kind: "evidence", activityId: f.input.fence.activityId,
      scopeId: f.input.scope.id, evidenceKind: "measurement", key: f.input.key, revision: 3 })));
  });

  it("does not accept a conflicting exact revision as recovery evidence or submit it again", async () => {
    const f = fixture(), accepted = await retainHelarcNativeEvidence(f.input);
    f.retained.set(evidenceKey(accepted), { ...accepted, metadata: { status: "different" } });
    await expect(retainHelarcNativeEvidence(f.input)).rejects.toThrow("native_evidence_revision_conflict");
    expect(f.accept).toHaveBeenCalledTimes(1);
  });
  it("uses identical retained bytes when cold reconstruction changes object insertion order",async()=>{
    const f=fixture();
    const first=await retainHelarcNativeEvidence({...f.input,value:{z:{second:2,first:1},a:0}});
    const replay=await retainHelarcNativeEvidence({...f.input,value:{a:0,z:{first:1,second:2}}});
    expect(replay).toEqual(first);expect(f.accept).toHaveBeenCalledTimes(1);
    const chunks=f.command.mock.calls.map(([command])=>command).filter(command=>command.kind==="content_append");
    expect(chunks).toHaveLength(2);expect(chunks[0].bytesBase64).toBe(chunks[1].bytesBase64);
  });
});
