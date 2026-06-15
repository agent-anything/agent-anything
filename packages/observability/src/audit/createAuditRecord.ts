import type { AuditRecord, CreateAuditRecordInput } from "./AuditRecord.js";

export function createAuditRecord(input: CreateAuditRecordInput): AuditRecord {
  return {
    id: input.id,
    taskId: input.taskId,
    eventName: input.eventName,
    timestamp: input.timestamp,
    actorRef: input.actorRef ?? null,
    workspaceId: input.workspaceId ?? null,
    subject: input.subject,
    action: input.action,
    target: input.target,
    outcome: input.outcome,
    payload: input.payload ?? {},
    metadata: input.metadata ?? {},
  };
}
