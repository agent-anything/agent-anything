import type { Metadata } from "@agent-anything/platform";

export type NetDoctorProgressPhase =
  | "starting"
  | "planning"
  | "tool"
  | "observing"
  | "reporting"
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
  reportRef: string | null;
  errorCode: string | null;
  metadata: Metadata;
}
