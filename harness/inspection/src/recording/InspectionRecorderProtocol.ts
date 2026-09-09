import type { InspectionRecord, InspectionCoverage } from "../records/index.js";
import type { InspectionContentWrite } from "../storage/index.js";
import type { InspectionDatasetManifest, InspectionSource } from "../sources/index.js";

export interface InspectionOffer { readonly record: InspectionRecord; readonly contents: readonly InspectionContentWrite[]; readonly bytes: number }
export type RecorderCommand =
  | { readonly kind: "batch"; readonly offers: readonly InspectionOffer[]; readonly dropped: number; readonly rejected: number }
  | { readonly kind: "flush"; readonly id: number; readonly close: boolean; readonly dropped: number; readonly rejected: number };
export type RecorderReply =
  | { readonly kind: "ready"; readonly source: InspectionSource; readonly manifest: InspectionDatasetManifest }
  | { readonly kind: "ack"; readonly coverage: InspectionCoverage }
  | { readonly kind: "flushed"; readonly id: number; readonly coverage: InspectionCoverage }
  | { readonly kind: "failed"; readonly code: string };
