import type { Metadata } from "@agent-anything/shared";

export type NetDoctorProgressPhase =
  | "starting"
  | "planning"
  | "tool"
  | "observing"
  | "completed"
  | "failed";

export type NetDoctorProgressStatus =
  | "running"
  | "succeeded"
  | "failed";

export interface NetDoctorProgressUpdate {
  taskId: string;
  sequence: number;
  phase: NetDoctorProgressPhase;
  status: NetDoctorProgressStatus;
  message: string;
  toolName: string | null;
  evidenceRefs: string[];
  output: unknown | null;
  errorCode: string | null;
  metadata: Metadata;
}
