export type ExecutionAdmissionResolution = {
  readonly rootRunId: string;
  readonly intentId: string;
  readonly status: "unknown" | "prepared" | "accepted" | "closed";
  readonly acceptanceId: string | null;
};

export const EXECUTION_ADMISSION_RESOLUTION_SCHEMA = `
CREATE TABLE execution_admission_fences (
  root_run_id TEXT PRIMARY KEY, intent_id TEXT NOT NULL UNIQUE,
  closed INTEGER NOT NULL CHECK(closed IN (0,1)), digest TEXT NOT NULL, value TEXT NOT NULL
);
`;
