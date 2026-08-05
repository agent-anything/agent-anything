import type { RunInputItem } from "./RunInputItem.js";
import {
  assertDateTime,
  assertMetadata,
  assertNonEmpty,
  assertRecord,
  snapshotMetadata,
} from "../validation.js";
import {
  snapshotAgentTask,
  type AgentTask,
} from "../task/index.js";

export interface RunInput<TTaskInput = unknown> {
  readonly task: AgentTask<TTaskInput>;
  readonly items: readonly RunInputItem[];
  readonly metadata: Readonly<Record<string, unknown>>;
}

export function snapshotRunInput<TTaskInput>(
  input: RunInput<TTaskInput>,
): RunInput<TTaskInput> {
  assertRecord(input, "RunInput");
  if (!Array.isArray(input.items)) {
    throw new TypeError("RunInput.items must be an array.");
  }
  assertMetadata(input.metadata, "RunInput.metadata");

  const ids = new Set<string>();
  const items: RunInputItem[] = input.items.map((item, index) => {
    assertRecord(item, `RunInput.items[${index}]`);
    assertNonEmpty(item.id, `RunInput.items[${index}].id`);
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
    task: snapshotAgentTask(input.task),
    items: Object.freeze(items),
    metadata: snapshotMetadata(input.metadata),
  });
}
