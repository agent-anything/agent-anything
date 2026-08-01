import type { RunInputItem } from "../interaction/index.js";
import {
  assertDateTime,
  assertMetadata,
  assertNonEmpty,
  assertRecord,
  snapshotMetadata,
} from "../internal/validation.js";
import type { Metadata } from "../primitives/index.js";
import {
  snapshotAgentTask,
  type AgentTask,
} from "../task/index.js";

export interface RunInput<TTaskInput = unknown> {
  readonly runId: string;
  readonly task: AgentTask<TTaskInput>;
  readonly conversationItems: readonly RunInputItem[];
  readonly metadata: Metadata;
}

export function snapshotRunInput<TTaskInput>(
  input: RunInput<TTaskInput>,
): RunInput<TTaskInput> {
  assertRecord(input, "RunInput");
  assertNonEmpty(input.runId, "RunInput.runId");
  if (!Array.isArray(input.conversationItems)) {
    throw new TypeError("RunInput.conversationItems must be an array.");
  }
  assertMetadata(input.metadata, "RunInput.metadata");

  const ids = new Set<string>();
  const conversationItems: RunInputItem[] = input.conversationItems.map((item, index) => {
    assertRecord(item, `RunInput.conversationItems[${index}]`);
    assertNonEmpty(item.id, `RunInput.conversationItems[${index}].id`);
    if (ids.has(item.id)) {
      throw new TypeError(`RunInput conversation item id '${item.id}' is duplicated.`);
    }
    ids.add(item.id);
    if (item.kind !== "message") {
      throw new TypeError(`RunInput conversation item '${item.id}' kind is unsupported.`);
    }
    if (
      item.role !== "system" &&
      item.role !== "user" &&
      item.role !== "assistant"
    ) {
      throw new TypeError(`RunInput conversation item '${item.id}' role is unsupported.`);
    }
    if (typeof item.content !== "string") {
      throw new TypeError(`RunInput conversation item '${item.id}' content must be text.`);
    }
    assertDateTime(item.createdAt, `RunInput conversation item '${item.id}'.createdAt`);
    assertMetadata(item.metadata, `RunInput conversation item '${item.id}'.metadata`);
    return Object.freeze({
      id: item.id,
      kind: item.kind,
      role: item.role,
      content: item.content,
      createdAt: item.createdAt,
      metadata: snapshotMetadata(item.metadata),
    });
  });

  return Object.freeze({
    runId: input.runId,
    task: snapshotAgentTask(input.task),
    conversationItems: Object.freeze(conversationItems),
    metadata: snapshotMetadata(input.metadata),
  });
}
