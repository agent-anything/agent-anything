import { useEffect, useState } from "react";
import type {
  ResponsePreviewSummary,
  ResponseProgressFrame,
  WorkbenchScope,
} from "../../shared/HelarcWorkbench.js";

const MAX_CHARS = 512 * 1024;
export function mergePreview(
  previous: ResponsePreviewSummary | undefined,
  next: ResponsePreviewSummary,
): ResponsePreviewSummary {
  if (previous && previous.revision > next.revision) return previous;
  const parts = new Map(previous?.parts.map((p) => [p.id, p]));
  for (const part of next.parts) {
    const old = parts.get(part.id);
    const text =
      part.offset === 0
        ? part.text +
          (previous?.revision === next.revision && old
            ? old.text.slice(part.text.length)
            : "")
        : old && part.offset <= old.text.length
          ? old.text.slice(0, part.offset) +
            part.text +
            (previous?.revision === next.revision
              ? old.text.slice(part.offset + part.text.length)
              : "")
          : "";
    parts.set(part.id, { ...part, text, offset: 0 });
  }
  return { ...next, parts: [...parts.values()] };
}

export function useResponsePreview(
  scope: WorkbenchScope | null,
  live: boolean,
  revision: number,
) {
  const key = scope ? JSON.stringify(scope) : "";
  const [state, setState] = useState<{
    key: string;
    attempts: ResponsePreviewSummary[];
    omitted: number;
    error: string | null;
  }>({ key: "", attempts: [], omitted: 0, error: null });
  const [reload, setReload] = useState(0);
  useEffect(() => {
    if (!scope) return;
    let disposed = false,
      dispose: (() => void) | undefined,
      reading = false,
      again = false,
      sequence = 0;
    let attempts = new Map<string, ResponsePreviewSummary>(),
      omitted = 0;
    let buffered: ResponseProgressFrame[] = [];
    const publish = () => {
      if (disposed) return;
      const values = [...attempts.values()];
      let chars = values.reduce(
        (n, a) => n + a.parts.reduce((m, p) => m + p.text.length, 0),
        0,
      );
      while (values.length > 64 || chars > MAX_CHARS) {
        const index = values.findIndex(
          (a) => !["receiving", "received", "validated"].includes(a.state),
        );
        const removed = values.splice(index < 0 ? 0 : index, 1)[0];
        if (!removed) break;
        chars -= removed.parts.reduce((n, p) => n + p.text.length, 0);
        attempts.delete(removed.invocationId);
        omitted++;
      }
      setState({ key, attempts: values, omitted, error: null });
    };
    const apply = (frame: ResponseProgressFrame) => {
      if (frame.attempt.runId !== scope.runId) return;
      attempts.set(
        frame.attempt.invocationId,
        mergePreview(attempts.get(frame.attempt.invocationId), frame.attempt),
      );
    };
    async function resync() {
      if (reading) {
        again = true;
        return;
      }
      reading = true;
      try {
        const fresh = new Map<string, ResponsePreviewSummary>();
        let cursor: string | null = null,
          pages = 0;
        do {
          const page = await window.helarc.readResponsePreview({
            ...scope!,
            invocationId: null,
            cursor,
          });
          if (disposed) return;
          if (page.status !== "page") throw Error(page.code);
          omitted = page.omittedAttempts;
          for (const attempt of page.attempts)
            fresh.set(
              attempt.invocationId,
              mergePreview(fresh.get(attempt.invocationId), attempt),
            );
          cursor = page.nextCursor;
        } while (cursor && ++pages < 128);
        if (cursor) omitted++;
        attempts = fresh;
        for (const frame of buffered) apply(frame);
        buffered = [];
        publish();
      } catch {
        if (!disposed)
          setState((s) => ({
            ...(s.key === key ? s : { attempts: [], omitted: 0 }),
            key,
            error: "Response preview unavailable.",
          }));
      } finally {
        reading = false;
        if (again && !disposed) {
          again = false;
          void resync();
        }
      }
    }
    async function start() {
      if (live) {
        try {
          const result = await window.helarc.subscribeResponseProgress(
            scope!,
            (frame) => {
              if (disposed) return;
              const gap = sequence !== 0 && frame.sequence !== sequence + 1;
              sequence = frame.sequence;
              if (reading) {
                buffered.push(frame);
                if (buffered.length > 256) {
                  buffered = [];
                  again = true;
                }
              } else {
                apply(frame);
                publish();
              }
              if (gap || frame.resyncRequired) void resync();
            },
          );
          if (result.status === "subscribed") {
            if (disposed) {
              result.dispose();
              return;
            }
            dispose = result.dispose;
          }
        } catch {
          /* The snapshot read remains available after a subscription failure. */
        }
      }
      if (!disposed) await resync();
    }
    void start();
    return () => {
      disposed = true;
      dispose?.();
    };
  }, [key, live, reload]);
  // Persisted settlement and reopened history may not have a live subscription.
  useEffect(() => {
    if (!live) setReload((v) => v + 1);
  }, [revision, live]);
  return {
    ...(state.key === key ? state : { attempts: [], omitted: 0, error: null }),
    refresh: () => setReload((v) => v + 1),
  };
}
