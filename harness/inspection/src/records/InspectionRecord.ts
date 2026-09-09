export const INSPECTION_FORMAT_VERSION = 1 as const;

export type InspectionJson = null | boolean | number | string |
  readonly InspectionJson[] | { readonly [key: string]: InspectionJson };
export type InspectionContentClass = "definition" | "agent" | "provider" | "execution";
export type InspectionSubjectKind = "run" | "turn" | "request" | "provider-attempt" |
  "call" | "operation" | "action" | "attempt" | "control" | "definition" |
  "artifact" | "context" | "contribution" | "hook" | "event";

export interface InspectionSubjectRef {
  readonly sourceId: string;
  readonly datasetId: string;
  readonly owner: string;
  readonly kind: InspectionSubjectKind;
  readonly id: string;
  readonly runId: string | null;
  readonly revision: string | null;
}

export interface InspectionContentLocation {
  readonly contentId: string | null;
  readonly partId: string | null;
  readonly jsonPointer: string | null;
  readonly stage: string;
}

export type InspectionRelationKind = "contains" | "descendant" | "binding" |
  "materializes" | "trigger" | "produces" | "transforms" | "delivers" |
  "includes" | "omits" | "prerequisite" | "retry" | "settles" | "cause";

export interface InspectionLink {
  readonly id: string;
  readonly from: InspectionSubjectRef;
  readonly to: InspectionSubjectRef;
  readonly kind: InspectionRelationKind;
  readonly condition: "settled" | "succeeded" | "result" | null;
  readonly operation: string | null;
  readonly sourceLocation: InspectionContentLocation | null;
  readonly targetLocation: InspectionContentLocation | null;
  readonly establishedBy: string;
}

export interface InspectionLifecycleDefinition {
  readonly revision: string;
  readonly states: readonly string[];
  readonly transitions: readonly { readonly id: string; readonly from: string; readonly to: string; readonly trigger: string }[];
}

export interface InspectionPayloadMap {
  definition: { readonly definitionKind: "tool" | "agent" | "provider" | "instructions" | "hook";
    readonly name: string; readonly revision: string; readonly enabled: boolean | null };
  snapshot: { readonly status: string; readonly revision: number; readonly agentId: string | null;
    readonly parentRunId: string | null; readonly taskId: string | null };
  lifecycle: InspectionLifecycleDefinition;
  transition: { readonly from: string | null; readonly to: string; readonly revision: number;
    readonly transitionId: string | null; readonly reasonCode: string | null };
  exposure: { readonly requestId: string; readonly selected: readonly string[];
    readonly exposed: readonly string[]; readonly omitted: readonly { readonly id: string; readonly reason: string }[] };
  request: { readonly purpose: string; readonly providerId: string; readonly model: string | null;
    readonly compositionId: string | null; readonly messageCount: number; readonly toolCount: number };
  response: { readonly status: string; readonly finishReason: string | null; readonly callCount: number;
    readonly inputTokens: number | null; readonly outputTokens: number | null };
  transport: { readonly phase: "started" | "settled" | "rejected"; readonly requestId: string;
    readonly providerId: string; readonly method: string; readonly endpoint: string;
    readonly httpStatus: number | null; readonly status: string; readonly code: string | null;
    readonly encodedBytes: number | null };
  scheduling: { readonly position: number; readonly disposition: "admitted" | "rejected" | "queued" | "dispatched" | "settled" | "invalidated";
    readonly rule: string; readonly reason: string | null; readonly groupId: string | null };
  execution: { readonly phase: "started" | "settled" | "pending"; readonly executionKind: string;
    readonly status: string; readonly code: string | null; readonly effectCertainty: string | null };
  transfer: { readonly stage: "produced" | "transformed" | "delivered" | "included" | "omitted";
    readonly producerId: string; readonly consumerId: string | null; readonly operation: string | null };
  dependency: { readonly condition: "settled" | "succeeded" | "result";
    readonly status: "registered" | "satisfied" | "unsatisfied"; readonly prerequisiteId: string; readonly dependentId: string };
  event: { readonly name: string; readonly sequence: number | null; readonly code: string | null };
  interval: { readonly phase: "started" | "settled"; readonly activity: "run" | "controller" | "provider" | "operation" | "action" | "attempt" | "wait";
    readonly status: string | null; readonly clock: string };
}

export type InspectionPayload = { readonly [K in keyof InspectionPayloadMap]:
  { readonly kind: K } & InspectionPayloadMap[K]
}[keyof InspectionPayloadMap];

export interface InspectionContentInput {
  readonly unavailableReason?: string;
  readonly name: string;
  readonly class: InspectionContentClass;
  readonly stage: string;
  readonly mediaType: "application/json" | "text/plain";
  readonly value: InspectionJson;
}

export interface InspectionContentDescriptor {
  readonly unavailableReason?: string;
  readonly id: string;
  readonly name: string;
  readonly class: InspectionContentClass;
  readonly stage: string;
  readonly mediaType: string;
  readonly availability: "present" | "not_captured" | "unavailable";
  readonly retainedBytes: number;
  readonly originalBytes: number | null;
  readonly digest: string | null;
  readonly redacted: boolean;
  readonly truncated: boolean;
}

export interface InspectionRecordInput {
  readonly id?: string;
  readonly subject: InspectionSubjectRef;
  readonly occurredAt: string | null;
  readonly ownerSequence?: number | null;
  readonly payload: InspectionPayload;
  readonly links?: readonly Omit<InspectionLink, "id" | "establishedBy">[];
  readonly contents?: readonly InspectionContentInput[];
}

export interface InspectionRecord {
  readonly id: string;
  readonly subject: InspectionSubjectRef;
  readonly occurredAt: string | null;
  readonly capturedAt: string;
  readonly ownerSequence: number | null;
  readonly captureSequence: number;
  readonly commitSequence: number;
  readonly policyRevision: string;
  readonly payload: InspectionPayload;
  readonly links: readonly InspectionLink[];
  readonly contents: readonly InspectionContentDescriptor[];
}

export interface InspectionCoverage {
  readonly status: "open" | "closed" | "unknown";
  readonly watermark: number;
  readonly captured: number;
  readonly dropped: number;
  readonly rejected: number;
  readonly telemetryDropped: number;
  readonly heartbeat: string;
  readonly limitations: readonly string[];
}

export function inspectionSubjectKey(ref: InspectionSubjectRef): string {
  return JSON.stringify([ref.sourceId, ref.datasetId, ref.owner, ref.kind, ref.runId, ref.id, ref.revision]);
}
