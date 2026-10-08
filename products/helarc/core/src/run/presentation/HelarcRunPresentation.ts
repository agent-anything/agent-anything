import type { RunTranscriptRecord } from "@agent-anything/agent-runtime/transcript";
import type { RunLineage } from "@agent-anything/agent-core/run-tree";
import type { ToolBindingRef } from "@agent-anything/tools/identity";
import type { RuntimeEvent } from "@agent-anything/observability";
import type { RunInput } from "@agent-anything/agent-core/input";

export type HelarcOutputSource =
  | { readonly kind: "model_control"; readonly turnId: string; readonly modelItemId: string;
      readonly modelCallRef: import("@agent-anything/model-interaction").ModelCallRef;
      readonly control: "final_result"; readonly argumentPath: "/response" }
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

export interface HelarcModelItemOrigin {
  readonly runId: string;
  readonly turnId: string;
  readonly turnSequence: number;
  readonly modelItemId: string;
  readonly ordinal: number | null;
  readonly callId: string | null;
  readonly source: { readonly id: string; readonly sequence: number };
}

export interface HelarcRunPresentationRecord {
  readonly id: string;
  readonly runId: string;
  readonly sequence: number;
  readonly revision: number;
  readonly observedAt: string;
  readonly origin: HelarcModelItemOrigin | null;
  readonly source: {
    readonly owner: "runtime";
    readonly kind: "run_item" | "run_input";
    readonly id: string;
    readonly sequence: number;
  };
  readonly content:
    | { readonly kind: "assistant_reasoning"; readonly turnId: string; readonly modelItemId: string; readonly text: string; readonly omittedBytes: number }
    | { readonly kind: "received_input"; readonly inputKind: "task" | "message" | "agent_result";
        readonly text: string; readonly omittedBytes: number; readonly senderRunId: string | null;
        readonly disposition: string | null }
    | {
        readonly kind: "assistant_text";
        readonly turnId: string;
        readonly modelItemId: string;
        readonly ordinal: number;
        readonly text: string;
        readonly omittedBytes: number;
      }
    | { readonly kind: "final_response"; readonly turnId: string; readonly modelItemId: string;
        readonly callId: string; readonly text: string; readonly omittedBytes: number;
        readonly disposition: "proposed" | "accepted" | "declined" | "completed" | "failed" | "cancelled" }
    | {
        readonly kind: "tool_call";
        readonly callId: string;
        readonly turnId: string;
        readonly name: string;
        readonly callableKind: "tool" | "control" | "unresolved";
        readonly resolvedName: string | null;
        readonly toolBindingKind: ToolBindingRef["kind"] | null;
        readonly interactionProtocol: { readonly owner: string; readonly kind: string; readonly revision: string } | null;
        readonly input: HelarcPresentationValue;
        readonly runActionId: string | null;
        readonly invocationId: string | null;
        readonly invocationIds: readonly string[];
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
  readonly parentOrigin: HelarcModelItemOrigin | null;
  readonly siblingOrdinal: number | null;
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

function resolvedCallable(value: unknown): Pick<
  Extract<HelarcRunPresentationRecord["content"], { kind: "tool_call" }>,
  "callableKind" | "resolvedName" | "toolBindingKind" | "interactionProtocol"
> {
  const empty = { toolBindingKind: null, interactionProtocol: null };
  const unresolved = { ...empty, callableKind: "unresolved" as const, resolvedName: null };
  if (!value || typeof value !== "object") return unresolved;
  const binding = value as Record<string, unknown>;
  if (binding.kind === "tool" && typeof binding.toolName === "string" && binding.toolName) {
    const tool = binding.binding as ToolBindingRef | undefined;
    const kind = tool && ["operation", "interaction", "descendant_agent", "descendant_message"].includes(tool.kind)
      ? tool.kind : null;
    const protocol = tool?.kind === "interaction" ? tool.protocol : null;
    return { callableKind: "tool", resolvedName: binding.toolName, toolBindingKind: kind,
      interactionProtocol: protocol && [protocol.owner, protocol.kind, protocol.revision].every(v => typeof v === "string" && v.length > 0)
        ? { owner: protocol.owner, kind: protocol.kind, revision: protocol.revision } : null };
  }
  if (binding.kind === "control" && typeof binding.control === "string" && binding.control)
    return { ...empty, callableKind: "control", resolvedName: binding.control };
  return unresolved;
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
  const callRecord = [...current.activeCalls, ...current.records].find(
    (record) =>
      record.runId === parentRunId &&
      record.content.kind === "tool_call" &&
      record.content.runActionId === parentRunActionId,
  );
  const call = callRecord?.content;
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
  const previous = current.labels.find((item) => item.runId === runId);
  const entry = {
    runId,
    parentRunId,
    parentRunActionId,
    parentOrigin: callRecord?.origin ?? previous?.parentOrigin ?? null,
    siblingOrdinal: previous?.siblingOrdinal ?? (parentRunId === null ? null :
      current.labels.filter(item => item.parentRunId === parentRunId)
        .reduce((maximum, item) => Math.max(maximum, item.siblingOrdinal ?? 0), 0) + 1),
    label: label.slice(0, 160),
    objective: objective?.slice(0, 512) ?? null,
  };
  if (previous && JSON.stringify(previous) === JSON.stringify(entry))
    return current;
  return {
    ...current,
    revision: current.revision + 1,
    labels: [...current.labels.filter((item) => item.runId !== runId), entry],
  };
}

export function helarcSubtaskName(labels: readonly HelarcRunLabel[], runId: string): string {
  const byId = new Map(labels.map(label => [label.runId, label]));
  const visited = new Set<string>();
  const path: number[] = [];
  let current = byId.get(runId);
  while (current && !visited.has(current.runId)) {
    visited.add(current.runId);
    if (current.parentRunId === null) return path.length ? `Subtask ${path.reverse().join(".")}` : "Main task";
    if (!Number.isSafeInteger(current.siblingOrdinal) || current.siblingOrdinal! < 1) break;
    path.push(current.siblingOrdinal!);
    current = byId.get(current.parentRunId);
  }
  return "Subtask";
}

/** Actual Run input, not the shortened label or a reconstructed Provider request. */
export function receiveHelarcRunInputPresentation(
  current: HelarcRunPresentation, runId: string, input: RunInput, receivedAt: string,
): HelarcRunPresentation {
  const label = current.labels.find(label => label.runId === runId);
  if (!label?.parentRunId) return current;
  const id = `${runId}:received-task`;
  if (current.records.some(record => record.id === id && record.runId === runId)) return current;
  const task = input.task.input as { prompt?: unknown } | null;
  if (typeof task?.prompt !== "string") return current;
  let sequence = current.nextSequence;
  const records: HelarcRunPresentationRecord[] = [];
  const add = (id: string, text: string, inputKind: "task" | "message", source: HelarcRunPresentationRecord["source"]) => {
    records.push({id, runId, sequence: sequence++, revision: 0, observedAt: receivedAt, origin: null, source,
      content: {kind: "received_input", inputKind, ...boundedPresentationText(text), senderRunId: label.parentRunId, disposition: null}});
  };
  const source = {owner: "runtime" as const, kind: "run_input" as const, id: `${runId}:input`, sequence: 0};
  add(id, task.prompt, "task", source);
  for (const item of input.items) {
    // The delegation objective is already represented by the task text.
    if (item.role === "user" && !(item.metadata.source === "delegation_objective" && item.content === task.prompt)) {
      add(`${runId}:received-input:${item.id}`, item.content, "message", source);
    }
  }
  // A continuation preserves its original task and adds the accepted Parent message.
  // Resolve the creation action, not a latest-call/name/time heuristic.
  const creation = current.records.find(record => record.runId === label.parentRunId &&
    record.content.kind === "tool_call" && record.content.runActionId === label.parentRunActionId);
  if (creation?.content.kind === "tool_call" && creation.content.toolBindingKind === "descendant_message") {
    const value = creation.content.input;
    if (value && typeof value === "object" && !Array.isArray(value) && "prompt" in value && typeof value.prompt === "string") {
      add(`${runId}:received-continuation`, value.prompt, "message", creation.source);
    }
  }
  return retainPresentation({...current, revision: current.revision + 1, nextSequence: sequence,
    records: [...current.records, ...records]});
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
  const add = (id: string, content: HelarcRunPresentationRecord["content"], origin: HelarcModelItemOrigin | null = null) => {
    const entry: HelarcRunPresentationRecord = {
      id,
      runId: record.runId,
      sequence: nextSequence++,
      revision: item.committedInRevision,
      observedAt: item.createdAt,
      origin,
      source,
      content,
    };
    records.push(entry);
    if (content.kind === "tool_call") activeCalls.push({...entry, content:{...content,
      input:projectHelarcPresentationValue(content.input, 1024)}});
  };
  if (payload.kind === "controller_turn") {
    const turns = new Map<string, number>();
    for (const model of payload.modelItems) {
      if (model.kind === "assistant_reasoning") {
        if (!turns.has(model.turnId)) turns.set(model.turnId, nextSequence);
        add(model.id, { kind: "assistant_reasoning", turnId: model.turnId, modelItemId: model.id,
          ...boundedPresentationText(model.reasoning.text) }, {
          runId: record.runId, turnId: model.turnId, turnSequence: turns.get(model.turnId)!, modelItemId: model.id,
          ordinal: null, callId: null, source: { id: source.id, sequence: source.sequence },
        });
        continue;
      }
      if (model.kind !== "assistant_text" && model.kind !== "model_tool_call") continue;
      const turnId = model.kind === "assistant_text" ? model.turnId : model.call.modelCallRef.turnId;
      if (!turns.has(turnId)) turns.set(turnId, nextSequence);
      const origin: HelarcModelItemOrigin = {
        runId: record.runId, turnId, turnSequence: turns.get(turnId)!, modelItemId: model.id,
        ordinal: model.kind === "assistant_text" ? model.contentBlockOrdinal : model.call.modelCallRef.contentBlockOrdinal,
        callId: model.kind === "model_tool_call" ? model.call.modelCallRef.id : null,
        source: { id: source.id, sequence: source.sequence },
      };
      if (model.kind === "assistant_text")
        add(model.id, {
          kind: "assistant_text",
          turnId: model.turnId,
          modelItemId: model.id,
          ordinal: model.contentBlockOrdinal,
          ...boundedPresentationText(model.text),
        }, origin);
      if (model.kind === "model_tool_call") {
        const binding = resolvedCallable(model.metadata?.helarcCallableBinding);
        if (binding.callableKind === "control" && binding.resolvedName === "final_result" && typeof model.call.input.response === "string") {
          add(model.id, {kind: "final_response", turnId: model.call.modelCallRef.turnId, modelItemId: model.id,
            callId: model.call.modelCallRef.id, ...boundedPresentationText(model.call.input.response), disposition: "proposed"}, origin);
          continue;
        }
        add(model.id, {
          kind: "tool_call",
          callId: model.call.modelCallRef.id,
          turnId: model.call.modelCallRef.turnId,
          name: model.call.name,
          ...resolvedCallable(model.metadata?.helarcCallableBinding),
          input: projectHelarcPresentationValue(model.call.input,
            binding.toolBindingKind === "descendant_message" ? 256 * 1024 : undefined),
          runActionId: null,
          invocationId: null,
          invocationIds: [],
          settlement: null,
          result: null,
        }, origin);
      }
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
      if (payload.kind === "model_call_settlement" && entry.runId === record.runId && entry.content.kind === "final_response" && entry.content.callId === callId) {
        return {...entry, revision: item.committedInRevision, content: {...entry.content,
          disposition: payload.result.settlement === "succeeded" ? "accepted" : payload.result.settlement === "cancelled" ? "cancelled" : "declined"}};
      }
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
                invocationIds: payload.action.subject.kind === "operation" && payload.action.subject.invocationId
                  ? [...new Set([...entry.content.invocationIds, payload.action.subject.invocationId])]
                  : entry.content.invocationIds,
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
  } else if (payload.kind === "observation" && payload.observation.payload.kind === "descendant_result_transfer") {
    const result = payload.observation.payload;
    const output = result.output as {summary?: unknown} | null;
    add(item.ref.id, {kind: "received_input", inputKind: "agent_result",
      ...boundedPresentationText(typeof output?.summary === "string" ? output.summary : ""),
      senderRunId: result.childRunId, disposition: result.status});
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
    if (payload.kind === "terminal_transition") records = records.map(entry => entry.runId === record.runId && entry.content.kind === "final_response" &&
      (entry.content.disposition === "proposed" || entry.content.disposition === "accepted")
      ? {...entry, revision: item.committedInRevision, content: {...entry.content,
          disposition: payload.status === "completed" && entry.content.disposition === "accepted" ? "completed" : payload.status === "cancelled" ? "cancelled" : "failed"}}
      : entry);
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
  const labels = current.labels.map(label => {
    if (label.parentOrigin || !label.parentRunId || !label.parentRunActionId) return label;
    const call = [...activeCalls, ...records].find(entry => entry.runId === label.parentRunId && entry.content.kind === "tool_call" &&
      entry.content.runActionId === label.parentRunActionId);
    return call?.origin ? { ...label, parentOrigin: call.origin } : label;
  });
  return retainPresentation({
    ...current, revision: current.revision + 1, nextSequence, records, activeCalls,
    omittedActiveCalls, plans, labels,
    sourceSequences: {...current.sourceSequences, [record.runId]: record.sequence},
  });
}

export function associateHelarcOperationPresentation(current: HelarcRunPresentation,
  event: RuntimeEvent<"operation.started">): HelarcRunPresentation {
  const {invocationId, parentInvocationId, parentRunActionId} = event.payload;
  let changed = false;
  const associate = (entry: HelarcRunPresentationRecord): HelarcRunPresentationRecord => {
    const c = entry.content;
    if (entry.runId !== event.runId || c.kind !== "tool_call" || c.invocationIds.includes(invocationId)) return entry;
    const matched = parentInvocationId === null ? c.runActionId === parentRunActionId : c.invocationIds.includes(parentInvocationId);
    if (!matched) return entry;
    changed = true;
    return {...entry, content: {...c, invocationId: c.invocationId ?? (parentInvocationId === null ? invocationId : null),
      invocationIds: [...c.invocationIds, invocationId]}};
  };
  const records = current.records.map(associate), activeCalls = current.activeCalls.map(associate);
  return changed ? retainPresentation({...current, revision: current.revision + 1, records, activeCalls}) : current;
}

function retainPresentation(current: HelarcRunPresentation): HelarcRunPresentation {
  const records = [...current.records], activeCalls = [...current.activeCalls];
  let omittedActiveCalls = current.omittedActiveCalls;
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
    records,
    activeCalls,
    omittedActiveCalls,
    retainedBytes,
    omittedRecords,
  };
}
