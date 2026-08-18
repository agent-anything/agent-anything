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
  readonly maxListEntries: number;
  readonly maxReadBytes: number;
  readonly maxSearchFileBytes: number;
  readonly maxSearchMatches: number;
  readonly maxWriteBytes: number;
}

export type WorkspaceFileEntryKind = "file" | "directory" | "symbolicLink" | "other";

export interface WorkspaceFileEntry {
  readonly path: string;
  readonly kind: WorkspaceFileEntryKind;
  readonly sizeBytes: number | null;
}

export interface ListFilesOutput {
  readonly rootName: string;
  readonly workspaceId: string;
  readonly path: string;
  readonly entries: readonly WorkspaceFileEntry[];
  readonly truncated: boolean;
}

export interface ReadFileOutput {
  readonly rootName: string;
  readonly workspaceId: string;
  readonly path: string;
  readonly content: string;
  readonly sizeBytes: number;
}

export interface FileSearchMatch {
  readonly path: string;
  readonly line: number;
  readonly column: number;
  readonly preview: string;
}

export interface SearchFilesOutput {
  readonly rootName: string;
  readonly workspaceId: string;
  readonly path: string;
  readonly query: string;
  readonly matches: readonly FileSearchMatch[];
  readonly truncated: boolean;
  readonly skippedFiles: number;
}

export interface FileWriteOutput {
  readonly rootName: string;
  readonly workspaceId: string;
  readonly path: string;
  readonly bytesWritten: number;
  readonly created: boolean;
  readonly replaced: boolean;
}

export interface DeleteFileOutput {
  readonly rootName: string;
  readonly workspaceId: string;
  readonly path: string;
  readonly deleted: true;
}
