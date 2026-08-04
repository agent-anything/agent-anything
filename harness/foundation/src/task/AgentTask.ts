import {
  assertDateTime,
  assertMetadata,
  assertNonEmpty,
  assertRecord,
  snapshotMetadata,
} from "../validation.js";
import type { ISODateTimeString, Metadata } from "../primitives/index.js";

export interface AgentTask<TInput = unknown> {
  readonly id: string;
  readonly kind: string;
  readonly input: TInput;
  readonly createdAt: ISODateTimeString;
  readonly metadata: Metadata;
}

export function snapshotAgentTask<TInput>(
  task: AgentTask<TInput>,
): AgentTask<TInput> {
  assertRecord(task, "AgentTask");
  assertNonEmpty(task.id, "AgentTask.id");
  assertNonEmpty(task.kind, "AgentTask.kind");
  assertDateTime(task.createdAt, "AgentTask.createdAt");
  assertMetadata(task.metadata, "AgentTask.metadata");

  return Object.freeze({
    id: task.id,
    kind: task.kind,
    input: task.input,
    createdAt: task.createdAt,
    metadata: snapshotMetadata(task.metadata),
  });
}
