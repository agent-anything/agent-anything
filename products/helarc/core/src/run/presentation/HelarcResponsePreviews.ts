import type { ControllerResponseObservation } from "@agent-anything/agent-runtime/controller";
import type { RunTranscriptRecord } from "@agent-anything/agent-runtime/transcript";
import { boundedPresentationText } from "./HelarcRunPresentation.js";

export interface HelarcResponsePreviewPart {
  readonly id: string;
  readonly kind: "text" | "tool_call";
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
  private readonly listeners = new Set<
    (value: HelarcResponsePreviews, attempt: HelarcResponsePreview) => void
  >();
  constructor(
    private readonly checkpoint: (value: HelarcResponsePreviews) => void,
  ) {}
  snapshot(): HelarcResponsePreviews {
    return this.state;
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
      };
    } else {
      const previous = old.parts.find((p) => p.id === progress.partId);
      if (!previous && old.parts.length >= 257) return;
      let part: HelarcResponsePreviewPart = previous ?? {
        id: progress.partId,
        kind: progress.kind === "text_delta" ? "text" : "tool_call",
        text: "",
        receivedLength: 0,
        omittedBytes: 0,
        name: null,
        modelItemId: null,
        turnId: null,
        committedRecordId: null,
      };
      if (progress.kind === "text_delta") {
        if (part.kind !== "text" || progress.offset !== part.receivedLength)
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
        if (part.kind !== "tool_call") return;
        // Argument fragments are not executable inputs and are not retained twice.
        part = {
          ...part,
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
      const parts = attempt.parts.map((part) =>
        part.modelItemId !== null &&
        items.some((item) => item.id === part.modelItemId)
          ? { ...part, committedRecordId: part.modelItemId }
          : part,
      );
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
    this.flush();
  }
  private update(value: HelarcResponsePreview, flush: boolean): void {
    const revision = this.state.revision + 1;
    const attempt = Object.freeze({
      ...value,
      revision,
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
