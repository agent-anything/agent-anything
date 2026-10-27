import { sameRunCommitValue as same } from "./RunCommitValue.js";
import type { RunCommit } from "./RunCommitPort.js";
import { projectRunTreeTerminal, RunTreeExecution, type RunTreeCheckpoint } from "./RunTreeExecution.js";
import { runTreeResourceDimensions } from "./RunTreeResourceAccount.js";

/** One logical transition, including every Run changed by admission or settlement. */
export interface RunTreeCommit {
  readonly id: string;
  readonly expectedRevision: number | null;
  readonly revision: number;
  readonly checkpoint: RunTreeCheckpoint;
  readonly runs: readonly RunCommit[];
}

export interface RunTreeCommitReceipt {
  readonly recordId: string;
  readonly revision: number;
  readonly runs: readonly {readonly recordId: string; readonly revision: number}[];
}

export interface RunTreeCommitPort {
  /** Immutable owner snapshot; publication still requires the exact durable receipt. */
  commitRunTree(commit: RunTreeCommit): Promise<RunTreeCommitReceipt>;
  readRunTreeCommit(id: string): Promise<RunTreeCommit | null>;
  readRunTree(rootRunId: string): Promise<RunTreeRecoveryRecords | null>;
}

export interface RetainedRunTreeMember {
  readonly admission: NonNullable<RunCommit["admission"]>;
  readonly head: RunCommit;
}

export interface RunTreeRecoveryRecords {
  readonly commit: RunTreeCommit;
  readonly members: readonly RetainedRunTreeMember[];
}

/** Host supplies the retained heads; Runtime owns their semantic relationships. */
export function validateRunTreeCommit(
  commit: RunTreeCommit,
  previous: RunTreeCommit | null,
  members: readonly RetainedRunTreeMember[],
): void {
  validateRunTreeRecoveryRecords({commit, members});
  const {expectedRevision} = commit;
  if ((previous?.revision ?? null) !== expectedRevision) invalid("revision");
  validateRetainedTree(commit, previous, members);
}

/** Validate one atomically read basis without fabricating an initial admission. */
export function validateRunTreeRecoveryRecords({commit, members}: RunTreeRecoveryRecords): void {
  const {checkpoint, revision, expectedRevision} = commit;
  const rootId = checkpoint.input.rootRunId;
  if (!Number.isSafeInteger(revision) || revision < 0 ||
      (expectedRevision !== null && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)) ||
      revision !== (expectedRevision === null ? 0 : expectedRevision + 1) ||
      commit.id !== `${rootId}:tree_commit:${revision}`) invalid("revision");
  // Restoration validates the complete accounts without running callbacks or work.
  RunTreeExecution.restore(checkpoint, () => checkpoint.input.startedAt);
  const heads = new Map(members.map(member => [member.head.state.run.id, member]));
  if (heads.size !== members.length || members.length !== checkpoint.nodes.length) invalid("membership");
  const changed = new Set<string>();
  for (const run of commit.runs) {
    const id = run.state.run.id;
    if (changed.has(id) || !heads.has(id) || !same(heads.get(id)!.head, run)) invalid("changed Run");
    changed.add(id);
  }
  for (const node of checkpoint.nodes) {
    const member = heads.get(node.runId);
    if (!member) invalid("missing Run");
    const {admission, head: {state}} = member;
    if (!same(admission.lineage, node.lineage) || state.status !== node.status ||
        state.completedAt !== node.completedAt || node.startedAt !== state.startedAt ||
        !Number.isFinite(Date.parse(state.deadlineAt)) ||
        Date.parse(state.deadlineAt) > Date.parse(checkpoint.input.deadlineAt) ||
        (node.runId === rootId && state.startedAt !== checkpoint.input.startedAt)) invalid("Run lifecycle");
    if (state.settlementCause === null ? node.terminal !== null :
      !same(projectRunTreeTerminal(state.settlementCause), node.terminal)) invalid("terminal cause");
    if (node.lineage.kind === "descendant") {
      const {parent, parentRunAction} = node.lineage;
      const parentHead = heads.get(parent.id)?.head;
      if (!parentHead?.state.items.some(item => item.payload.kind === "run_action" &&
          same(item.payload.action.ref, parentRunAction))) invalid("Parent delegation action");
      const transfers = parentHead.control.descendantTransfers.filter(value => value.childRunId === node.runId);
      if (transfers.length > 1) invalid("duplicate Child transfer");
      const transfer = transfers[0];
      if (node.resultTransfer === "settled" || node.resultTransfer === "failed") {
        if (!transfer || transfer.status !== node.resultTransfer ||
            transfer.relationId !== node.lineage.relation.id || !same(transfer.action.ref, parentRunAction)) {
          invalid("unretained Child transfer");
        }
      } else if (transfer) invalid("unexpected Child transfer");
      if (transfer?.status === "settled") {
        if (!transfer.result || transfer.code !== null || transfer.result.correlation.child.run.id !== node.runId ||
            transfer.result.correlation.origin.parent.run.id !== parent.id ||
            !same(transfer.result.correlation.origin.parent.action, parentRunAction) ||
            transfer.result.correlation.relation.ref.id !== node.lineage.relation.id) invalid("Child transfer source");
      } else if (transfer?.status === "failed" && (transfer.result !== null || transfer.code !== "delegation_result_invalid")) {
        invalid("Child transfer failure");
      }
    }
  }
}

function validateRetainedTree(
  commit: RunTreeCommit,
  previous: RunTreeCommit | null,
  members: readonly RetainedRunTreeMember[],
): void {
  const {checkpoint} = commit;
  if (!previous) {
    if (commit.runs.length !== members.length || commit.runs.some(run => run.expectedRevision !== null)) invalid("initial admission");
    return;
  }
  const before = previous.checkpoint;
  if (!same(before.input, checkpoint.input) || checkpoint.revision < before.revision ||
      checkpoint.cancellationRequestCount < before.cancellationRequestCount) invalid("original tree facts");
  if (checkpoint.revision === before.revision && !same(before, checkpoint)) invalid("projection revision");
  const nodes = new Map(checkpoint.nodes.map(node => [node.runId, node]));
  for (const old of before.nodes) {
    const next = nodes.get(old.runId);
    if (!next || !same(old.lineage, next.lineage) || old.acceptedOrder !== next.acceptedOrder ||
        old.relationKind !== next.relationKind || !same(old.dispatch, next.dispatch) ||
        old.admittedAuthorityRevision !== next.admittedAuthorityRevision ||
        old.authorityRevisionSequence > next.authorityRevisionSequence ||
        (old.startedAt !== null && old.startedAt !== next.startedAt) ||
        (old.terminal !== null && (!same(old.terminal, next.terminal) || old.status !== next.status || old.completedAt !== next.completedAt)) ||
        (old.cancellation !== null && !same(old.cancellation, next.cancellation)) ||
        (old.resultTransfer !== "pending" && old.resultTransfer !== next.resultTransfer)) invalid("retained node");
  }
  const oldIds = new Set(before.nodes.map(node => node.runId));
  for (const node of checkpoint.nodes) {
    if (!oldIds.has(node.runId) && !commit.runs.some(run => run.state.run.id === node.runId && run.expectedRevision === null)) invalid("Child admission");
  }
  const resources = new Map(checkpoint.resources.nodes.map(node => [node.runId, node]));
  for (const old of before.resources.nodes) {
    const next = resources.get(old.runId);
    if (!next || next.revision < old.revision || (old.limitExceeded && !next.limitExceeded) ||
        !same(old.requestedAllocation, next.requestedAllocation) ||
        (old.settled && !same(old, next)) ||
        runTreeResourceDimensions.some(dimension => next.measured[dimension] < old.measured[dimension])) invalid("retained resource account");
  }
  const approvals = checkpoint.approvals;
  if (approvals.totalRequests < before.approvals.totalRequests || approvals.settledRequests < before.approvals.settledRequests ||
      approvals.revision < before.approvals.revision || before.approvals.seenRequestIds.some(id => !approvals.seenRequestIds.includes(id))) invalid("retained Approval account");
  for (const active of approvals.active) {
    if (before.approvals.seenRequestIds.includes(active.requestId) && !before.approvals.active.some(item => same(item, active))) invalid("settled Approval reopened");
  }
}

function invalid(part: string): never {
  throw new TypeError(`Invalid coordinated Run Tree commit: ${part}.`);
}
