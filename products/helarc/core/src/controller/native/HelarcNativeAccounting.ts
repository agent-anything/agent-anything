import { createHash } from "node:crypto";
import { nativeAccountingWorkMergePlan, assertNativeAccountingWorkProgress, restoreNativeAccountingState,
  nativeWorkForSubmission, nativeWorkIndexEntry, encodeNativeWorkIndexEntryMetadata, applyNativeAccountingCommand,
  decodeNativeWorkIndexEntryMetadata, type NativeAccountingState, type NativeCostCalculation } from "@agent-anything/provider-integrations/native";
import { readProtocolContent, retainProtocolContent, type ProtocolEvidencePage, type ProtocolExecutionJournal,
  type ProtocolEvidenceRevision, type ProtocolEvidenceScope, type ProtocolUsageMerge, type ProtocolUsageMergeProposal,
  type ProtocolUsageRetirement } from "@agent-anything/agent-runtime/model-access";
import type { SharedAcceptanceProposal } from "@agent-anything/agent-runtime/activity";
import { modelInputValueDigest } from "@agent-anything/model-interaction/input";
import { snapshotModelJsonValue } from "@agent-anything/model-interaction";
import { retainHelarcNativeEvidence } from "./HelarcNativeEvidence.js";

/** One physical work per slot. The original accounting/price basis and its bounded index commit together. */
export async function retainHelarcNativeWork(input: Omit<Parameters<typeof retainHelarcNativeEvidence>[0],
  "kind" | "key" | "value" | "metadata" | "memberships"> & {
  readonly state: NativeAccountingState;
  readonly submissionId: string;
  readonly cost: NativeCostCalculation | null;
  /** Bound explicit reconciliation reads, never aggregate/index reads. */
  readonly maximumSnapshotBytes?: number;
}): Promise<ProtocolEvidenceRevision> {
  let plan = nativeAccountingWorkMergePlan(input.state, input.submissionId), state = plan.mergedSnapshot;
  const work = nativeWorkForSubmission(state, input.submissionId);
  assertScope(state, input.scope);
  if (input.cost) state = applyNativeAccountingCommand(state, { id: `cost:${input.cost.revision}`, kind: "record_cost",
    submissionId: input.submissionId, calculation: input.cost });
  plan = nativeAccountingWorkMergePlan(state, input.submissionId);
  const index = nativeWorkIndexEntry(state, input.submissionId, input.cost);
  const value = { state, cost: input.cost }, metadata = encodeNativeWorkIndexEntryMetadata(index);
  const bytes = Buffer.from(JSON.stringify(snapshotModelJsonValue(value, "native work evidence")));
  const content = { id: `${input.fence.activityId}:usage:${modelInputValueDigest(value)}`, activityId: input.fence.activityId,
    bytes: bytes.length, digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}` };
  const evidence: ProtocolEvidenceRevision = { scopeId: input.scope.id, kind: "usage", key: work.id, owner: input.scope.owner,
    activityId: input.fence.activityId, revision: input.expectedRevision === null ? 0 : input.expectedRevision + 1,
    content, metadata, memberships: index.beneficiaries, references: input.references, dependencies: input.dependencies };
  const mergeId = `native-usage-merge:${modelInputValueDigest({ scope: input.scope,
    expectedRevision: input.expectedRevision, evidence, retiredWorkIds: plan.retiredWorkIds })}`;
  const query = { activityId: input.fence.activityId, scopeId: input.scope.id };
  const proposalFor = (merge: ProtocolUsageMergeProposal): SharedAcceptanceProposal => {
    const proposal = { scope: input.scope.runId, actor: input.scope.owner,
      parts: [{ owner: "protocol_execution", kind: "usage_merge", proposal: merge }] };
    return { id: `native-usage-merge:${modelInputValueDigest(proposal)}`, ...proposal };
  };

  if (plan.retiredWorkIds.length) {
    // Recovery must precede current-head reads: either participant may have advanced
    // after this complete merge committed and its acknowledgement was lost.
    const accepted = await input.journal.command({ kind: "usage_merge", ...query, mergeId }) as ProtocolUsageMerge | null;
    if (accepted) {
      const receipt = await input.acceptance.query(accepted.acceptanceId);
      const original = accepted.proposal, retired = original.retired;
      const proposal = proposalFor(original);
      const sameEvidence = { ...accepted.survivor, references: input.references, dependencies: input.dependencies };
      if (accepted.scopeId !== input.scope.id || accepted.owner !== input.scope.owner || accepted.mergeId !== mergeId ||
          original.scopeId !== input.scope.id || original.mergeId !== mergeId || original.survivor.expectedRevision !== input.expectedRevision ||
          !same(original.survivor.evidence, accepted.survivor) ||
          !retired.length || new Set(retired.map(entry => entry.key)).size !== retired.length || retired.length !== accepted.retired.length ||
          retired.some(entry => !accepted.retired.some(alias => alias.key === entry.key && (alias.previous?.revision ?? null) === entry.expectedRevision)) ||
          accepted.retired.some(alias => alias.scopeId !== input.scope.id || alias.owner !== input.scope.owner || alias.mergeId !== mergeId ||
            alias.acceptanceId !== accepted.acceptanceId || !plan.retiredWorkIds.includes(alias.key) ||
            alias.survivor.key !== work.id || alias.survivor.revision !== evidence.revision || !same(alias.survivor.content, content)) ||
          !same(sameEvidence, evidence) || !contains(accepted.survivor.references, input.references) || !contains(accepted.survivor.dependencies, input.dependencies) ||
          !receipt || receipt.id !== proposal.id || accepted.acceptanceId !== proposal.id || receipt.scope !== input.scope.runId ||
          receipt.digest !== modelInputValueDigest(proposal) || receipt.outcome !== "accepted")
        throw new TypeError("helarc_accounting_merge_receipt_invalid");
      return accepted.survivor;
    }
  }

  const retirements = new Map<string, ProtocolUsageRetirement | null>();
  const retirement = async (key: string): Promise<ProtocolUsageRetirement | null> => {
    if (!retirements.has(key)) {
      const alias = await input.journal.command({ kind: "usage_retirement", ...query, key }) as ProtocolUsageRetirement | null;
      if (alias && (alias.scopeId !== input.scope.id || alias.key !== key || alias.owner !== input.scope.owner))
        throw new TypeError("helarc_accounting_alias_scope_changed");
      retirements.set(key, alias);
    }
    return retirements.get(key)!;
  };
  const participants = new Set([work.id, ...plan.retiredWorkIds]);
  // An ordinary revision can be confirmed even after a later retirement. If this
  // work has older aliases, prove they predate this write, not its missing merge ACK.
  const accepted = await input.journal.command({ kind: "evidence", ...query, evidenceKind: "usage", key: work.id,
    revision: evidence.revision }) as ProtocolEvidenceRevision | null;
  if (accepted) {
    for (const key of plan.retiredWorkIds) {
      const seen = new Set<string>();
      let target = key;
      while (target !== work.id) {
        if (seen.has(target) || seen.size >= 128 || !participants.has(target)) throw new TypeError("helarc_accounting_alias_invalid");
        seen.add(target);
        const alias = await retirement(target);
        if (!alias || alias.survivor.key === work.id && (input.expectedRevision === null || alias.survivor.revision > input.expectedRevision))
          throw new TypeError("helarc_accounting_merge_receipt_missing");
        target = alias.survivor.key;
      }
    }
    const previous = input.expectedRevision === null ? null : await input.journal.command({ kind: "evidence", ...query,
      evidenceKind: "usage", key: work.id, revision: input.expectedRevision }) as ProtocolEvidenceRevision | null;
    if (input.expectedRevision !== null && !previous) throw new TypeError("helarc_accounting_original_missing");
    const expected = { ...evidence, references: unique([...input.references, ...(previous?.references ?? [])]),
      dependencies: unique([...input.dependencies, ...(previous?.dependencies ?? [])]) };
    if (!same(accepted, expected)) {
      const fields = (Object.keys(expected) as (keyof ProtocolEvidenceRevision)[]).filter(key => !same(accepted[key], expected[key]));
      throw new TypeError(`native_evidence_revision_conflict:${fields.join(",")}`);
    }
    return accepted;
  }
  if (await retirement(work.id)) throw new TypeError("helarc_accounting_survivor_retired");
  const retired: { key: string; fence: typeof input.fence; expectedRevision: number | null }[] = [];
  const originals: ProtocolEvidenceRevision[] = [];
  const readOriginal = async (key: string, revision?: number): Promise<ProtocolEvidenceRevision | null> => {
    const original = await input.journal.command({ kind: "evidence", ...query, evidenceKind: "usage", key,
      ...(revision === undefined ? {} : { revision }) }) as ProtocolEvidenceRevision | null;
    if (!original) return null;
    if (original.scopeId !== input.scope.id || original.kind !== "usage" || original.key !== key || original.owner !== input.scope.owner ||
        revision !== undefined && original.revision !== revision) throw new TypeError("helarc_accounting_original_changed");
    const raw = await readProtocolContent(input.journal, original.content, original.content.activityId,
      input.maximumSnapshotBytes ?? 16 * 1024 * 1024, input.observe);
    const packet = JSON.parse(raw.toString("utf8")) as { state: unknown; cost: NativeCostCalculation | null };
    const prior = restoreNativeAccountingState(packet.state);
    const priorWork = Object.values(prior.works);
    if (priorWork.length !== 1 || priorWork[0]!.id !== key || packet.cost === undefined ||
        packet.cost !== null && !priorWork[0]!.costCalculations.some(calculation => same(calculation, packet.cost)))
      throw new TypeError("helarc_accounting_original_snapshot_invalid");
    assertScope(prior, input.scope);
    if (!same(decodeNativeWorkIndexEntryMetadata(original.metadata, original.memberships), nativeWorkIndexEntry(prior, priorWork[0]!.origin.id, packet.cost)))
      throw new TypeError("helarc_accounting_original_index_changed");
    assertNativeAccountingWorkProgress(state, prior);
    originals.push(original);
    return original;
  };
  if (input.expectedRevision !== null && !await readOriginal(work.id, input.expectedRevision))
    throw new TypeError("helarc_accounting_original_missing");
  for (const key of plan.retiredWorkIds) {
    if (await retirement(key)) {
      const seen = new Set<string>();
      let target = key;
      while (true) {
        if (seen.has(target) || seen.size >= 128 || !participants.has(target)) throw new TypeError("helarc_accounting_alias_invalid");
        seen.add(target);
        const alias = await retirement(target);
        if (!alias) break;
        target = alias.survivor.key;
      }
    } else {
      const original = await readOriginal(key);
      retired.push({ key, fence: input.fence, expectedRevision: original?.revision ?? null });
    }
  }
  const references = unique([...input.references, ...originals.flatMap(original => original.references)]);
  const dependencies = unique([...input.dependencies, ...originals.flatMap(original => original.dependencies)]);
  if (references.length > 128 || dependencies.length > 128 || retired.length > 128) throw new TypeError("helarc_accounting_merge_bound");
  const survivor = { ...evidence, references, dependencies };
  if (!retired.length) return retainHelarcNativeEvidence({ ...input, kind: "usage", key: work.id, value,
    metadata, memberships: index.beneficiaries, references, dependencies });

  const proposal = proposalFor({ scopeId: input.scope.id, mergeId,
    survivor: { fence: input.fence, expectedRevision: input.expectedRevision, evidence: survivor }, retired });
  // The immutable body is staged outside the shared transaction; all identities,
  // reservations, prices and active-index retirements commit in one acceptance.
  await retainProtocolContent(input.journal, content.id, content.activityId, bytes, input.observe);
  const receipt = await input.acceptance.accept(proposal);
  if (receipt.id !== proposal.id || receipt.digest !== modelInputValueDigest(proposal) || receipt.scope !== input.scope.runId)
    throw new TypeError("helarc_accounting_merge_receipt_invalid");
  if (receipt.outcome !== "accepted") throw new TypeError(`native_evidence_not_accepted:${receipt.rejection?.code}`);
  return survivor;
}

function same(a: unknown, b: unknown): boolean { return modelInputValueDigest(a) === modelInputValueDigest(b); }
function contains<T>(values: readonly T[], required: readonly T[]): boolean {
  const keys = new Set(values.map(value => modelInputValueDigest(value)));
  return required.every(value => keys.has(modelInputValueDigest(value)));
}
function unique<T>(values: readonly T[]): T[] {
  return [...new Map(values.map(value => [modelInputValueDigest(value), value])).values()];
}
function assertScope(state: NativeAccountingState, scope: ProtocolEvidenceScope): void {
  for (const work of Object.values(state.works)) if (work.origin.scope.runId !== scope.runId || work.origin.scope.recipientId !== scope.recipientId ||
      work.origin.scope.compositionDigest !== scope.compositionDigest || !same(work.origin.scope.purpose, scope.purpose))
    throw new TypeError("helarc_accounting_scope_changed");
}

/** Deliberately one bounded page; callers retain the explicit tree/work coverage of an aggregate. */
export async function readHelarcNativeWorkPage(input: {
  readonly journal: ProtocolExecutionJournal;
  readonly activityId: string;
  readonly scopeId: string;
  readonly afterKey: string | null;
  readonly limit: number;
  readonly membership?: string;
  readonly expectedVersion?: number;
}) {
  if (input.afterKey !== null && input.expectedVersion === undefined) throw new TypeError("helarc_accounting_page_version_required");
  const page = await input.journal.command({ kind: "evidence_list", activityId: input.activityId, scopeId: input.scopeId,
    evidenceKind: "usage", afterKey: input.afterKey, limit: input.limit,
    ...(input.expectedVersion === undefined ? {} : { expectedVersion: input.expectedVersion }),
    ...(input.membership === undefined ? {} : { membership: input.membership }) }) as ProtocolEvidencePage | null;
  if (!page) throw new TypeError("helarc_accounting_scope_unavailable");
  if (!Number.isSafeInteger(page.version) || page.version === null || page.version < 0 ||
      input.expectedVersion !== undefined && input.expectedVersion !== page.version) throw new TypeError("helarc_accounting_page_version_conflict");
  return { entries: page.entries.map(evidence => {
    const entry = decodeNativeWorkIndexEntryMetadata(evidence.metadata, evidence.memberships);
    if (entry.workId !== evidence.key || evidence.kind !== "usage" || evidence.scopeId !== input.scopeId)
      throw new TypeError("helarc_accounting_index_changed");
    return entry;
  }), next: page.next, version: page.version };
}
