import { equal, snapshot } from "./AccountingValue.js";
import { applyNativeAccountingCommand, createNativeAccountingState, nativeWorkForSubmission, restoreNativeAccountingState,
  type NativeAccountingState } from "./NativeAccounting.js";
import { nativeAccountingWorkSnapshot } from "./NativeWorkIndex.js";

export interface NativeAccountingWorkMergePlan {
  readonly survivorWorkId: string;
  readonly retiredWorkIds: readonly string[];
  readonly mergedSnapshot: NativeAccountingState;
}

/** Discover retired identities from actual reducer transitions, including work that
 * disappeared before its first durable write. Never derive identities from aliases. */
export function nativeAccountingWorkMergePlan(state: NativeAccountingState, submissionId: string): NativeAccountingWorkMergePlan {
  const mergedSnapshot = nativeAccountingWorkSnapshot(state, submissionId);
  const retired = new Set<string>();
  let replay = createNativeAccountingState();
  for (const receipt of Object.values(mergedSnapshot.commands).sort((a, b) => a.sequence - b.sequence)) {
    const next = applyNativeAccountingCommand(replay, receipt.command);
    for (const id of Object.keys(replay.works)) if (!next.works[id]) retired.add(id);
    replay = next;
  }
  const work = nativeWorkForSubmission(replay, submissionId);
  if (Object.keys(replay.works).length !== 1 || !equal(replay, mergedSnapshot) || !equal(work, nativeWorkForSubmission(state, submissionId)))
    throw new TypeError("accounting_merge_snapshot_invalid");
  return snapshot({ survivorWorkId: work.id, retiredWorkIds: [...retired].sort(), mergedSnapshot: replay });
}

/** The durable original is authoritative. A candidate must retain every original
 * command, unchanged and in causal order, not merely its current usage counters. */
export function assertNativeAccountingWorkProgress(candidate: NativeAccountingState, original: NativeAccountingState): void {
  const next = restoreNativeAccountingState(candidate), before = restoreNativeAccountingState(original);
  const work = Object.values(before.works);
  if (work.length !== 1 || Object.keys(next.works).length !== 1) throw new TypeError("accounting_progress_work_invalid");
  const target = nativeWorkForSubmission(next, work[0]!.origin.id);
  if (!equal(target.origin.scope, work[0]!.origin.scope)) throw new TypeError("accounting_progress_scope_changed");
  let previousSequence = 0;
  for (const [id, receipt] of Object.entries(before.commands).sort((a, b) => a[1].sequence - b[1].sequence)) {
    const retained = next.commands[id];
    if (!retained || !equal(retained.command, receipt.command) || retained.sequence <= previousSequence)
      throw new TypeError("accounting_progress_not_preserved");
    previousSequence = retained.sequence;
  }
}
