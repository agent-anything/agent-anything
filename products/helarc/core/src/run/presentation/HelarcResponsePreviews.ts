import type { ControllerResponseObservation } from "@agent-anything/agent-runtime/controller";
import type { RunTranscriptRecord } from "@agent-anything/agent-runtime/transcript";
import { boundedPresentationText } from "./HelarcRunPresentation.js";
import { HelarcFinalResponsePreview } from "./HelarcFinalResponsePreview.js";
import type { HelarcModelCallableCatalog } from "../../controller/HelarcModelCallableCatalog.js";

export interface HelarcResponsePreviewPart {
  readonly id: string;
  readonly kind: "text" | "tool_call" | "final_response" | "reasoning";
  readonly text: string;
  readonly receivedLength: number;
  readonly omittedBytes: number;
  readonly name: string | null;
  readonly modelItemId: string | null;
  readonly turnId: string | null;
  readonly committedRecordId: string | null;
}
export interface HelarcResponsePreview {
  readonly runId: string;
  readonly requestId: string;
  readonly controllerRequestId: string;
  readonly invocationId: string;
  readonly revision: number;
  readonly observedAt: string;
  readonly deliverySequence: number;
  readonly mode: "buffered" | "streaming";
  readonly state:
    | "receiving"
    | "received"
    | "validated"
    | "committed"
    | "interrupted"
    | "cancelled"
    | "failed"
    | "rejected";
  readonly code: string | null;
  readonly parts: readonly HelarcResponsePreviewPart[];
}
export interface HelarcResponsePreviews {
  readonly revision: number;
  readonly omittedAttempts: number;
  readonly retainedBytes: number;
  readonly attempts: readonly HelarcResponsePreview[];
}
export function createHelarcResponsePreviews(): HelarcResponsePreviews {
  return { revision: 0, omittedAttempts: 0, retainedBytes: 0, attempts: [] };
}

/** Display-only state. Checkpoints share the Product writer, never model history. */
export class HelarcResponsePreviewStore {
  private state = createHelarcResponsePreviews();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;
  private closed = false;
  private readonly finalBindings = new Map<string, ReadonlySet<string>>();
  private readonly parsers = new Map<string, HelarcFinalResponsePreview>();
  private readonly listeners = new Set<
    (value: HelarcResponsePreviews, attempt: HelarcResponsePreview) => void
  >();
  constructor(
    private readonly checkpoint: (value: HelarcResponsePreviews) => void,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}
  snapshot(): HelarcResponsePreviews {
    return this.state;
  }
  bindRequest(runId: string, requestId: string, catalog: HelarcModelCallableCatalog): void {
    this.finalBindings.set(JSON.stringify([runId, requestId]), new Set(catalog.bindings.flatMap(binding =>
      binding.kind === "control" && binding.control === "final_result" ? [binding.callableName] : [])));
    while (this.finalBindings.size > 256) this.finalBindings.delete(this.finalBindings.keys().next().value!);
  }
  subscribe(
    listener: (
      value: HelarcResponsePreviews,
      attempt: HelarcResponsePreview,
    ) => void,
  ): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  observe(event: ControllerResponseObservation): void {
    if (this.closed) return;
    const e = event.kind === "delivery" ? event.progress : event;
    const old = this.state.attempts.find(
      (a) => a.invocationId === e.invocationId && a.runId === event.runId,
    );
    if (
      old &&
      (old.requestId !== e.requestId ||
        old.controllerRequestId !== e.controllerRequestId)
    )
      return;
    if (event.kind === "interpretation") {
      if (!old || old.state !== "received") return;
      this.update(
        {
          ...old,
          state: event.disposition,
          parts: old.parts.map((part) => {
            const mapping = event.parts.find((p) => p.partId === part.id);
            return mapping
              ? {
                  ...part,
                  modelItemId: mapping.modelItemId,
                  turnId: mapping.turnId,
                }
              : part;
          }),
        },
        event.disposition !== "validated",
      );
      return;
    }
    const progress = event.progress;
    if (
      old &&
      (progress.sequence <= old.deliverySequence || old.state !== "receiving")
    )
      return;
    if (progress.kind === "started") {
      if (
        old ||
        progress.controllerRequestId === null ||
        progress.mode !== "streaming"
      )
        return;
      this.update(
        {
          runId: event.runId,
          requestId: progress.requestId,
          controllerRequestId: progress.controllerRequestId,
          invocationId: progress.invocationId,
          revision: 0,
          observedAt: this.now(),
          deliverySequence: progress.sequence,
          mode: progress.mode,
          state: "receiving",
          code: null,
          parts: [],
        },
        false,
      );
      return;
    }
    if (!old) return;
    let next: HelarcResponsePreview = {
      ...old,
      deliverySequence: progress.sequence,
    };
    if (progress.kind === "settled") {
      next = {
        ...next,
        state:
          progress.disposition === "completed"
            ? "received"
            : progress.disposition === "continuation_rejected"
              ? "rejected"
              : progress.disposition,
        code: progress.code,
        parts: old.parts.map(part => part.kind === "reasoning" && progress.reasoning
          ? { ...part, turnId: progress.reasoning.turnId, modelItemId: `${progress.reasoning.turnId}:reasoning` } : part),
      };
    } else {
      const previous = old.parts.find((p) => p.id === progress.partId);
      if (!previous && old.parts.length >= 257) return;
      let part: HelarcResponsePreviewPart = previous ?? {
        id: progress.partId,
        kind: progress.kind === "text_delta" ? "text" : progress.kind === "reasoning_delta" ? "reasoning" : "tool_call",
        text: "",
        receivedLength: 0,
        omittedBytes: 0,
        name: null,
        modelItemId: null,
        turnId: null,
        committedRecordId: null,
      };
      if (progress.kind === "text_delta" || progress.kind === "reasoning_delta") {
        if (part.kind !== (progress.kind === "text_delta" ? "text" : "reasoning") || progress.offset !== part.receivedLength)
          return;
        const clipped = boundedPresentationText(
          progress.text,
          Math.max(0, 256 * 1024 - new TextEncoder().encode(part.text).length),
        );
        part = {
          ...part,
          text: part.text + clipped.text,
          receivedLength: part.receivedLength + progress.text.length,
          omittedBytes: part.omittedBytes + clipped.omittedBytes,
        };
      } else {
        if (part.kind === "text") return;
        const isFinal = this.finalBindings.get(JSON.stringify([event.runId, progress.requestId]))?.has(progress.name) === true;
        const parserKey = JSON.stringify([event.runId, progress.invocationId, progress.partId]);
        let decoded = {text: "", omittedBytes: 0};
        if (isFinal) {
          let parser = this.parsers.get(parserKey);
          if (!parser) { parser = new HelarcFinalResponsePreview(); this.parsers.set(parserKey, parser); }
          decoded = parser.write(progress.argumentsDelta);
        }
        // Argument fragments cannot dispatch work or become authoritative final output.
        part = {
          ...part,
          kind: isFinal ? "final_response" : "tool_call",
          ...decoded,
          name: progress.name.slice(0, 256),
          receivedLength: part.receivedLength + progress.argumentsDelta.length,
        };
      }
      next = {
        ...next,
        parts: previous
          ? old.parts.map((p) => (p.id === part.id ? part : p))
          : [...old.parts, part],
      };
    }
    this.update(
      next,
      progress.kind === "settled" && progress.disposition !== "completed",
    );
  }
  committed(record: RunTranscriptRecord): void {
    if (this.closed || record.item.payload.kind !== "controller_turn") return;
    const items = record.item.payload.modelItems;
    for (const attempt of [...this.state.attempts]) {
      if (attempt.runId !== record.runId || attempt.state !== "validated")
        continue;
      const parts = attempt.parts.map(part => {
        const item = items.find(item => item.id === part.modelItemId);
        if (!item) return part;
        if (part.kind === "final_response") {
          const binding = item.kind === "model_tool_call" ? item.metadata.helarcCallableBinding as {kind?: string; control?: string} | null : null;
          if (item.kind !== "model_tool_call" || binding?.kind !== "control" || binding.control !== "final_result" || typeof item.call.input.response !== "string")
            return {...part, text: "", committedRecordId: part.modelItemId};
          return {...part, ...boundedPresentationText(item.call.input.response), committedRecordId: part.modelItemId};
        }
        return {...part, committedRecordId: part.modelItemId};
      });
      if (!parts.some((part) => part.committedRecordId !== null)) continue;
      this.update(
        {
          ...attempt,
          parts,
          state: parts.every((part) => part.committedRecordId !== null)
            ? "committed"
            : "validated",
        },
        true,
      );
    }
  }
  close(): void {
    if (this.closed) return;
    for (const attempt of [...this.state.attempts]) {
      if (["receiving", "received", "validated"].includes(attempt.state))
        this.update(
          {
            ...attempt,
            state: "interrupted",
            code: attempt.code ?? "response_not_committed",
          },
          false,
        );
    }
    this.closed = true;
    this.parsers.clear();
    this.finalBindings.clear();
    this.flush();
  }
  private update(value: HelarcResponsePreview, flush: boolean): void {
    const revision = this.state.revision + 1;
    const attempt = Object.freeze({
      ...value,
      revision,
      observedAt: this.now(),
      parts: Object.freeze(value.parts.map((p) => Object.freeze(p))),
    });
    const attempts = [...this.state.attempts];
    const existing = attempts.findIndex(
      (a) =>
        a.invocationId === attempt.invocationId && a.runId === attempt.runId,
    );
    if (existing < 0) attempts.push(attempt);
    else attempts[existing] = attempt;
    let retainedBytes = attempts.reduce((n, a) => n + size(a), 0);
    let omittedAttempts = this.state.omittedAttempts;
    while (attempts.length > 256 || retainedBytes > 4 * 1024 * 1024) {
      const settled = attempts.findIndex(
        (a) => !["receiving", "received", "validated"].includes(a.state),
      );
      const removed = attempts.splice(settled < 0 ? 0 : settled, 1)[0]!;
      retainedBytes -= size(removed);
      omittedAttempts++;
    }
    this.state = Object.freeze({
      revision,
      retainedBytes,
      omittedAttempts,
      attempts: Object.freeze(attempts),
    });
    const retained = new Set(attempts.filter(attempt => attempt.state === "receiving").map(attempt => JSON.stringify([attempt.runId, attempt.invocationId])));
    for (const key of this.parsers.keys()) {
      const [runId, invocationId] = JSON.parse(key) as string[];
      if (!retained.has(JSON.stringify([runId, invocationId]))) this.parsers.delete(key);
    }
    this.dirty = true;
    for (const listener of this.listeners) {
      try {
        listener(this.state, attempt);
      } catch {
        /* Display subscribers cannot affect execution. */
      }
    }
    if (flush) this.flush();
    else this.timer ??= setTimeout(() => this.flush(), 1_000);
  }
  private flush(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    if (!this.dirty) return;
    this.dirty = false;
    this.checkpoint(this.state);
  }
}
function size(value: HelarcResponsePreview): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}
