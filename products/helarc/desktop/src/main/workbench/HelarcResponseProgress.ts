import type {
  HelarcResponsePreview,
  HelarcResponsePreviews,
} from "@agent-anything/helarc/run";
import type {
  ResponseProgressFrame,
  ResponsePreviewPart,
  WorkScope,
} from "../../shared/HelarcWorkbench.js";
import { fitsPage, textPage } from "./WorkbenchReadLimits.js";

/** Bounded publication interest. Disposal never cancels execution or clears Product previews. */
export class HelarcResponseProgress {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly pending = new Map<
    string,
    { revision: number; attempt: HelarcResponsePreview }
  >();
  private readonly positions = new Map<string, number>();
  private sequence = 0;
  private omitted = false;
  private omittedAttempts = 0;
  private disposed = false;
  constructor(
    private readonly subscriptionId: string,
    private readonly scope: WorkScope,
    private readonly send: (frame: ResponseProgressFrame) => void,
  ) {}
  observe(state: HelarcResponsePreviews, attempt: HelarcResponsePreview): void {
    if (this.disposed) return;
    const key = JSON.stringify([attempt.runId, attempt.invocationId]);
    if (state.omittedAttempts !== this.omittedAttempts) {
      this.omitted = true;
      this.omittedAttempts = state.omittedAttempts;
    }
    if (!this.pending.has(key) && this.pending.size >= 256) {
      this.pending.delete(this.pending.keys().next().value!);
      this.omitted = true;
    }
    this.pending.set(key, { revision: state.revision, attempt });
    if (attempt.state !== "receiving" || attempt.deliverySequence === 1)
      this.flush();
    else this.timer ??= setTimeout(() => this.flush(), 50);
  }
  dispose(): void {
    this.disposed = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.pending.clear();
    this.positions.clear();
  }
  private flush(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    for (const [key, { revision, attempt }] of this.pending) {
      this.pending.delete(key);
      let resyncRequired = this.omitted;
      const parts: ResponsePreviewPart[] = [];
      const { parts: _parts, ...metadata } = attempt;
      const frame: ResponseProgressFrame = {
        subscriptionId: this.subscriptionId,
        scope: this.scope,
        sequence: ++this.sequence,
        previewRevision: revision,
        attempt: { ...metadata, parts },
        resyncRequired: false,
      };
      for (const part of attempt.parts) {
        const positionKey = JSON.stringify([key, part.id]);
        const offset = this.positions.get(positionKey) ?? 0;
        const segment = textPage(
          part.text,
          Math.min(offset, part.text.length),
          4096,
        );
        const projected = {
          ...part,
          text: segment.text,
          offset,
          nextOffset: segment.end < part.text.length ? segment.end : null,
        };
        if (
          !fitsPage(
            {
              ...frame,
              attempt: { ...metadata, parts: [...parts, projected] },
            },
            60 * 1024,
          )
        ) {
          resyncRequired = true;
          break;
        }
        parts.push(projected);
        this.positions.set(positionKey, segment.end);
        if (projected.nextOffset !== null) resyncRequired = true;
      }
      // Bound per-subscriber bookkeeping even across long retained sessions.
      while (this.positions.size > 2048)
        this.positions.delete(this.positions.keys().next().value!);
      try {
        if (fitsPage({ ...frame, resyncRequired }, 64 * 1024))
          this.send({ ...frame, resyncRequired });
      } catch {
        /* View closure is observational. */
      }
    }
    this.omitted = false;
  }
}
