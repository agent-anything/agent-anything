import type { InspectionCoverage, InspectionLink, InspectionRecord, InspectionSubjectRef, InspectionContentDescriptor } from "../records/index.js";
import type { InspectionSource, InspectionDatasetManifest } from "../sources/index.js";

export interface InspectionSelection { readonly sourceId: string; readonly datasetId: string; readonly watermark: number }
export type InspectionViewQuery = "list_definitions" | "list_runs" | "list_records" | "get_hierarchy" | "get_lifecycle" | "get_data_flow" | "get_dependencies" | "get_scheduling" | "get_model_request" | "get_execution" | "get_timeline" | "get_telemetry";
export type InspectionQuery =
  | { readonly kind: "list_sources" }
  | { readonly kind: "list_datasets"; readonly sourceId: string; readonly after?: string }
  | { readonly kind: "get_snapshot"; readonly sourceId: string; readonly datasetId: string; readonly watermark?: number }
  | ({ readonly kind: InspectionViewQuery; readonly subject?: InspectionSubjectRef; readonly runId?: string; readonly recordKind?: string; readonly after?: number; readonly limit?: number } & InspectionSelection)
  | ({ readonly kind: "get_record"; readonly recordId: string } & InspectionSelection)
  | ({ readonly kind: "get_subject"; readonly subject: InspectionSubjectRef } & InspectionSelection)
  | ({ readonly kind: "get_content"; readonly contentId: string; readonly offset?: number; readonly length?: number } & InspectionSelection);

export interface InspectionGraphNode { readonly subject: InspectionSubjectRef; readonly record: InspectionRecord | null; readonly availability: "present" | "not_observed" }
export interface InspectionGraph { readonly nodes: readonly InspectionGraphNode[]; readonly links: readonly InspectionLink[]; readonly limited: boolean; readonly scope: "selected_neighborhood" | "dataset"; readonly nodeLimit: number; readonly edgeLimit: number }
export interface InspectionTimelineInterval { readonly id: string; readonly subject: InspectionSubjectRef; readonly activity: string; readonly clock: string; readonly start: string; readonly end: string | null; readonly horizon: string; readonly startRecordId: string; readonly endRecordId: string | null; readonly status: string | null }
export interface InspectionReadResult {
  readonly kind: InspectionQuery["kind"];
  readonly selection: InspectionSelection | null;
  readonly coverage: InspectionCoverage | null;
  readonly readAt: string;
  readonly sources: readonly InspectionSource[];
  readonly datasets: readonly InspectionDatasetManifest[];
  readonly records: readonly InspectionRecord[];
  readonly graph: InspectionGraph | null;
  readonly intervals: readonly InspectionTimelineInterval[];
  readonly telemetry: readonly unknown[];
  readonly content: { readonly descriptor: InspectionContentDescriptor; readonly text: string; readonly offset: number; readonly nextOffset: number | null } | null;
  readonly next: number | string | null;
  readonly limitations: readonly string[];
}
