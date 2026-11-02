import type {InspectionContentDescriptor, InspectionCoverage, InspectionEvidenceBasis, InspectionLink, InspectionRecord, InspectionSubjectRef} from "../records/index.js";
import type {InspectionSelection} from "./InspectionQuery.js";

export const INSPECTION_PROCESS_QUERY_VERSION = "1" as const;
export const PROCESS_QUERY_KINDS = ["list_context_process", "get_context_decision", "get_actual_input", "get_context_path", "get_source_reception", "get_recovery_review", "get_process_observations"] as const;
export type InspectionProcessQueryKind = typeof PROCESS_QUERY_KINDS[number];
export interface InspectionRecordingIntroduction {
  readonly sourceId: string; readonly datasetId: string;
  readonly recordId: string;
  /** Null selects the explicit recording_link target, not a guessed Run match. */
  readonly linkId: string | null;
}
export interface InspectionReadManifest {
  readonly version: "1";
  readonly projectionVersion: "1";
  readonly recordings: readonly (InspectionSelection & {readonly projectionWatermark: number; readonly via: InspectionRecordingIntroduction | null})[];
}
export type InspectionProcessQuery = {
  readonly kind: InspectionProcessQueryKind;
  readonly manifest: InspectionReadManifest;
  readonly section: "facts" | "relationships" | "variants";
  readonly runId?: string;
  readonly runIds?: readonly string[];
  readonly categories?: readonly import("../records/index.js").InspectionProcessEvidence["category"][];
  /** Commit positions are local to each recording, not a shared clock. */
  readonly fromSequence?: number;
  readonly throughSequence?: number;
  readonly purpose?: string;
  readonly recipient?: {readonly runId: string; readonly recipient: string; readonly purpose: string};
  readonly subject?: InspectionSubjectRef;
  readonly recordId?: string;
  readonly evidence?: InspectionEvidenceBasis;
  readonly category?: import("../records/index.js").InspectionProcessEvidence["category"];
  readonly after?: string;
  readonly limit?: number;
};
export type InspectionProcessScopeQuery = {
  readonly kind: "open_process_scope";
  readonly recordings: readonly {readonly sourceId: string; readonly datasetId: string; readonly watermark?: number; readonly via: InspectionRecordingIntroduction | null}[];
} | {
  readonly kind: "get_process_content";
  readonly manifest: InspectionReadManifest;
  readonly location: {readonly sourceId: string; readonly datasetId: string; readonly recordId: string; readonly contentId: string};
  readonly offset?: number; readonly length?: number;
};
export type InspectionRecordingAvailability = "available" | "unavailable" | "retired" | "denied" | "corrupt" | "unsupported" | "introduction_unavailable";
export interface InspectionRecordingRead {
  readonly selection: InspectionSelection;
  readonly availability: InspectionRecordingAvailability;
  readonly coverage: InspectionCoverage | null;
  readonly index: "complete" | "lagging" | "unavailable";
  readonly limitation: string | null;
}
export interface InspectionContentAccess {
  readonly descriptor: InspectionContentDescriptor;
  readonly availability: "available" | "denied" | "not_captured" | "unavailable";
}
export interface InspectionProcessEntry {
  readonly record: InspectionRecord;
  /** Original identity groups observations; no observation is silently discarded. */
  readonly identity: InspectionEvidenceBasis | null;
  readonly contents: readonly InspectionContentAccess[];
  readonly relationCoverage: {readonly declared: number; readonly observedOrdinals: number; readonly conflictingOrdinals: number; readonly unexpectedOrdinals:number; readonly inconsistentTotals:number} | null;
}
export interface InspectionTargetRead {
  readonly subject: InspectionSubjectRef;
  readonly availability: "recorded" | "referenced_only" | "external" | "retired" | "denied" | "corrupt" | "unsupported" | "unavailable";
  readonly firstRecordId: string | null;
}
export interface InspectionProcessRelation {
  readonly link: InspectionLink;
  readonly observation: {readonly sourceId: string; readonly datasetId: string; readonly recordId: string; readonly sequence: number};
  readonly identity: InspectionEvidenceBasis | null;
  readonly ordinal: number | null;
  readonly total: number | null;
  readonly source: InspectionTargetRead;
  readonly target: InspectionTargetRead;
  readonly sourceContent: InspectionLocatedContent | null;
  readonly targetContent: InspectionLocatedContent | null;
}
export interface InspectionLocatedContent {
  readonly location: import("../records/index.js").InspectionContentLocation;
  readonly recording: {readonly sourceId:string;readonly datasetId:string};
  readonly recordId:string|null;
  readonly availability:"recorded"|"not_observed"|"external"|"unavailable"|"denied";
  readonly access:InspectionContentAccess|null;
}
export interface InspectionVariantRead {
  readonly selection: InspectionSelection;
  readonly identity: InspectionEvidenceBasis["origin"];
  readonly digest: string;
  readonly firstSequence: number;
  readonly recordId: string;
}
export interface InspectionProcessRead {
  readonly version: "1";
  readonly family: InspectionProcessQueryKind | InspectionProcessScopeQuery["kind"];
  readonly manifest: InspectionReadManifest;
  readonly recordings: readonly InspectionRecordingRead[];
  readonly entries: readonly InspectionProcessEntry[];
  readonly relationships: readonly InspectionProcessRelation[];
  readonly variants: readonly InspectionVariantRead[];
  readonly page: {readonly next: string | null; readonly reason: "end" | "page_limit" | "byte_limit"};
  /** Exhausting stored rows proves a query boundary, never execution absence. */
  readonly scan: "more" | "complete" | "incomplete";
  readonly contentAccess?: InspectionContentAccess;
  readonly anchor?: InspectionTargetRead;
}
