import type { Metadata } from "@agent-anything/shared";
import type { ToolCall } from "@agent-anything/tools";
import type { WorkspaceContext } from "@agent-anything/governance";
import type { AgentTask } from "../task/index.js";

export interface ToolExecutionContext {
  workspace?: WorkspaceContext;
  permissionReason?: string;
  metadata: Metadata;
}

export interface ResolveToolExecutionContextInput {
  task: AgentTask;
  toolCall: ToolCall;
  defaultWorkspace?: WorkspaceContext;
}

export interface ToolExecutionContextResolver {
  resolve(
    input: ResolveToolExecutionContextInput,
  ): ToolExecutionContext | Promise<ToolExecutionContext>;
}
export class ToolExecutionContextError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly metadata: Metadata = {},
  ) {
    super(message);
    this.name = "ToolExecutionContextError";
  }
}
