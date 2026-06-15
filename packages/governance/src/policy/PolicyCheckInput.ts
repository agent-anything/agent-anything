import type { Metadata } from "@agent-anything/shared";
import type { ToolRisk } from "@agent-anything/tools";

export type PolicyRisk = ToolRisk;

export interface PolicySubject {
  kind: "user" | "agent" | "service" | "anonymous";
  id?: string;
  displayName?: string;
  roles?: string[];
  metadata?: Metadata;
}

export interface PolicyTarget {
  kind: "tool" | "provider" | "storage" | "system" | "remote_tool";
  name?: string;
  resource?: string;
  metadata?: Metadata;
}

export interface PolicyWorkspace {
  id?: string;
  trustLevel?: "trusted" | "restricted" | "unknown";
  metadata?: Metadata;
}

export interface PolicyCheckInput {
  id: string;
  taskId: string;
  action: string;
  subject?: PolicySubject;
  target?: PolicyTarget;
  risk: PolicyRisk;
  workspace?: PolicyWorkspace;
  metadata: Metadata;
}
