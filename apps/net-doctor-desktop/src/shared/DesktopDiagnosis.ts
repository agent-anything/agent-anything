import type { RuntimeResult } from "@agent-anything/platform";
import type { NetDoctorProgressUpdate } from "net-doctor";

export interface DesktopDiagnosisRequest {
  target: string;
  symptom: string;
}

export interface DesktopDiagnosisResult {
  status: RuntimeResult["status"];
  reportRef: string | null;
  conclusion: string;
  evidenceRefs: string[];
  errors: Array<{
    code: string;
    message: string;
  }>;
  progress: NetDoctorProgressUpdate[];
}

export interface NetDoctorDesktopApi {
  diagnose(request: DesktopDiagnosisRequest): Promise<DesktopDiagnosisResult>;
}
