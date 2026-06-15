import type { ISODateTimeString, Metadata } from "@agent-anything/shared";

export type AuditOutcome = "succeeded" | "failed" | "blocked" | "cancelled";

export interface AuditSubject {
  kind: string;
  id: string;
  metadata: Metadata;
}

export interface AuditTarget {
  kind: string;
  id: string;
  metadata: Metadata;
}

export interface AuditRecord {
  id: string;
  taskId: string;
  eventName: string;
  timestamp: ISODateTimeString;
  actorRef: string | null;
  workspaceId: string | null;
  subject: AuditSubject;
  action: string;
  target: AuditTarget;
  outcome: AuditOutcome;
  payload: Metadata;
  metadata: Metadata;
}

export interface CreateAuditRecordInput {
  id: string;
  taskId: string;
  eventName: string;
  timestamp: ISODateTimeString;
  actorRef?: string | null;
  workspaceId?: string | null;
  subject: AuditSubject;
  action: string;
  target: AuditTarget;
  outcome: AuditOutcome;
  payload?: Metadata;
  metadata?: Metadata;
}
