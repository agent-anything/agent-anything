import type { RunItem } from "../run/index.js";

export interface RunTranscriptRecord<TOutput = unknown> {
  readonly runId: string;
  readonly sequence: number;
  readonly item: RunItem<TOutput>;
}

export type RunTranscriptAppendResult =
  | { readonly status: "stored" }
  | {
      readonly status: "failed";
      readonly code: string;
      readonly message: string;
    };

export interface RunTranscriptPort {
  append(record: RunTranscriptRecord): Promise<RunTranscriptAppendResult>;
}

export function createRunTranscriptRecord<TOutput>(
  item: RunItem<TOutput>,
): RunTranscriptRecord<TOutput> {
  return deepFreeze({
    runId: item.ref.run.id,
    sequence: item.ref.sequence,
    item,
  });
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

