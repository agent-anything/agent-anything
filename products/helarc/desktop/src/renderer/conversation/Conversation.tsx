import * as React from "react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowDown, MoreHorizontal } from "lucide-react";
import type { HelarcMainSnapshot } from "../../shared/HelarcDesktopApi.js";
import type {
  ConversationEntry,
  ConversationPage,
  WorkbenchScope,
} from "../../shared/HelarcWorkbench.js";
import { CopyButton, MarkdownContent } from "./MarkdownContent.js";
import { useResponsePreview } from "./useResponsePreview.js";
import { ResultLinks } from "../work/ResultContent.js";

export function Conversation({
  snapshot,
  scope,
  onInspect,
  visible,
}: {
  snapshot: HelarcMainSnapshot;
  scope: WorkbenchScope | null;
  onInspect: (scope: WorkbenchScope) => void;
  visible: boolean;
}) {
  const threadId = snapshot.activeThread?.id ?? "";
  const viewport = useRef<HTMLDivElement>(null),
    content = useRef<HTMLDivElement>(null);
  const following = useRef(true),
    generation = useRef(0),
    reading = useRef(false);
  const anchor = useRef<{ id: string; offset: number } | null>(null);
  const [page, setPage] = useState<ConversationPage | null>(null),
    [error, setError] = useState<string | null>(null);
  const [newContent, setNewContent] = useState(false),
    [busy, setBusy] = useState(false);
  const live =
    !!snapshot.run &&
    !snapshot.run.display.terminal &&
    snapshot.run.productRunId === scope?.productRunId;
  const previews = useResponsePreview(
    scope,
    live,
    snapshot.activeThread?.revision ?? 0,
  );
  const commitKey = previews.attempts
    .filter((a) => a.state === "committed")
    .map((a) => `${a.invocationId}:${a.revision}`)
    .join("|");
  function saveAnchor() {
    const node = viewport.current;
    if (!node || following.current) {
      anchor.current = null;
      return;
    }
    const top = node.getBoundingClientRect().top;
    const element = [
      ...node.querySelectorAll<HTMLElement>("[data-entry]"),
    ].find((e) => e.getBoundingClientRect().bottom > top);
    anchor.current = element
      ? {
          id: element.dataset.entry!,
          offset: element.getBoundingClientRect().top - top,
        }
      : null;
  }
  function restore() {
    const node = viewport.current;
    if (!node) return;
    if (following.current) {
      node.scrollTop = node.scrollHeight;
      return;
    }
    const selected = anchor.current;
    const element =
      selected &&
      [...node.querySelectorAll<HTMLElement>("[data-entry]")].find(
        (e) => e.dataset.entry === selected.id,
      );
    if (element && selected)
      node.scrollTop +=
        element.getBoundingClientRect().top -
        node.getBoundingClientRect().top -
        selected.offset;
  }
  useLayoutEffect(restore, [page, previews.attempts, visible]);
  useEffect(() => {
    if (
      !following.current &&
      previews.attempts.some((attempt) => attempt.state === "receiving")
    ) {
      setNewContent(true);
    }
  }, [previews.attempts]);
  useLayoutEffect(() => {
    if (!content.current) return;
    const observer = new ResizeObserver(restore);
    observer.observe(content.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    generation.current++;
    following.current = true;
    setPage(null);
    setNewContent(false);
  }, [threadId]);
  async function load(older = false) {
    if (!threadId || (older && !page?.previousCursor)) return;
    const gen = ++generation.current;
    reading.current = true;
    setBusy(true);
    saveAnchor();
    try {
      const result = await window.helarc.readConversation({
        threadId,
        position: older
          ? { kind: "before", cursor: page!.previousCursor! }
          : { kind: "latest" },
      });
      if (gen !== generation.current) return;
      if (result.status !== "page") {
        setError(
          result.code === "stale_cursor"
            ? "Earlier content changed. Return to latest messages."
            : "Conversation unavailable.",
        );
        return;
      }
      if (older) {
        following.current = false;
        const entries = [...result.entries, ...(page?.entries ?? [])];
        const bounded: ConversationEntry[] = [];
        let chars = 0;
        for (const entry of entries) {
          if (
            bounded.length >= 300 ||
            chars + entry.content.length > 1024 * 1024
          )
            break;
          bounded.push(entry);
          chars += entry.content.length;
        }
        setPage({ ...result, entries: bounded });
        setNewContent(true);
      } else if (following.current || !page || page.threadId !== threadId) {
        setPage(result);
        setNewContent(false);
      } else setNewContent(true);
      setError(null);
    } catch {
      if (gen === generation.current)
        setError("Conversation could not be read.");
    } finally {
      if (gen === generation.current) {
        reading.current = false;
        setBusy(false);
      }
    }
  }
  useEffect(() => {
    void load();
  }, [
    threadId,
    snapshot.activeThread?.revision,
    snapshot.run?.product.presentationRevision,
    commitKey,
  ]);
  const entries = page?.threadId === threadId ? page.entries : [];
  const committed = new Set(entries.flatMap((e) => e.modelItemIds));
  return (
    <div className="wb-conversation-body">
      <div
        className="wb-conversation-scroll"
        ref={viewport}
        onScroll={() => {
          if (!viewport.current || reading.current) return;
          const v = viewport.current;
          following.current =
            v.scrollHeight - v.scrollTop - v.clientHeight < 64 && !newContent;
          saveAnchor();
        }}
      >
        <div ref={content}>
          {page?.previousCursor && (
            <button
              className="wb-link"
              disabled={busy}
              onClick={() => void load(true)}
            >
              Load earlier messages
            </button>
          )}
          {!!page?.omittedRecords && (
            <p className="wb-muted">
              Some earlier content is no longer retained.
            </p>
          )}
          {!threadId && (
            <div className="wb-empty">
              <h1>Helarc</h1>
              <span>No conversation yet</span>
            </div>
          )}
          {entries.map((entry) => (
            <article
              key={entry.id}
              data-entry={entry.id}
              className={`wb-message wb-message-${entry.role}`}
            >
              <header>
                <strong>
                  {entry.role === "user"
                    ? "You"
                    : entry.role === "assistant"
                      ? "Helarc"
                      : "Status"}
                </strong>
                {entry.disposition && (
                  <small>{entry.disposition.replaceAll("_", " ")}</small>
                )}
                <CopyButton text={entry.content} />
                {entry.productRunId && entry.runId && (
                  <details className="wb-message-menu">
                    <summary aria-label="Message options">
                      <MoreHorizontal size={16} />
                    </summary>
                    <button
                      className="wb-link"
                      onClick={() =>
                        onInspect({
                          threadId,
                          productRunId: entry.productRunId!,
                          runId: entry.runId!,
                        })
                      }
                    >
                      Work details
                    </button>
                  </details>
                )}
              </header>
              <MessageText entry={entry} />
              <ResultLinks
                snapshot={snapshot}
                artifactIds={entry.artifactIds}
              />
            </article>
          ))}
          {previews.attempts.map((attempt) =>
            attempt.parts
              .filter(
                (p) =>
                  p.kind === "text" &&
                  p.text &&
                  !(p.modelItemId && committed.has(p.modelItemId)),
              )
              .map((part) => (
                <article
                  className="wb-message wb-preview"
                  data-entry={part.id}
                  key={`${attempt.invocationId}:${part.id}`}
                >
                  <header>
                    <strong>Helarc</strong>
                    <span className="wb-muted">
                      {attempt.state === "receiving"
                        ? "Responding"
                        : attempt.state === "committed"
                          ? "Recorded response"
                          : attempt.state === "received" ||
                              attempt.state === "validated"
                            ? "Processing response"
                            : `${attempt.state} response`}
                    </span>
                  </header>
                  <MarkdownContent text={part.text} />
                  {part.omittedBytes > 0 && (
                    <p className="wb-muted">Preview shortened.</p>
                  )}
                  {attempt.code && <p className="wb-warning">{attempt.code}</p>}
                </article>
              )),
          )}
          {previews.omitted > 0 && (
            <p className="wb-muted">Earlier response previews omitted.</p>
          )}
          {previews.error && (
            <button className="wb-link" onClick={previews.refresh}>
              {previews.error} Reload
            </button>
          )}
          {error && (
            <button
              className="wb-link"
              onClick={() => {
                following.current = true;
                void load();
              }}
            >
              {error} Reload
            </button>
          )}
        </div>
      </div>
      <button
        className={`wb-latest ${newContent ? "has-new" : ""}`}
        onClick={() => {
          following.current = true;
          void load();
        }}
      >
        <ArrowDown size={14} />
        Latest messages{newContent ? " (new content)" : ""}
      </button>
    </div>
  );
}
function MessageText({ entry }: { entry: ConversationEntry }) {
  const [full, setFull] = useState<{
      text: string;
      next: number | null;
      omitted: number;
    } | null>(null),
    [error, setError] = useState(false),
    [busy, setBusy] = useState(false);
  async function read() {
    if (!entry.detail) return;
    setBusy(true);
    try {
      const page = await window.helarc.readWorkbenchItem({
        ...entry.detail,
        offset: full?.next ?? 0,
      });
      if (page.status === "page") {
        setFull({
          text: page.text,
          next: page.nextOffset,
          omitted: page.omittedBytes,
        });
        setError(false);
      } else setError(true);
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <MarkdownContent text={full?.text ?? entry.content} />
      {entry.omittedBytes > 0 && !full && entry.detail && (
        <button className="wb-link" disabled={busy} onClick={() => void read()}>
          Read retained text
        </button>
      )}
      {full?.next != null && (
        <button className="wb-link" disabled={busy} onClick={() => void read()}>
          Next text page
        </button>
      )}
      {!!full?.omitted && (
        <p className="wb-muted">Some text was not retained.</p>
      )}
      {error && <p className="wb-warning">Retained text unavailable.</p>}
    </>
  );
}
