import type {
  HelarcRunActivitySnapshot,
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
        readonly input: HelarcPresentationValue;
        readonly runActionId: string | null;
        readonly invocationId: string | null;
        readonly settlement: string | null;
        readonly result: HelarcPresentationValue;
      }
    | { readonly kind: "plan_update"; readonly plan: HelarcPresentationValue }
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
export interface WorkbenchQuery extends WorkbenchScope {
  readonly includeDescendants: boolean;
  readonly cursor: string | null;
  readonly limit?: number;
}
export interface WorkbenchPage {
  readonly status: "page";
  readonly scope: WorkbenchScope;
  readonly live: boolean;
  readonly revision: number;
  readonly recordedAt: string;
  readonly run: HelarcRunSnapshot;
  readonly labels: readonly HelarcRunLabel[];
  readonly plans: Readonly<Record<string, HelarcPresentationValue>>;
  readonly records: readonly HelarcRunPresentationRecord[];
  readonly commands: readonly HelarcCommandProgress[];
  readonly activity: readonly HelarcRunActivitySnapshot[];
  readonly nextCursor: string | null;
  readonly omittedRecords: number;
  readonly finalSource: HelarcOutputSource;
}
export interface WorkbenchItemQuery extends WorkbenchScope {
  readonly itemId: string;
  readonly offset?: number;
}
export type WorkbenchItemPage =
  | WorkbenchRejected
  | {
      readonly status: "page";
      readonly itemId: string;
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
