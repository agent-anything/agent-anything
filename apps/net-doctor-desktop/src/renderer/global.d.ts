import type { NetDoctorDesktopApi } from "../shared/DesktopDiagnosis.js";

declare global {
  interface Window {
    netDoctor: NetDoctorDesktopApi;
  }
}

export {};
