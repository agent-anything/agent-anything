import {createHash} from "node:crypto";
import {executionEvidenceKey, snapshotExecutionEvidenceRef, type ExecutionEvidenceAccessPort,
  type ExecutionEvidenceRecord, type ExecutionEvidenceRef, type ExecutionReferenceTransfer} from "@agent-anything/operation-catalog/evidence";
import {OperationCommitError} from "@agent-anything/operation-catalog/result";
import {ExecutionMaterialAccessError, type HelarcExecutionHandoff, type HelarcExecutionCollectionReader} from "@agent-anything/helarc/tools";
import type {HelarcExecutionStore} from "./HelarcExecutionStore.js";

/** Metadata disclosure follows accepted input/result handoffs, never tree ancestry alone. */
export function createHelarcExecutionHandoff(store: HelarcExecutionStore) {
  const admissions = new Map<string, Promise<void>>();
  async function acceptInput(runId: string): Promise<void> {
    const existing = admissions.get(runId);
    if (existing) return existing;
    const pending = (async () => {
      const initial = await store.readRunCommit(`${runId}:commit:0`);
      const request = initial?.admission?.delegationRequest;
      if (!request) return;
      const basis = {owner: "runtime", kind: "delegation_request", id: request.ref.id, revision: request.ref.revision};
      const acceptedAt = initial!.state.startedAt;
      if (request.continuation) {
        const continuation = request.continuation;
        const source = await store.readRunCommit(`${continuation.sourceChild.id}:commit:0`);
        const previous = source?.admission?.delegationRequest;
        const head = await store.readLatestRun(continuation.sourceChild.id);
        if (!previous || !head?.state.settlement || previous.ref.id !== continuation.sourceRequest.id ||
            previous.ref.revision !== continuation.sourceRequest.revision || continuation.sourceChild.id === runId ||
            previous.origin.parent.run.id !== request.origin.parent.run.id ||
            previous.origin.root.run.id !== request.origin.root.run.id) {
          throw new OperationCommitError("helarc.execution-handoff", request.ref.id);
        }
        await acceptInput(continuation.sourceChild.id);
        const inherited = await store.readExecutionReferenceTransfers(continuation.sourceChild.id);
        const grants = [{sourceRunId: continuation.sourceChild.id, scope: {kind: "public_run" as const}}, ...inherited];
        for (const grant of grants) if (grant.sourceRunId !== runId) {
          await commit({id: transferId(runId, grant.sourceRunId, basis, grant.scope), sourceRunId: grant.sourceRunId,
            recipientRunId: runId, scope: grant.scope, basis, acceptedAt});
        }
      }
      const input = request.task.input;
      const refs = input && typeof input === "object" && !Array.isArray(input) ?
        (input as Record<string, unknown>).execution_refs : undefined;
      if (!Array.isArray(refs) || !refs.length) return;
      const references = refs.map(ref => snapshotExecutionEvidenceRef(ref));
      await validate(request.origin.parent.run.id, references);
      await transferSelected(runId, references, basis, acceptedAt);
    })();
    admissions.set(runId, pending);
    try {await pending;} catch (error) {admissions.delete(runId); throw error;}
  }
  const access: ExecutionEvidenceAccessPort = {async canInspect({runId, record, reference}) {
    const source = sourceRun(record);
    if (source === runId) return true;
    await acceptInput(runId);
    const transfers = await store.readExecutionReferenceTransfers(runId);
    return transfers.some(t => t.sourceRunId === source && (t.scope.kind === "public_run" ||
      t.scope.references.some(ref => covers(record, ref, reference))));
  }};
  async function validate(runId: string, references: readonly ExecutionEvidenceRef[]): Promise<void> {
    if (!references.length || references.length > 16) throw new TypeError("Transfer 1-16 explicitly disclosed execution references.");
    for (const reference of references) {
      const record = await store.readExecutionEvidence(reference);
      if (!record || !await access.canInspect({runId, record, reference})) {
        throw new TypeError("Execution reference was not delivered to this Run. Copy an exact reference from an accessible result.");
      }
    }
  }
  async function commit(transfer: ExecutionReferenceTransfer) {
    try {await store.commitExecutionReferenceTransfer(transfer);}
    catch (cause) {throw new OperationCommitError("helarc.execution-handoff", transfer.id, {cause});}
  }
  async function transferSelected(recipientRunId: string, references: readonly ExecutionEvidenceRef[],
    basis: ExecutionReferenceTransfer["basis"], acceptedAt: string) {
    const grouped = new Map<string, ExecutionEvidenceRef[]>();
    for (const reference of references) {
      const record = await store.readExecutionEvidence(reference);
      if (!record) throw new Error("Accepted execution reference is unavailable.");
      const source = sourceRun(record);
      if (source === recipientRunId) continue;
      const refs = grouped.get(source) ?? [];
      if (!refs.some(ref => executionEvidenceKey(ref) === executionEvidenceKey(reference))) refs.push(reference);
      grouped.set(source, refs);
    }
    for (const [sourceRunId, refs] of grouped) {
      const scope = {kind: "references" as const, references: refs};
      await commit({id: transferId(recipientRunId, sourceRunId, basis, scope), sourceRunId, recipientRunId,
        scope, basis, acceptedAt});
    }
  }
  const handoff: HelarcExecutionHandoff = {validate, async project(result) {
    try {
    const sourceRunId = result.correlation.child.run.id;
    const recipientRunId = result.correlation.origin.parent.run.id;
    const initial = await store.readRunCommit(`${sourceRunId}:commit:0`);
    const head = await store.readLatestRun(sourceRunId);
    const request = initial?.admission?.delegationRequest;
    if (!request || !head?.state.settlement || request.ref.id !== result.request.id ||
        request.ref.revision !== result.request.revision || request.origin.parent.run.id !== recipientRunId) {
      throw new OperationCommitError("helarc.execution-handoff", result.ref.id);
    }
    const basis = {owner: "agent-runtime", kind: "delegation_result", ...result.ref};
    await commit({id: transferId(recipientRunId, sourceRunId, basis), sourceRunId, recipientRunId,
      scope: {kind: "public_run"}, basis, acceptedAt: result.createdAt});
    return await store.readRunExecutionReferences(sourceRunId, null, 16);
    } catch (cause) {
      if (cause instanceof OperationCommitError) throw cause;
      throw new OperationCommitError("helarc.execution-handoff", result.ref.id, {cause});
    }
  }};
  const collections: HelarcExecutionCollectionReader = {async read({runId, reference, after, limit}) {
    const record = await store.readExecutionEvidence(reference);
    if (!record) throw new ExecutionMaterialAccessError("execution_reference_unavailable", "Execution reference is unavailable.");
    const source = sourceRun(record);
    await acceptInput(runId);
    const transfers = await store.readExecutionReferenceTransfers(runId);
    if (source !== runId && !transfers.some(t => t.sourceRunId === source && t.scope.kind === "public_run")) {
      throw new ExecutionMaterialAccessError("execution_collection_inaccessible", "This handoff disclosed selected references, not the source Run collection.");
    }
    // A terminal collection is immutable; an active Run's list cannot promise stable pagination.
    if (!(await store.readLatestRun(source))?.state.settlement) {
      throw new ExecutionMaterialAccessError("execution_collection_not_settled", "Inspect known references while the source Run is active; collection paging is available after settlement.");
    }
    return store.readRunExecutionReferences(source, after, limit);
  }};
  return {access, handoff, collections, async transferToLaterRun(input: {
    sourceRunId: string; recipientRunId: string; references: readonly ExecutionEvidenceRef[];
    basis: ExecutionReferenceTransfer["basis"]; acceptedAt: string;
  }) {
    const source = await store.readRunCommit(`${input.sourceRunId}:commit:0`);
    const recipient = await store.readRunCommit(`${input.recipientRunId}:commit:0`);
    if (!source?.admission || !recipient?.admission) throw new TypeError("Both Runs must be admitted.");
    const a = await store.readProductRun(source.admission.lineage.root.id);
    const b = await store.readProductRun(recipient.admission.lineage.root.id);
    if (!a || !b || a.sessionId !== b.sessionId || a.identity.id !== b.identity.id) {
      throw new TypeError("Explicit later-Run transfer requires the same retained Product session and identity.");
    }
    await validate(input.sourceRunId, input.references);
    await transferSelected(input.recipientRunId, input.references, input.basis, input.acceptedAt);
  }};
}
function sourceRun(record: ExecutionEvidenceRecord): string {
  if (record.source.correlation.kind !== "run_action") throw new TypeError("Public execution has no Run correlation.");
  return record.source.correlation.run.id;
}
function covers(record: ExecutionEvidenceRecord, disclosed: ExecutionEvidenceRef, target: ExecutionEvidenceRef): boolean {
  const key = executionEvidenceKey(disclosed);
  if (key === executionEvidenceKey(target) || key === executionEvidenceKey(record.ref)) return true;
  return record.support.some(s => (executionEvidenceKey(s.ref) === key || s.effects.some(e => executionEvidenceKey(e) === key)) &&
    (executionEvidenceKey(s.ref) === executionEvidenceKey(target) || s.materials.some(m => executionEvidenceKey(m.ref) === executionEvidenceKey(target))));
}
function transferId(recipient: string, source: string, basis: ExecutionReferenceTransfer["basis"], scope?: unknown) {
  return `execution-transfer:${createHash("sha256").update(JSON.stringify([recipient, source, basis, scope])).digest("hex")}`;
}
