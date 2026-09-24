import type {
  HelarcRunSnapshot,
} from "./HelarcDesktopApi.js";

export type HelarcOutputSource =
  | {
      readonly kind: "model_text";
      readonly turnId: string;
      readonly modelItemIds: readonly string[];
    }
  | { readonly kind: "model_finish"; readonly turnId: string }
  | { readonly kind: "product_status" };

export type HelarcPresentationValue =
  | null
  | boolean
  | number
  | string
  | readonly HelarcPresentationValue[]
  | { readonly [key: string]: HelarcPresentationValue };

export interface HelarcRunPresentationRecord {
  readonly id: string;
  readonly runId: string;
  readonly sequence: number;
  readonly revision: number;
  readonly observedAt: string;
  readonly source: {
    readonly owner: "runtime";
    readonly kind: "run_item";
    readonly id: string;
    readonly sequence: number;
  };
  readonly content:
    | {
        readonly kind: "assistant_text";
        readonly turnId: string;
        readonly modelItemId: string;
        readonly ordinal: number;
        readonly text: string;
        readonly omittedBytes: number;
      }
    | {
        readonly kind: "tool_call";
        readonly callId: string;
        readonly turnId: string;
        readonly name: string;
        readonly callableKind: "tool" | "control" | "unresolved";
        readonly toolBindingKind: "operation" | "interaction" | "descendant_agent" | "descendant_message" | null;
        readonly interactionProtocol: { readonly owner: string; readonly kind: string; readonly revision: string } | null;
        readonly title: string;
        readonly input: HelarcPresentationValue;
        readonly runActionId: string | null;
        readonly invocationId: string | null;
        readonly settlement: string | null;
        readonly result: HelarcPresentationValue;
      }
    | { readonly kind: "plan_update"; readonly plan: HelarcPresentationValue }
    | {
        readonly kind: "steering";
        readonly commandId: string;
        readonly instruction: string;
        readonly origin: "user" | "host" | "model";
        readonly disposition: string;
        readonly omittedBytes: number;
      }
    | {
        readonly kind: "interaction" | "lifecycle";
        readonly title: string;
        readonly detail: HelarcPresentationValue;
      };
}

export interface HelarcRunLabel {
  readonly runId: string;
  readonly parentRunId: string | null;
  readonly parentRunActionId: string | null;
  readonly label: string;
  readonly objective: string | null;
}

export interface HelarcCommandProgress {
  readonly runId: string;
  readonly executionId: string;
  readonly revision: number;
  readonly phase: string;
  readonly processId: number | null;
  readonly outcome: string | null;
  readonly capturedBytes: number;
  readonly omittedBytes: number | null;
  readonly outputPersistence: string;
  readonly observedAt: string;
  readonly command?: string;
  readonly shell?: string;
  readonly cwd?: string;
  readonly startedAt?: string | null;
  readonly completedAt?: string | null;
  readonly exitCode?: number | null;
  readonly invocationId?: string | null;
  readonly attemptId?: string | null;
}
export interface WorkbenchScope {
  readonly threadId: string;
  readonly productRunId: string;
  readonly runId: string;
}
export interface WorkScope {
  readonly threadId: string;
  readonly productRunId: string;
}
export interface CurrentWorkQuery extends WorkScope {
  readonly collection?: "tasks" | "calls" | "commands";
  readonly cursor?: string | null;
}
export interface ConversationQuery {
  readonly threadId: string;
  readonly position:
    | { readonly kind: "latest" }
    | { readonly kind: "before"; readonly cursor: string };
}
export interface ConversationEntry {
  readonly id: string;
  readonly title: string | null;
  readonly revision: number;
  readonly position: readonly [number, number];
  readonly role: "user" | "assistant" | "system" | "product";
  readonly kind: "message" | "assistant_text" | "steering" | "interaction";
  readonly content: string;
  readonly omittedBytes: number;
  readonly productRunId: string | null;
  readonly runId: string | null;
  readonly sourceId: string;
  readonly modelItemIds: readonly string[];
  readonly detail: WorkbenchItemQuery | null;
  readonly artifactIds: readonly string[];
  readonly disposition: string | null;
}
export interface ConversationPage {
  readonly status: "page";
  readonly threadId: string;
  readonly revision: number;
  readonly entries: readonly ConversationEntry[];
  readonly latestPosition: readonly [number, number] | null;
  readonly previousCursor: string | null;
  readonly omittedRecords: number;
}
export interface TaskSummary {
  readonly runId: string;
  readonly parentRunId: string | null;
  readonly label: string;
  readonly objective: string | null;
  readonly status: string;
  readonly terminalCode: string | null;
  readonly hasPlan: boolean;
  readonly hasFinishedWork: boolean;
}
export interface WorkbenchActivityItem {
  readonly id: string;
  readonly runId: string;
  readonly kind: "command" | "operation" | "response" | "attention";
  readonly title: string;
  readonly attribution: string | null;
  readonly state: "ongoing" | "waiting" | "settled" | "inactive";
  readonly status: string;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  readonly detail: { readonly kind: "command"; readonly executionId: string }
    | { readonly kind: "operation"; readonly itemId: string } | null;
}
export interface WorkbenchActivity {
  readonly current: readonly WorkbenchActivityItem[];
  readonly recent: readonly WorkbenchActivityItem[];
  readonly omittedCurrent: number;
  readonly omittedRecent: number;
}
export interface CurrentWorkPage {
  readonly status: "page";
  readonly scope: WorkScope;
  readonly live: boolean;
  readonly revision: number;
  readonly rootRunId: string;
  readonly workStatus: string;
  readonly activity: WorkbenchActivity;
  readonly tasks: readonly TaskSummary[];
  readonly plan: HelarcPresentationValue;
  readonly activeCalls: readonly HelarcRunPresentationRecord[];
  readonly commands: readonly HelarcCommandProgress[];
  readonly attention: readonly {
    readonly runId: string;
    readonly request: HelarcRunSnapshot["host"]["pendingInteractions"][number]["request"];
    readonly phase: string;
  }[];
  readonly context: {
    readonly model: string | null;
    readonly provider: string | null;
    readonly permissionPreset: string;
    readonly enforcement: string;
    readonly source: "bound_run";
    readonly effectiveGrants: "not_projected";
  };
  readonly omitted: {
    readonly tasks: number;
    readonly calls: number;
    readonly commands: number;
  };
  readonly nextCursors: {
    readonly tasks: string | null;
    readonly calls: string | null;
    readonly commands: string | null;
  };
  readonly retainedFinishedCount: number;
  readonly artifactIds: readonly string[];
}
export interface TaskDetailsPage {
  readonly status: "page";
  readonly scope: WorkbenchScope;
  readonly live: boolean;
  readonly task: TaskSummary;
  readonly plan: HelarcPresentationValue;
  readonly artifactIds: readonly string[];
  readonly problem: { readonly message: string; readonly code: string | null } | null;
}
export interface WorkHistoryQuery extends WorkbenchScope {
  readonly collection: "operations" | "assistant" | "commands";
  readonly cursor: string | null;
}
export interface WorkHistoryPage {
  readonly status: "page";
  readonly scope: WorkbenchScope;
  readonly collection: "operations" | "assistant" | "commands";
  readonly records: readonly HelarcRunPresentationRecord[];
  readonly commands: readonly HelarcCommandProgress[];
  readonly previousCursor: string | null;
  readonly omittedRecords: number;
}
export interface ArtifactContentQuery {
  readonly threadId: string;
  readonly artifactId: string;
  readonly cursor: string | null;
}
export type ArtifactContentRead =
  | WorkbenchRejected
  | {
      readonly status: "unavailable";
      readonly reason: "restricted" | "unsupported_reference";
    }
  | {
      readonly status: "page";
      readonly artifactId: string;
      readonly revision: string;
      readonly mediaType: string;
      readonly text: string;
      readonly nextCursor: string | null;
      readonly completeness: string;
      readonly integrity: HelarcPresentationValue;
      readonly limitations: readonly string[];
      readonly projected: boolean;
    };

export interface ResponsePreviewPart {
  readonly id: string;
  readonly kind: "text" | "tool_call";
  readonly name: string | null;
  readonly text: string;
  readonly offset: number;
  readonly nextOffset: number | null;
  readonly receivedLength: number;
  readonly omittedBytes: number;
  readonly modelItemId: string | null;
  readonly turnId: string | null;
  readonly committedRecordId: string | null;
}
export interface ResponsePreviewSummary {
  readonly runId: string;
  readonly requestId: string;
  readonly controllerRequestId: string;
  readonly invocationId: string;
  readonly revision: number;
  readonly state: string;
  readonly code: string | null;
  readonly parts: readonly ResponsePreviewPart[];
}
export interface ResponsePreviewQuery extends WorkbenchScope {
  readonly invocationId: string | null;
  readonly cursor: string | null;
}
export type ResponsePreviewRead =
  | WorkbenchRejected
  | {
      readonly status: "page";
      readonly scope: WorkbenchScope;
      readonly live: boolean;
      readonly revision: number;
      readonly attempts: readonly ResponsePreviewSummary[];
      readonly omittedAttempts: number;
      readonly nextCursor: string | null;
    };
export interface ResponseProgressFrame {
  readonly subscriptionId: string;
  readonly scope: WorkScope;
  readonly sequence: number;
  readonly previewRevision: number;
  readonly attempt: ResponsePreviewSummary;
  readonly resyncRequired: boolean;
}
export type WorkbenchRejected = {
  readonly status: "rejected";
  readonly code: "invalid_query" | "not_found" | "stale_cursor" | "read_failed";
};
export interface ThreadRunSummary {
  readonly productRunId: string;
  readonly harnessRunId: string | null;
  readonly startedAt: string;
  readonly completedAt: string | null;
  readonly status: string;
  readonly live: boolean;
  readonly objective: string;
}
export interface WorkbenchItemQuery extends WorkbenchScope {
  readonly itemId: string;
  readonly offset?: number;
  readonly section?: string;
}
export interface WorkbenchOperationSection {
  readonly id: string;
  readonly label: string;
  readonly format: "text" | "markdown" | "json";
  readonly text: string;
  readonly nextOffset: number | null;
}
export interface WorkbenchOperationDetail {
  readonly title: string;
  readonly summary: string | null;
  readonly status: string;
  readonly child: { readonly runId: string; readonly label: string; readonly status: string } | null;
  readonly facts: readonly { readonly label: string; readonly value: string }[];
  readonly sections: readonly WorkbenchOperationSection[];
}
export type WorkbenchItemPage =
  | WorkbenchRejected
  | { readonly status: "operation"; readonly itemId: string; readonly detail: WorkbenchOperationDetail }
  | {
      readonly status: "page";
      readonly itemId: string;
      readonly title: string;
      readonly text: string;
      readonly nextOffset: number | null;
      readonly omittedBytes: number;
    };
export interface CommandOutputQuery extends WorkbenchScope {
  readonly executionId: string;
  readonly cursor: string | null;
}
export interface CommandOutputStream {
  readonly text: string;
  readonly encoding: string | null;
  readonly integrity: string;
  readonly omittedBytes: number;
  readonly replacementCount: number;
}
export type CommandOutputPage =
  | WorkbenchRejected
  | { readonly status: "cursor_reset_required" }
  | {
      readonly status: "unavailable";
      readonly reason:
        | "not_recorded"
        | "not_retained"
        | "missing"
        | "incomplete_manifest"
        | "source_changed"
        | "read_failed";
    }
  | {
      readonly status: "page";
      readonly source: "live" | "retained";
      readonly stdout: CommandOutputStream;
      readonly stderr: CommandOutputStream;
      readonly nextCursor: string;
      readonly hasMore: boolean;
      readonly settled: boolean;
    };
