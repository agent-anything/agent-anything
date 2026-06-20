import type { ISODateTimeString, Metadata } from "@agent-anything/shared";
import type { TaskWorkspaceScope } from "./TaskWorkspaceScope.js";

export interface AgentTask<TInput = unknown> {
  id: string;
  kind: string;
  input: TInput;
  createdAt: ISODateTimeString;
  metadata: Metadata;
  workspaceScope?: TaskWorkspaceScope;
}
