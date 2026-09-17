import type { InspectionCoverage, InspectionLink, InspectionRecord, InspectionSubjectRef, InspectionContentDescriptor } from "../records/index.js";
import type { InspectionSource, InspectionDatasetManifest } from "../sources/index.js";
import type { ExecutionFlowDefinition, ExecutionFlowSubjectRef } from "@agent-anything/observability/execution-flow";

export interface InspectionSelection { readonly sourceId: string; readonly datasetId: string; readonly watermark: number }
export type InspectionViewQuery = "list_definitions" | "list_runs" | "list_records" | "get_hierarchy" | "get_lifecycle" | "get_data_flow" | "get_dependencies" | "get_scheduling" | "get_model_request" | "get_execution" | "get_timeline" | "get_telemetry";
export type InspectionQuery =
  | { readonly kind: "list_sources" }
  | { readonly kind: "list_datasets"; readonly sourceId: string; readonly after?: string }
  | { readonly kind: "get_snapshot"; readonly sourceId: string; readonly datasetId: string; readonly watermark?: number }
  | ({ readonly kind: InspectionViewQuery; readonly subject?: InspectionSubjectRef; readonly runId?: string; readonly includeDescendants?: boolean; readonly recordKind?: string; readonly after?: string; readonly limit?: number; readonly from?: string; readonly to?: string } & InspectionSelection)
  | ({ readonly kind: "get_record"; readonly recordId: string } & InspectionSelection)
  | ({ readonly kind: "get_subject"; readonly subject: InspectionSubjectRef } & InspectionSelection)
  | ({ readonly kind: "get_content"; readonly contentId: string; readonly offset?: number; readonly length?: number } & InspectionSelection)
  | InspectionFlowQuery;

export type InspectionFlowQuery = InspectionSelection & ({readonly kind: "get_execution_flow"} | {readonly kind: "list_flow_occurrences"} | {readonly kind: "get_flow_occurrence"}) & {
  readonly runId: string;
  readonly invocationId?: string;
  readonly occurrenceId?: string;
  readonly stepId?: string;
  readonly cursor?: string;
  readonly limit?: number;
};
export interface InspectionFlowRead {
  readonly definition: ExecutionFlowDefinition | null;
  readonly steps: readonly {readonly stepId: string; readonly visits: number; readonly exits: number; readonly failed: number}[];
  readonly transitions: readonly {readonly transitionId: string; readonly traversals: number}[];
  readonly links: readonly InspectionLink[];
  readonly occurrence: InspectionFlowOccurrenceRead | null;
  readonly occurrences?: readonly InspectionFlowOccurrenceSummary[];
  readonly relatedRecords?: readonly InspectionRecord[];
  readonly ancestry?: readonly InspectionRecord[];
}

export interface InspectionFlowOccurrenceSummary {
  readonly entry: InspectionRecord;
  readonly exit: InspectionRecord | null;
  readonly disposition: string;
  readonly branch: string | null;
  readonly durationMs: number | null;
  readonly checkCount: number;
  readonly issueCount: number;
}

export interface InspectionFlowOccurrenceRead {
  readonly status: "open" | "closed" | "incomplete";
  readonly checks: readonly {readonly id: string; readonly availability: "recorded" | "pending" | "not_observed"; readonly recordIds: readonly string[]}[];
  readonly references: readonly {
    readonly role: "input" | "output" | "configuration";
    readonly sourceRecordId: string;
    readonly position: number;
    readonly reference: ExecutionFlowSubjectRef;
    readonly availability: "present" | "observed_later" | "not_observed" | "unmapped";
    readonly recordId: string | null;
    readonly contents: readonly InspectionContentDescriptor[];
  }[];
}

export interface InspectionGraphNode { readonly subject: InspectionSubjectRef; readonly record: InspectionRecord | null; readonly availability: "present" | "not_observed" }
export interface InspectionGraph { readonly nodes: readonly InspectionGraphNode[]; readonly links: readonly InspectionLink[]; readonly limited: boolean; readonly scope: "selected_neighborhood" | "dataset"; readonly nodeLimit: number; readonly edgeLimit: number }
export interface InspectionTimelineInterval { readonly id: string; readonly subject: InspectionSubjectRef; readonly activity: string; readonly clock: string; readonly start: string; readonly end: string | null; readonly horizon: string; readonly startRecordId: string; readonly endRecordId: string | null; readonly status: string | null;
  readonly markers:readonly {readonly label:string;readonly occurredAt:string;readonly recordId:string}[];
}
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
  readonly relatedRecords?: readonly InspectionRecord[];
  readonly summaries?: readonly InspectionObjectSummary[];
  readonly flow?: InspectionFlowRead;
}

export interface InspectionObjectSummary {
  readonly subject: InspectionSubjectRef;
  readonly record: InspectionRecord;
  readonly label: string;
  readonly facts: readonly InspectionRecord[];
  readonly links: readonly InspectionLink[];
  readonly relatedRecords: readonly InspectionRecord[];
  readonly limited: boolean;
}
