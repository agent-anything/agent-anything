import {
  ToolExecutionContextError,
  type ToolExecutionContext,
  type ToolExecutionContextResolver,
} from "@agent-anything/agent-core";
import type { TaskWorkspaceScope } from "@agent-anything/agent-core";
import {
  resolveExistingTarget,
} from "../file-tools/filesystemBoundary.js";
import { FileToolError } from "../file-tools/FileToolError.js";
import {
  CODE_AGENT_RUN_COMMAND_TOOL,
  type CodeAgentShellLimits,
} from "./ShellToolContracts.js";
import { parseRunCommandInput, ShellInputError } from "./shellInput.js";

export class CodeAgentShellExecutionContextResolver
implements ToolExecutionContextResolver {
  constructor(
    private readonly workspaceScope: TaskWorkspaceScope | undefined,
    private readonly limits: CodeAgentShellLimits,
  ) {}

  async resolve(input: Parameters<ToolExecutionContextResolver["resolve"]>[0]):
  Promise<ToolExecutionContext> {
    if (input.toolCall.toolName !== CODE_AGENT_RUN_COMMAND_TOOL) {
      return {
        workspace: input.defaultWorkspace,
        metadata: {},
      };
    }

    try {
      const commandInput = parseRunCommandInput(
        input.toolCall.input,
        this.limits,
      );
      const target = await resolveExistingTarget({
        workspaceScope: this.workspaceScope,
        rootName: commandInput.rootName,
        path: commandInput.cwd,
        expectedKind: "directory",
      });
      const workspace =
        this.workspaceScope?.roots[target.resolved.rootName];

      if (!workspace) {
        throw new ToolExecutionContextError(
          "workspace_root_not_found",
          "Selected task workspace root is not available.",
        );
      }

      return {
        workspace,
        permissionReason: commandInput.reason,
        metadata: {
          command: commandInput.command,
          args: commandInput.args,
          cwd: target.resolved.relativePath,
          rootName: target.resolved.rootName,
          workspaceId: target.resolved.workspaceId,
          timeoutMs: commandInput.timeoutMs,
        },
      };
    } catch (error) {
      if (error instanceof ToolExecutionContextError) {
        throw error;
      }
      if (error instanceof FileToolError || error instanceof ShellInputError) {
        throw new ToolExecutionContextError(
          error.code,
          error.message,
          "metadata" in error ? error.metadata : {},
        );
      }
      throw error;
    }
  }
}
