import type { Metadata } from "../../shared/types.js";
import type { ToolRisk } from "../../tools/index.js";

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
