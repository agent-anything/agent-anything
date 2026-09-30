import { createHash } from "node:crypto";
import type { ModelInputSectionCandidate } from "@agent-anything/model-interaction/input";

/** Read-only input from the command owner, independent of Desktop progress. */
export interface HelarcCommandStateSnapshot {
  readonly ref: { readonly runId: string; readonly executionId: string };
  readonly revision: number;
  readonly phase: string;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly deadlineAt: string | null;
  readonly outcome: string | null;
  readonly rootExit: { readonly code: number | null; readonly signal: string | null; readonly observedAt: string } | null;
  readonly termination: { readonly reason: string; readonly requestedAt: string; readonly method: string } | null;
  readonly containment: { readonly disposition: string; readonly confirmedAt: string | null };
  readonly output: { readonly capture: string; readonly persistence: string; readonly retainedBytes: number; readonly omittedBytes: number | null };
}

const MAXIMUM_EXECUTIONS = 32;

export function createHelarcCommandStateSection(
  runId: string,
  snapshots: readonly HelarcCommandStateSnapshot[],
): ModelInputSectionCandidate | null {
  if (snapshots.some(snapshot => snapshot.ref.runId !== runId)) {
    throw new TypeError("Command state must belong to the requested Run.");
  }
  if (snapshots.length === 0) return null;
  const ordered = [...snapshots].sort((left, right) =>
    Number(left.phase === "settled") - Number(right.phase === "settled") ||
    (right.startedAt ?? "").localeCompare(left.startedAt ?? "") ||
    left.ref.executionId.localeCompare(right.ref.executionId)
  );
  const value = {
    runId,
    coverage: "retained_executions_only",
    omittedExecutions: Math.max(0, ordered.length - MAXIMUM_EXECUTIONS),
    executions: ordered.slice(0, MAXIMUM_EXECUTIONS).map(snapshot => ({
      task_id: snapshot.ref.executionId,
      revision: snapshot.revision,
      phase: snapshot.phase,
      startedAt: snapshot.startedAt,
      finishedAt: snapshot.finishedAt,
      deadlineAt: snapshot.deadlineAt,
      outcome: snapshot.outcome,
      rootExit: snapshot.rootExit === null ? null : {
        code: snapshot.rootExit.code, signal: snapshot.rootExit.signal, observedAt: snapshot.rootExit.observedAt,
      },
      termination: snapshot.termination === null ? null : {
        reason: snapshot.termination.reason, requestedAt: snapshot.termination.requestedAt, method: snapshot.termination.method,
      },
      containment: { disposition: snapshot.containment.disposition, confirmedAt: snapshot.containment.confirmedAt },
      output: { capture: snapshot.output.capture, persistence: snapshot.output.persistence,
        retainedBytes: snapshot.output.retainedBytes, omittedBytes: snapshot.output.omittedBytes },
    })),
  };
  const text = `Current command state (latest retained snapshots; output remains available through TaskOutput):\n${JSON.stringify(value)}`;
  return Object.freeze({
    id: "helarc:model-input:command-state",
    source: Object.freeze({ owner: "helarc", kind: "run_process_state", id: runId,
      revision: `sha256:${createHash("sha256").update(text).digest("hex")}` }),
    kind: "run_material",
    role: "user",
    necessity: "mandatory",
    content: Object.freeze({ kind: "text", text }),
  });
}
