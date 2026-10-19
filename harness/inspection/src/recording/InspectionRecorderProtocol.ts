import type { InspectionCoverage } from "../records/index.js";
import type { InspectionNativeOffer } from "../storage/index.js";
import type { InspectionDatasetManifest, InspectionSource } from "../sources/index.js";
import type { InspectionBatchReceipt, InspectionIngressHealth } from "../records/index.js";

export type InspectionOffer = InspectionNativeOffer;
export type RecorderCommand =
  | { readonly kind: "batch"; readonly id: string; readonly digest: string; readonly offers: readonly InspectionOffer[]; readonly health: InspectionIngressHealth }
  | { readonly kind: "health"; readonly health: InspectionIngressHealth }
  | { readonly kind: "receipt"; readonly id: string }
  | { readonly kind: "flush"; readonly id: number; readonly close: boolean; readonly health: InspectionIngressHealth;
    readonly barrier: {readonly accepted: number; readonly healthRevision: number} };
export type RecorderReply =
  | { readonly kind: "initializing"; readonly completed: number }
  | { readonly kind: "ready"; readonly source: InspectionSource; readonly manifest: InspectionDatasetManifest }
  | { readonly kind: "ack"; readonly receipt: InspectionBatchReceipt; readonly coverage: InspectionCoverage }
  | { readonly kind: "health_ack"; readonly revision: number; readonly coverage: InspectionCoverage }
  | { readonly kind: "receipt"; readonly id: string; readonly receipt: InspectionBatchReceipt | null; readonly coverage: InspectionCoverage }
  | { readonly kind: "flushed"; readonly id: number; readonly coverage: InspectionCoverage }
  | { readonly kind: "flush_rejected"; readonly id: number; readonly code: "inspection_flush_capacity" }
  | { readonly kind: "failed"; readonly code: string };
