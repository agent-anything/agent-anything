import * as React from "react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowDown } from "lucide-react";
import type { HelarcMainSnapshot } from "../../shared/HelarcDesktopApi.js";
import type {
  ConversationEntry,
  ConversationPage,
  WorkbenchScope,
} from "../../shared/HelarcWorkbench.js";
import { useResponsePreview } from "./useResponsePreview.js";
import {
  ConversationEntries,
  ModelResponseProgress,
} from "./ConversationEntries.js";
import { ConversationReadingBudget } from "./ConversationReadingBudget.js";
import { ConversationFollowing, ConversationReading } from "./ConversationReading.js";

type Props = {
  snapshot: HelarcMainSnapshot;
  scope: WorkbenchScope | null;
  onInspect: (scope: WorkbenchScope) => void;
  visible: boolean;
};
export function Conversation(props: Props) {
  return (
    <ConversationReadingBudget key={props.snapshot.activeThread?.id ?? "empty"}>
      <ConversationReader {...props} />
    </ConversationReadingBudget>
  );
}
export function boundConversation(
  entries: readonly ConversationEntry[],
  maximum = 300,
  maxChars = 1024 * 1024,
) {
  const bounded: ConversationEntry[] = [];
  let chars = 0;
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.id)) continue;
    const size = JSON.stringify(entry).length;
    if (bounded.length >= maximum || chars + size > maxChars) break;
    bounded.push(entry);
    chars += size;
    seen.add(entry.id);
  }
  return bounded;
}
function ConversationReader({ snapshot, scope, onInspect, visible }: Props) {
  const threadId = snapshot.activeThread?.id ?? "";
  const viewport = useRef<HTMLDivElement>(null),
    content = useRef<HTMLDivElement>(null);
  const following = useRef(true),
    reading = useRef(false);
  const anchor = useRef<{ id: string; offset: number; element: HTMLElement } | null>(null);
  const lastProgramScroll = useRef(-1);
  const [page, setPage] = useState<ConversationPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [newContent, setNewContent] = useState(false),
    [busy, setBusy] = useState(false);
  const [syncedCommitKey, setSyncedCommitKey] = useState("");
  const [latestRequest, setLatestRequest] = useState(0);
  const live =
    !!snapshot.run &&
    !snapshot.run.display.terminal &&
    snapshot.run.productRunId === scope?.productRunId;
  const previews = useResponsePreview(
    scope,
    live && visible,
    snapshot.activeThread?.revision ?? 0,
  );
  const commitKey = previews.attempts
    .filter((a) => a.state === "committed")
    .map((a) => `${a.invocationId}:${a.revision}`)
    .join("|");
  const state = useRef({ page, commitKey });
  state.current = { page, commitKey };
  const reader = useRef<(older?: boolean) => void>(() => {});
  function returnToLatest() {
    following.current = true;
    anchor.current = null;
    setLatestRequest(value => value + 1);
    reader.current();
  }
  function saveAnchor() {
    const node = viewport.current;
    if (!node || following.current) {
      anchor.current = null;
      return;
    }
    const top = node.getBoundingClientRect().top;
    const candidates = [...node.querySelectorAll<HTMLElement>("[data-entry], [data-reading-anchor]")]
      .filter(e => e.getBoundingClientRect().height > 0 && e.getBoundingClientRect().bottom > top);
    // Prefer the deepest entry spanning the viewport top, not its root ancestor.
    const element = candidates.filter(e => e.getBoundingClientRect().top <= top).at(-1) ?? candidates[0];
    anchor.current = element
      ? {
          id: element.dataset.readingAnchor ?? element.dataset.entry!,
          offset: element.getBoundingClientRect().top - top,
          element,
        }
      : null;
  }
  function restore() {
    const node = viewport.current;
    if (!node) return;
    if (following.current) {
      node.scrollTop = node.scrollHeight;
      lastProgramScroll.current = node.scrollTop;
      return;
    }
    const selected = anchor.current;
    const element =
      selected &&
      (selected.element.isConnected ? selected.element :
        [...node.querySelectorAll<HTMLElement>("[data-entry], [data-reading-anchor]")].find(
          (e) => (e.dataset.readingAnchor ?? e.dataset.entry) === selected.id,
        ));
    if (element && selected)
      node.scrollTop +=
        element.getBoundingClientRect().top -
        node.getBoundingClientRect().top -
        selected.offset;
    lastProgramScroll.current = node.scrollTop;
  }
  useLayoutEffect(restore, [page, previews.attempts, visible]);
  useLayoutEffect(() => {
    if (!content.current) return;
    const observer = new ResizeObserver(restore);
    observer.observe(content.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    let disposed = false,
      again = false,
      inFlight = false;
    async function load(older = false) {
      if (!threadId) return;
      if (inFlight) {
        again = true;
        return;
      }
      const previous = state.current.page,
        committed = state.current.commitKey;
      if (older && !previous?.previousCursor) return;
      inFlight = true;
      reading.current = true;
      setBusy(true);
      saveAnchor();
      try {
        const window = !older && !following.current && previous?.entries.length;
        let result: ConversationPage;
        if (window) {
          const first = previous.entries[0]!.id,
            last = previous.entries.at(-1)!.id;
          const entries: ConversationEntry[] = [];
          let cursor: string | undefined;
          let firstPage: ConversationPage | null = null;
          let lastPage: ConversationPage | null = null;
          do {
            const next = await globalThis.window.helarc.readConversation({
              threadId,
              position: {
                kind: "window",
                first,
                last,
                ...(cursor ? { cursor } : {}),
              },
            });
            if (disposed) return;
            if (next.status !== "page") throw Error(next.code);
            entries.push(...next.entries);
            firstPage ??= next;
            lastPage = next;
            cursor = next.nextWindowCursor ?? undefined;
          } while (cursor && entries.length < 300);
          result = {
            ...lastPage!,
            previousCursor: firstPage!.previousCursor,
            entries: boundConversation(entries),
          };
        } else {
          const next = await globalThis.window.helarc.readConversation({
            threadId,
            position: older
              ? { kind: "before", cursor: previous!.previousCursor! }
              : { kind: "latest" },
          });
          if (disposed) return;
          if (next.status !== "page") throw Error(next.code);
          result = older
            ? {
                ...next,
                entries: boundConversation([
                  ...next.entries,
                  ...(previous?.entries ?? []),
                ]),
              }
            : next;
        }
        if (older) following.current = false;
        setPage(result);
        setSyncedCommitKey(committed);
        setError(null);
        const last = result.entries.at(-1)?.position,
          latest = result.latestPosition;
        setNewContent(
          !!last &&
            !!latest &&
            (last[0] < latest[0] ||
              (last[0] === latest[0] && last[1] < latest[1])),
        );
      } catch (e) {
        if (!disposed)
          setError(
            e instanceof Error && e.message === "stale_cursor"
              ? "Earlier content changed. Return to latest messages."
              : "Conversation could not be read.",
          );
      } finally {
        inFlight = false;
        if (!disposed) {
          reading.current = false;
          setBusy(false);
          if (again) {
            again = false;
            void load();
          }
        }
      }
    }
    reader.current = (older) => {
      void load(older);
    };
    void load();
    return () => {
      disposed = true;
    };
  }, [threadId]);
  useEffect(() => {
    if (visible) reader.current();
  }, [
    snapshot.activeThread?.revision,
    snapshot.run?.product.presentationRevision,
    snapshot.run?.host.runRevision,
    commitKey,
    visible,
  ]);
  useEffect(() => {
    if (
      !following.current &&
      previews.attempts.some((a) => a.state === "receiving")
    )
      setNewContent(true);
  }, [previews.attempts]);
  return (
    <div className="wb-conversation-body">
      <div
        className="wb-conversation-scroll"
        ref={viewport}
        onScroll={() => {
          if (!viewport.current || reading.current) return;
          const v = viewport.current;
          if (v.scrollTop === lastProgramScroll.current) return;
          const atTail = v.scrollHeight - v.scrollTop - v.clientHeight < 64;
          if (atTail && (!following.current || newContent)) {
            returnToLatest();
            return;
          }
          following.current = atTail;
          saveAnchor();
        }}
      >
        <div ref={content}>
          {page?.previousCursor && (
            <button
              className="wb-link"
              disabled={busy}
              onClick={() => reader.current(true)}
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
          <ConversationFollowing.Provider value={{following, latest: latestRequest}}>
          <ConversationReading.Provider value={element => {
            following.current = false;
            if (element && viewport.current) {
              anchor.current = {element, id: element.dataset.readingAnchor ?? element.dataset.entry ?? "",
                offset: Math.max(0, element.getBoundingClientRect().top - viewport.current.getBoundingClientRect().top)};
            } else saveAnchor();
          }}>
          <ConversationEntries
            entries={page?.entries ?? []}
            snapshot={snapshot}
            visible={visible}
            live={live}
            revision={page?.revision ?? 0}
            onInspect={onInspect}
            attempts={previews.attempts}
            syncedCommitKey={syncedCommitKey}
          />
          </ConversationReading.Provider>
          </ConversationFollowing.Provider>
          <ModelResponseProgress attempts={previews.attempts} live={live} />
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
              onClick={returnToLatest}
            >
              {error} Reload
            </button>
          )}
        </div>
      </div>
      <button
        className={`wb-latest ${newContent ? "has-new" : ""}`}
        onClick={returnToLatest}
      >
        <ArrowDown size={14} />
        Latest messages{newContent ? " (new content)" : ""}
      </button>
    </div>
  );
}
