import type {
  ActionAdapterImplementation,
  ActionExecutor,
  ActionRegistrationSnapshot,
  FileBaseline,
} from "@agent-anything/agent-core/action-execution";
import type { TaskWorkspaceScope } from "@agent-anything/agent-core/task";
import type { ToolCatalogSnapshot, ToolProcessTerminationLimits } from "@agent-anything/tools";
import type { CodeAgentShellLimits, RunCommandOutput } from "../shell-tool/ShellToolContracts.js";

export const CODE_AGENT_RUN_COMMAND_ACTION = "codeAgent.runCommand";

export interface CreateCodeAgentCommandActionCapabilityInput {
  readonly workspaceScope: TaskWorkspaceScope | undefined;
  readonly limits?: Partial<CodeAgentShellLimits>;
  readonly environment?: Readonly<Record<string, string>>;
  readonly environmentPolicyId?: string;
  readonly termination?: Partial<ToolProcessTerminationLimits>;
  readonly now?: () => string;
  readonly nowMs?: () => number;
}

export interface CodeAgentCommandActionCapability {
  readonly catalog: ToolCatalogSnapshot;
  readonly registrations: ActionRegistrationSnapshot;
  readonly adapters: readonly ActionAdapterImplementation[];
  readonly executors: readonly ActionExecutor[];
}

export interface PreparedCommandInvocationPayload {
  readonly actionName: typeof CODE_AGENT_RUN_COMMAND_ACTION;
  readonly executablePath: string;
  readonly executableBaseline: FileBaseline;
  readonly displayCommand: string;
  readonly args: readonly string[];
  readonly rootName: string;
  readonly workspaceId: string;
  readonly workspaceRoot: string;
  readonly canonicalRoot: string;
  readonly cwdPath: string;
  readonly cwd: string;
  readonly cwdDisplay: string;
  readonly cwdBaseline: FileBaseline;
  readonly timeoutMs: number;
  readonly maxStdoutBytes: number;
  readonly maxStderrBytes: number;
  readonly environmentPolicyId: string;
  readonly environmentDigest: string;
  readonly runtimeEnvironmentId: string;
  readonly runtimeEnvironmentPlatform: "win32" | "posix";
  readonly runtimeEnvironmentFingerprint: string;
  readonly termination: ToolProcessTerminationLimits;
}

export type { RunCommandOutput };
