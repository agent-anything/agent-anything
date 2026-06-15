import type { ExecutionAccess, RuntimeResult } from "@agent-anything/agent-core";
import type { HostEvent, HostRunResult } from "@agent-anything/agent-core/host";
import type { PermissionMode } from "@agent-anything/permission";
import type { NetDoctorProgressUpdate } from "net-doctor";

export type DesktopPermissionPreset = "approve-for-me" | "ask-for-approval" | "full-access";

export interface DesktopDiagnosisRequest {
  target: string;
  symptom: string;
  permissionMode?: PermissionMode;
  executionAccess?: ExecutionAccess;
}

export interface DesktopDiagnosisResult {
  status: RuntimeResult["status"];
  output: RuntimeResult["output"];
  conclusion: string;
  evidenceRefs: string[];
  hostResult: HostRunResult;
  hostEvents: HostEvent[];
  errors: Array<{
    code: string;
    message: string;
  }>;
  progress: NetDoctorProgressUpdate[];
}

export interface NetDoctorDesktopApi {
  diagnose(request: DesktopDiagnosisRequest): Promise<DesktopDiagnosisResult>;
}
