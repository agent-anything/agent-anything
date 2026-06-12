import type { Metadata } from "../shared/types.js";
import type { PermissionRisk } from "./PermissionRisk.js";

export interface PermissionTarget {
  kind: "tool" | "provider" | "storage" | "system" | "remote_tool";
  name?: string;
  resource?: string;
  metadata?: Metadata;
}

export interface PermissionSubject {
  kind: "user" | "agent" | "service" | "host" | "anonymous";
  id?: string;
  displayName?: string;
  metadata?: Metadata;
}

export interface PermissionRequestInput {
  id: string;
  taskId: string;
  action: string;
  risk: PermissionRisk;
  reason: string;
  subject?: PermissionSubject;
  target?: PermissionTarget;
  toolCallId?: string;
  toolName?: string;
  metadata: Metadata;
}

export type PermissionRequest = PermissionRequestInput;
