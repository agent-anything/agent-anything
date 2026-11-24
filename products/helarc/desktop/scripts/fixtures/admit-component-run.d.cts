import type { RunCommit, RunTreeCommitPort, RunTreeCommitReceipt } from "@agent-anything/agent-runtime/execution-coordinator";

export function admitComponentRun(store: RunTreeCommitPort & {
  readLatestRun(runId: string): Promise<RunCommit | null>;
}, directory: string, runId?: string): Promise<RunCommit>;
export function commitComponentRun(store: RunTreeCommitPort, commit: RunCommit): Promise<RunTreeCommitReceipt>;
