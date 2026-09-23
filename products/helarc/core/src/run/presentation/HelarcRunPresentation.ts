import type { RunTranscriptRecord } from "@agent-anything/agent-runtime/transcript";
import type { RunLineage } from "@agent-anything/agent-core/run-tree";

export type HelarcOutputSource =
  | {
      readonly kind: "model_text";
      readonly turnId: string;
      readonly modelItemIds: readonly string[];
    }
  | { readonly kind: "model_finish"; readonly turnId: string }
  | { readonly kind: "product_status" };

export type HelarcPresentationValue =
  | null
  | boolean
  | number
  | string
  | readonly HelarcPresentationValue[]
  | { readonly [key: string]: HelarcPresentationValue };

export interface HelarcRunPresentationRecord {
  readonly id: string;
  readonly runId: string;
  readonly sequence: number;
  readonly revision: number;
  readonly observedAt: string;
  readonly source: {
    readonly owner: "runtime";
    readonly kind: "run_item";
    readonly id: string;
    readonly sequence: number;
  };
  readonly content:
    | {
        readonly kind: "assistant_text";
        readonly turnId: string;
        readonly modelItemId: string;
        readonly ordinal: number;
        readonly text: string;
        readonly omittedBytes: number;
      }
    | {
        readonly kind: "tool_call";
        readonly callId: string;
        readonly turnId: string;
        readonly name: string;
        readonly input: HelarcPresentationValue;
        readonly runActionId: string | null;
        readonly invocationId: string | null;
        readonly settlement: string | null;
        readonly result: HelarcPresentationValue;
      }
    | { readonly kind: "plan_update"; readonly plan: HelarcPresentationValue }
    | { readonly kind: "steering"; readonly commandId: string; readonly instruction: string;
        readonly origin: "user" | "host" | "model"; readonly disposition: string; readonly omittedBytes: number }
    | {
        readonly kind: "interaction" | "lifecycle";
        readonly title: string;
        readonly detail: HelarcPresentationValue;
      };
}

export interface HelarcRunLabel {
  readonly runId: string;
  readonly parentRunId: string | null;
  readonly parentRunActionId: string | null;
  readonly label: string;
  readonly objective: string | null;
}

export interface HelarcRunPresentation {
  readonly revision: number;
  readonly nextSequence: number;
  readonly omittedRecords: number;
  readonly retainedBytes: number;
  readonly records: readonly HelarcRunPresentationRecord[];
  readonly activeCalls: readonly HelarcRunPresentationRecord[];
  readonly omittedActiveCalls: number;
  readonly labels: readonly HelarcRunLabel[];
  readonly plans: Readonly<Record<string, HelarcPresentationValue>>;
  readonly sourceSequences: Readonly<Record<string, number>>;
}

export function createHelarcRunPresentation(): HelarcRunPresentation {
  return {
    revision: 0,
    nextSequence: 1,
    omittedRecords: 0,
    retainedBytes: 0,
    records: [],
    activeCalls: [],
    omittedActiveCalls: 0,
    labels: [],
    plans: {},
    sourceSequences: {},
  };
}

const encoder = new TextEncoder();
export function boundedPresentationText(
  text: string,
  maximum = 256 * 1024,
): { text: string; omittedBytes: number } {
  const bytes = encoder.encode(text);
  if (bytes.length <= maximum) return { text, omittedBytes: 0 };
  let end = maximum;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
  return {
    text: new TextDecoder().decode(bytes.subarray(0, end)),
    omittedBytes: bytes.length - end,
  };
}

// This is a bounded display copy, never a model-context or authority projection.
export function projectHelarcPresentationValue(
  value: unknown,
  budget = 32 * 1024,
): HelarcPresentationValue {
  let remaining = budget;
  function visit(input: unknown, depth: number): HelarcPresentationValue {
    if (remaining <= 0 || depth > 8) return "[omitted: display limit]";
    remaining -= 16;
    if (input === null || typeof input === "boolean") return input;
    if (typeof input === "number") return Number.isFinite(input) ? input : null;
    if (typeof input === "string") {
      const bounded = boundedPresentationText(input, Math.max(0, remaining));
      remaining -= encoder.encode(bounded.text).length;
      return (
        bounded.text +
        (bounded.omittedBytes
          ? `\n[${bounded.omittedBytes} bytes omitted]`
          : "")
      );
    }
    if (Array.isArray(input)) {
      const result: HelarcPresentationValue[] = [];
      for (const entry of input) {
        if (remaining <= 0) {
          result.push("[omitted: display limit]");
          break;
        }
        result.push(visit(entry, depth + 1));
      }
      return result;
    }
    if (typeof input === "object" && input !== null) {
      const result: Record<string, HelarcPresentationValue> = {};
      for (const [key, entry] of Object.entries(input)) {
        if (remaining <= 0) {
          result.omitted = "display limit";
          break;
        }
        if (
          /^(authorization|credential|credentials|apiKey|accessToken|refreshToken|password|secret|headers|environment)$/i.test(
            key,
          )
        )
          continue;
        if (key === "__proto__" || key === "constructor" || key === "prototype")
          continue;
        const keyBytes = encoder.encode(key).length;
        if (keyBytes > remaining) {
          result.omitted = "display limit";
          break;
        }
        remaining -= keyBytes;
        result[key] = visit(entry, depth + 1);
      }
      return result;
    }
    return null;
  }
  return visit(value, 0);
}

export function labelHelarcRunPresentation(
  current: HelarcRunPresentation,
  runId: string,
  lineage: RunLineage,
  rootObjective: string,
): HelarcRunPresentation {
  const parentRunId = lineage.kind === "descendant" ? lineage.parent.id : null;
  const parentRunActionId =
    lineage.kind === "descendant" ? lineage.parentRunAction.id : null;
  const call = [...current.activeCalls, ...current.records].find(
    (record) =>
      record.runId === parentRunId &&
      record.content.kind === "tool_call" &&
      record.content.runActionId === parentRunActionId,
  )?.content;
  const input =
    call?.kind === "tool_call" &&
    typeof call.input === "object" &&
    call.input !== null &&
    !Array.isArray(call.input)
      ? (call.input as Record<string, HelarcPresentationValue>)
      : {};
  const objective =
    parentRunId === null
      ? rootObjective
      : typeof input.prompt === "string"
        ? input.prompt
        : null;
  const label =
    parentRunId === null
      ? "Root"
      : typeof input.description === "string"
        ? input.description
        : "Delegated work";
  const entry = {
    runId,
    parentRunId,
    parentRunActionId,
    label: label.slice(0, 160),
    objective: objective?.slice(0, 512) ?? null,
  };
  const previous = current.labels.find((item) => item.runId === runId);
  if (previous && JSON.stringify(previous) === JSON.stringify(entry))
    return current;
  return {
    ...current,
    revision: current.revision + 1,
    labels: [...current.labels.filter((item) => item.runId !== runId), entry],
  };
}

export function appendHelarcRunPresentation(
  current: HelarcRunPresentation,
  record: RunTranscriptRecord,
): HelarcRunPresentation {
  if ((current.sourceSequences[record.runId] ?? 0) >= record.sequence)
    return current;
  const item = record.item;
  const payload = item.payload;
  let records = [...current.records];
  let activeCalls = [...current.activeCalls];
  let omittedActiveCalls = current.omittedActiveCalls;
  let nextSequence = current.nextSequence;
  let plans = current.plans;
  const source = {
    owner: "runtime" as const,
    kind: "run_item" as const,
    id: item.ref.id,
    sequence: record.sequence,
  };
  const add = (id: string, content: HelarcRunPresentationRecord["content"]) => {
    const entry: HelarcRunPresentationRecord = {
      id,
      runId: record.runId,
      sequence: nextSequence++,
      revision: item.committedInRevision,
      observedAt: item.createdAt,
      source,
      content,
    };
    records.push(entry);
    if (content.kind === "tool_call") activeCalls.push({...entry, content:{...content,
      input:projectHelarcPresentationValue(content.input, 1024)}});
  };
  if (payload.kind === "controller_turn") {
    for (const model of payload.modelItems) {
      if (model.kind === "assistant_text")
        add(model.id, {
          kind: "assistant_text",
          turnId: model.turnId,
          modelItemId: model.id,
          ordinal: model.contentBlockOrdinal,
          ...boundedPresentationText(model.text),
        });
      if (model.kind === "model_tool_call")
        add(model.id, {
          kind: "tool_call",
          callId: model.call.modelCallRef.id,
          turnId: model.call.modelCallRef.turnId,
          name: model.call.name,
          input: projectHelarcPresentationValue(model.call.input),
          runActionId: null,
          invocationId: null,
          settlement: null,
          result: null,
        });
    }
  } else if (
    payload.kind === "run_action" ||
    payload.kind === "model_call_settlement"
  ) {
    const callId =
      payload.kind === "model_call_settlement"
        ? payload.result.modelCallRef.id
        : payload.action.provenance.kind === "controller"
          ? payload.action.provenance.modelCallRef.id
          : null;
    const updateCall = (entry: HelarcRunPresentationRecord): HelarcRunPresentationRecord => {
      if (
        entry.runId !== record.runId ||
        entry.content.kind !== "tool_call" ||
        entry.content.callId !== callId
      )
        return entry;
      return {
        ...entry,
        revision: item.committedInRevision,
        content: {
          ...entry.content,
          ...(payload.kind === "run_action"
            ? {
                runActionId: payload.action.ref.id,
                invocationId:
                  payload.action.subject.kind === "operation"
                    ? payload.action.subject.invocationId
                    : null,
              }
            : {
                settlement: payload.result.settlement,
                result: projectHelarcPresentationValue(payload.result.content),
              }),
        },
      };
    };
    if (payload.kind === "model_call_settlement") {
      const active = activeCalls.find(entry => entry.runId === record.runId && entry.content.kind === "tool_call" && entry.content.callId === callId);
      if (active && !records.some(entry => entry.id === active.id && entry.runId === active.runId)) records.push(active);
    }
    records = records.map(updateCall).sort((a,b) => a.sequence-b.sequence);
    activeCalls = activeCalls.map(updateCall).filter(entry => entry.content.kind === "tool_call" && entry.content.settlement === null);
  } else if (
    payload.kind === "state_transition" &&
    payload.transition === "plan"
  ) {
    const plan = projectHelarcPresentationValue(payload.plan);
    plans = { ...plans, [record.runId]: plan };
    add(item.ref.id, { kind: "plan_update", plan });
  } else if (payload.kind === "state_transition" && payload.transition === "steering") {
    const command = payload.steering.command;
    const text = boundedPresentationText(command.instruction);
    add(item.ref.id, {kind:"steering", commandId:command.commandId, instruction:text.text,
      omittedBytes:text.omittedBytes, origin:command.attribution.origin, disposition:payload.steering.status});
  } else if (payload.kind === "pending_transition" || payload.kind === "retry_transition") {
    add(item.ref.id, {
      kind: "interaction",
      title: `${payload.pending.kind}: ${payload.transition}`,
      detail: projectHelarcPresentationValue({
        kind: payload.pending.kind,
        transition: payload.transition,
        recordRef: payload.kind === "pending_transition" ? payload.recordRef : null,
      }),
    });
  } else if (
    payload.kind === "terminal_transition" ||
    payload.kind === "settlement_cause"
  ) {
    const cause = payload.cause;
    add(item.ref.id, {
      kind: "lifecycle",
      title: payload.kind.replaceAll("_", " "),
      detail: projectHelarcPresentationValue({
        kind: cause.kind,
        code:
          cause.kind === "failure" ? cause.failure.failure.code : cause.code,
        source: cause.source,
        underlying: cause.underlying,
        recordedAt: cause.recordedAt,
        ...(payload.kind === "terminal_transition"
          ? {
              status: payload.status,
              completedAt: payload.settlement.completedAt,
            }
          : {}),
      }),
    });
  } else if (
    [
      "suspension_transition",
      "cancellation_transition",
      "controller_feedback",
      "completion_acceptance",
    ].includes(payload.kind)
  ) {
    add(item.ref.id, {
      kind: "lifecycle",
      title: payload.kind.replaceAll("_", " "),
      detail: projectHelarcPresentationValue(payload),
    });
  }
  let retainedBytes = records.reduce(
    (total, entry) => total + encoder.encode(JSON.stringify(entry)).length,
    0,
  );
  let omittedRecords = current.omittedRecords;
  while (records.length > 2048 || retainedBytes > 4 * 1024 * 1024) {
    const settled = records.findIndex(
      (entry) =>
        entry.content.kind !== "tool_call" || entry.content.settlement !== null,
    );
    const [removed] = records.splice(settled < 0 ? 0 : settled, 1);
    retainedBytes -= encoder.encode(JSON.stringify(removed)).length;
    omittedRecords++;
  }
  let activeBytes = activeCalls.reduce((n, entry) => n + encoder.encode(JSON.stringify(entry)).length, 0);
  while (activeCalls.length > 2048 || activeBytes > 4 * 1024 * 1024) {
    activeBytes -= encoder.encode(JSON.stringify(activeCalls.shift())).length;
    omittedActiveCalls++;
  }
  return {
    ...current,
    revision: current.revision + 1,
    nextSequence,
    records,
    activeCalls,
    omittedActiveCalls,
    plans,
    retainedBytes,
    omittedRecords,
    sourceSequences: {
      ...current.sourceSequences,
      [record.runId]: record.sequence,
    },
  };
}
