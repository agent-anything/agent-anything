import type {
  ActionAdapterImplementation,
  ActionExecutor,
  ActionRegistrationSnapshot,
  FileBaseline,
} from "@agent-anything/action-execution";
import type { TaskWorkspaceScope } from "@agent-anything/agent-core/task";
import type { ToolCatalogSnapshot } from "@agent-anything/tools";
import type { CodeAgentFileLimits } from "../filesystem/FileSystemContracts.js";

export const CODE_AGENT_LIST_FILES_ACTION = "codeAgent.listFiles";
export const CODE_AGENT_READ_FILE_ACTION = "codeAgent.readFile";
export const CODE_AGENT_SEARCH_FILES_ACTION = "codeAgent.searchFiles";
export const CODE_AGENT_CREATE_FILE_ACTION = "codeAgent.createFile";
export const CODE_AGENT_UPDATE_FILE_ACTION = "codeAgent.updateFile";
export const CODE_AGENT_DELETE_FILE_ACTION = "codeAgent.deleteFile";

export type CodeAgentFileActionName =
  | typeof CODE_AGENT_LIST_FILES_ACTION
  | typeof CODE_AGENT_READ_FILE_ACTION
  | typeof CODE_AGENT_SEARCH_FILES_ACTION
  | typeof CODE_AGENT_CREATE_FILE_ACTION
  | typeof CODE_AGENT_UPDATE_FILE_ACTION
  | typeof CODE_AGENT_DELETE_FILE_ACTION;

export interface CreateCodeAgentFileActionCapabilityInput {
  readonly workspaceScope: TaskWorkspaceScope | undefined;
  readonly limits?: Partial<CodeAgentFileLimits>;
  readonly now?: () => string;
}

export interface CodeAgentFileActionCapability {
  readonly catalog: ToolCatalogSnapshot;
  readonly registrations: ActionRegistrationSnapshot;
  readonly adapters: readonly ActionAdapterImplementation[];
  readonly executors: readonly ActionExecutor[];
}

export interface CodeAgentFileActionRequest {
  readonly actionName: CodeAgentFileActionName;
  readonly input: Readonly<Record<string, unknown>>;
}

export type CodeAgentPreparedFileOperation =
  | "list"
  | "read"
  | "search"
  | "create"
  | "update"
  | "delete";

export interface CodeAgentPreparedFileInvocationPayload {
  readonly actionName: CodeAgentFileActionName;
  readonly operation: CodeAgentPreparedFileOperation;
  readonly rootName: string;
  readonly workspaceId: string;
  readonly workspaceRoot: string;
  readonly canonicalRoot: string;
  readonly relativePath: string;
  readonly canonicalTarget: string;
  readonly expectedBaseline: FileBaseline;
  readonly recursive: boolean | null;
  readonly query: string | null;
  readonly content: string | null;
}

export interface DeleteFileOutput {
  readonly rootName: string;
  readonly workspaceId: string;
  readonly path: string;
  readonly deleted: true;
}
