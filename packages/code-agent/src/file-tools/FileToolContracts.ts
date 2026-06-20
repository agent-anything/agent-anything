import type { TaskWorkspaceScope } from "@agent-anything/agent-core";

export const CODE_AGENT_LIST_FILES_TOOL = "codeAgent.listFiles";
export const CODE_AGENT_READ_FILE_TOOL = "codeAgent.readFile";
export const CODE_AGENT_SEARCH_FILES_TOOL = "codeAgent.searchFiles";
export const CODE_AGENT_WRITE_FILE_TOOL = "codeAgent.writeFile";

export interface CodeAgentFileToolLimits {
  maxListEntries: number;
  maxReadBytes: number;
  maxSearchFileBytes: number;
  maxSearchMatches: number;
  maxWriteBytes: number;
}

export interface CreateCodeAgentFileToolsInput {
  workspaceScope: TaskWorkspaceScope | undefined;
  limits?: Partial<CodeAgentFileToolLimits>;
  now?: () => string;
}

export interface WorkspaceFileInput {
  rootName?: string;
  path: string;
}

export interface ListFilesInput extends WorkspaceFileInput {
  recursive?: boolean;
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

export type ReadFileInput = WorkspaceFileInput;

export interface ReadFileOutput {
  rootName: string;
  workspaceId: string;
  path: string;
  content: string;
  sizeBytes: number;
}

export interface SearchFilesInput extends WorkspaceFileInput {
  query: string;
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

export interface WriteFileInput extends WorkspaceFileInput {
  content: string;
  overwrite?: boolean;
}

export interface WriteFileOutput {
  rootName: string;
  workspaceId: string;
  path: string;
  bytesWritten: number;
  created: boolean;
  replaced: boolean;
}
