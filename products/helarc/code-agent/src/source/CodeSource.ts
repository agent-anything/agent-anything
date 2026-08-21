import type { FileBaseline } from "@agent-anything/canonical-action/subject";
import type { WorkspaceSelection } from "@agent-anything/workspace/selection";

export type CodeSourceOperation =
  | "observe"
  | "list"
  | "read"
  | "search"
  | "create"
  | "update"
  | "delete";

export interface CodeSourceTargetRef {
  readonly rootName: string;
  readonly workspaceId: string;
  readonly path: string;
}

export interface CodeSourceContentRef {
  readonly algorithm: "sha256";
  readonly digest: string;
  readonly byteLength: number;
}

export interface CodeSourceSnapshot {
  readonly target: CodeSourceTargetRef;
  readonly baseline: FileBaseline;
  readonly content: string | null;
  readonly contentRef: CodeSourceContentRef | null;
  readonly capturedAt: string;
}

export interface CaptureCodeSourceInput {
  readonly workspace: WorkspaceSelection | null;
  readonly rootName?: string;
  readonly path: string;
  readonly operation: "observe" | "create" | "update" | "delete";
  readonly maxContentBytes: number;
}

export interface RehydrateCodeSourceInput {
  readonly workspace: WorkspaceSelection | null;
  readonly expected: CodeSourceSnapshot;
  readonly maxContentBytes: number;
}

export type CodeSourceCaptureResult =
  | { readonly status: "captured"; readonly snapshot: CodeSourceSnapshot }
  | {
      readonly status: "invalid" | "unavailable" | "failed";
      readonly owner: "helarc.code-workspace";
      readonly code: string;
      readonly message: string;
    };

export type CodeSourceRehydrationResult =
  | { readonly status: "matched"; readonly snapshot: CodeSourceSnapshot }
  | {
      readonly status: "changed";
      readonly snapshot: CodeSourceSnapshot;
      readonly owner: "helarc.code-workspace";
      readonly code: string;
      readonly message: string;
    }
  | {
      readonly status: "invalid" | "unavailable" | "failed";
      readonly owner: "helarc.code-workspace";
      readonly code: string;
      readonly message: string;
    };

export interface CodeSourcePort {
  capture(input: CaptureCodeSourceInput): Promise<CodeSourceCaptureResult>;
  rehydrate(input: RehydrateCodeSourceInput): Promise<CodeSourceRehydrationResult>;
}

export interface CodeAgentFileLimits {
  readonly maxGlobEntries: number;
  readonly maxReadBytes: number;
  readonly maxReadLines: number;
  readonly maxSearchFileBytes: number;
  readonly maxGrepMatches: number;
  readonly maxGrepContextLines: number;
  readonly maxWriteBytes: number;
}

export interface CodeFileBaselineOutput {
  readonly target_id: string;
  readonly file_path: string;
  readonly byte_length: number;
  readonly content_digest: string;
}

export interface CodeFileReadOutput extends CodeFileBaselineOutput {
  readonly content: string;
  readonly start_line: number;
  readonly end_line: number;
  readonly total_lines: number;
  readonly truncated: boolean;
}

export interface CodeFileGlobOutput {
  readonly matches: readonly string[];
  readonly truncated: boolean;
  readonly omitted_count: number;
}

export interface CodeFileGrepContentEntry {
  readonly file_path: string;
  readonly line: number;
  readonly column: number;
  readonly text: string;
  readonly before: readonly string[];
  readonly after: readonly string[];
}

export type CodeFileGrepEntry =
  | CodeFileGrepContentEntry
  | { readonly file_path: string }
  | { readonly file_path: string; readonly count: number };

export interface CodeFileGrepOutput {
  readonly output_mode: "content" | "files_with_matches" | "count";
  readonly entries: readonly CodeFileGrepEntry[];
  readonly truncated: boolean;
  readonly omitted_count: number;
}

export interface CodeFileEditOutput {
  readonly target_id: string;
  readonly file_path: string;
  readonly operation: "updated";
  readonly replacement_count: number;
  readonly previous_baseline: CodeFileBaselineOutput;
  readonly current_baseline: CodeFileBaselineOutput;
}

export interface CodeFileWriteOutput {
  readonly target_id: string;
  readonly file_path: string;
  readonly operation: "created" | "replaced";
  readonly previous_baseline: CodeFileBaselineOutput | null;
  readonly current_baseline: CodeFileBaselineOutput;
}
