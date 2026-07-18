import {
  deriveHelarcPersistedRunStatus,
  type HelarcPersistedRunStatus,
  type HelarcThread,
  type HelarcThreadRecord,
} from "@agent-anything/helarc";

export interface HelarcThreadSummary {
  id: string;
  title: string;
  status: HelarcThread["status"];
  workspace: HelarcThread["workspace"];
  createdAt: string;
  updatedAt: string;
  latestRun: {
    runId: string;
    status: HelarcPersistedRunStatus;
    startedAt: string;
    completedAt: string | null;
  } | null;
}

export function createHelarcThreadSummary(record: HelarcThreadRecord): HelarcThreadSummary {
  const latestRun = record.thread.latestRunId === null
    ? null
    : record.runs.find((run) => run.id === record.thread.latestRunId) ?? null;
  return {
    id: record.thread.id,
    title: record.thread.title,
    status: record.thread.status,
    workspace: record.thread.workspace,
    createdAt: record.thread.createdAt,
    updatedAt: record.thread.updatedAt,
    latestRun: latestRun === null
      ? null
      : {
          runId: latestRun.id,
          status: deriveHelarcPersistedRunStatus(latestRun),
          startedAt: latestRun.startedAt,
          completedAt: latestRun.terminal?.platform.completedAt ?? null,
        },
  };
}

export function sortHelarcThreadRecords(
  records: readonly HelarcThreadRecord[],
): HelarcThreadRecord[] {
  return [...records].sort((left, right) =>
    Date.parse(right.thread.updatedAt) - Date.parse(left.thread.updatedAt) ||
    left.thread.id.localeCompare(right.thread.id)
  );
}
