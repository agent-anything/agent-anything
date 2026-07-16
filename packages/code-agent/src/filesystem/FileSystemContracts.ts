export interface CodeAgentFileLimits {
  maxListEntries: number;
  maxReadBytes: number;
  maxSearchFileBytes: number;
  maxSearchMatches: number;
  maxWriteBytes: number;
}

export type WorkspaceFileEntryKind =
  | "file"
  | "directory"
  | "symbolicLink"
  | "other";

export interface WorkspaceFileEntry {
  path: string;
  kind: WorkspaceFileEntryKind;
  sizeBytes: number | null;
}

export interface ListFilesOutput {
  rootName: string;
  workspaceId: string;
  path: string;
  entries: WorkspaceFileEntry[];
  truncated: boolean;
}

export interface ReadFileOutput {
  rootName: string;
  workspaceId: string;
  path: string;
  content: string;
  sizeBytes: number;
}

export interface FileSearchMatch {
  path: string;
  line: number;
  column: number;
  preview: string;
}

export interface SearchFilesOutput {
  rootName: string;
  workspaceId: string;
  path: string;
  query: string;
  matches: FileSearchMatch[];
  truncated: boolean;
  skippedFiles: number;
}

export interface FileWriteOutput {
  rootName: string;
  workspaceId: string;
  path: string;
  bytesWritten: number;
  created: boolean;
  replaced: boolean;
}
