import * as React from "react";
import { useEffect, useRef, useState } from "react";
import { MoreHorizontal } from "lucide-react";
import type { HelarcMainSnapshot } from "../../shared/HelarcDesktopApi.js";
import type {
  ConversationBlock,
  ConversationEntry,
  ConversationPage,
  ConversationTurnEntry,
  ConversationTurnPage,
  ResponsePreviewSummary,
  WorkbenchScope,
} from "../../shared/HelarcWorkbench.js";
import { MarkdownContent, CopyButton } from "./MarkdownContent.js";
import { ResultLinks } from "../work/ResultContent.js";
import { ConversationActivity } from "./ConversationActivity.js";
import { useResponsePreview } from "./useResponsePreview.js";
import { useConversationCapacity } from "./ConversationReadingBudget.js";

export interface ConversationContentProps {
  entries: readonly ConversationEntry[];
  snapshot: HelarcMainSnapshot;
  visible: boolean;
  live: boolean;
  revision: number;
  onInspect: (scope: WorkbenchScope) => void;
}
export function ConversationEntries(
  props: ConversationContentProps & {
    attempts: readonly ResponsePreviewSummary[];
    syncedCommitKey: string;
  },
) {
  const committed = new Set(props.entries.flatMap((e) => e.modelItemIds));
  const mapping = new Map(
    props.attempts.flatMap((a) =>
      a.parts
        .filter((p) => p.turnId)
        .map((p) => [p.turnId!, `preview:${a.invocationId}`] as const),
    ),
  );
  return (
    <>
      {props.entries.map((entry) => (
        <article
          key={entry.id}
          data-entry={
            entry.kind === "turn"
              ? (mapping.get(entry.turnId) ?? entry.id)
              : entry.id
          }
          className={`wb-message wb-message-${entry.role}${entry.kind === "turn" ? " wb-response" : ""}`}
        >
          {(entry.kind !== "turn" ||
            entry.blocks.some((b) => b.kind !== "activity")) && (
            <header>
              <strong>
                {entry.title ??
                  (entry.role === "user"
                    ? "You"
                    : entry.role === "assistant"
                      ? "Helarc"
                      : "Status")}
              </strong>
              {entry.disposition && (
                <small>{entry.disposition.replaceAll("_", " ")}</small>
              )}
              {entry.kind !== "turn" && <CopyButton text={entry.content} />}
              {entry.productRunId && entry.runId && (
                <details className="wb-message-menu">
                  <summary aria-label="Message options">
                    <MoreHorizontal size={16} />
                  </summary>
                  <button
                    className="wb-link"
                    onClick={() =>
                      props.onInspect({
                        threadId: props.snapshot.activeThread!.id,
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
          )}
          {entry.kind === "turn" ? (
            <ConversationTurn key={entry.id} entry={entry} {...props} />
          ) : (
            <>
              <ConversationText
                text={entry.content}
                omittedBytes={entry.omittedBytes}
                detail={entry.detail}
                plain={entry.kind === "interaction"}
              />
              <ResultLinks
                snapshot={props.snapshot}
                artifactIds={entry.artifactIds}
              />
            </>
          )}
        </article>
      ))}
      {props.attempts.map((attempt) => {
        const synchronized =
          attempt.state === "committed" &&
          props.syncedCommitKey
            .split("|")
            .includes(`${attempt.invocationId}:${attempt.revision}`);
        const parts = attempt.parts.filter(
          (part) =>
            (part.kind === "text" || part.kind === "final_response") &&
            part.text &&
            !(part.modelItemId && committed.has(part.modelItemId)) &&
            !synchronized,
        );
        if (!parts.length) return null;
        return (
          <article
            className="wb-message wb-preview"
            data-entry={`preview:${attempt.invocationId}`}
            key={attempt.invocationId}
          >
            <header>
              <strong>Helarc</strong>
              <small>
                {attempt.state === "receiving"
                  ? "Responding"
                  : ["received", "validated", "committed"].includes(
                        attempt.state,
                      )
                    ? parts.some((p) => p.kind === "final_response")
                      ? "Awaiting completion"
                      : "Processing response"
                    : `${attempt.state} response`}
              </small>
            </header>
            {parts.map((part) => (
              <React.Fragment key={part.id}>
                <MarkdownContent text={part.text} />
                {!!part.omittedBytes && (
                  <p className="wb-muted">Preview shortened.</p>
                )}
              </React.Fragment>
            ))}
            {attempt.code && <p className="wb-warning">{attempt.code}</p>}
          </article>
        );
      })}
    </>
  );
}

export function ModelResponseProgress({
  attempts,
  live,
}: {
  attempts: readonly ResponsePreviewSummary[];
  live: boolean;
}) {
  const attempt = attempts.at(-1);
  if (
    !live ||
    !attempt ||
    !["receiving", "received", "validated"].includes(attempt.state)
  )
    return null;
  const label =
    attempt.state === "receiving"
      ? attempt.parts.some((p) => p.receivedLength > 0)
        ? "Receiving model response"
        : "Waiting for model response"
      : "Processing model response";
  return (
    <div className="wb-model-response-progress" role="status">
      <span>{label}</span>
    </div>
  );
}

function ConversationTurn({
  entry,
  ...props
}: ConversationContentProps & { entry: ConversationTurnEntry }) {
  const [pages, setPages] = useState(0);
  const capacity = useConversationCapacity("turns", pages ? 1 : 0);
  const [full, setFull] = useState<ConversationTurnPage | null>(null);
  const [error, setError] = useState(false);
  const reader = useRef<() => void>(() => {});
  const latest = useRef({ entry, pages: capacity ? pages : 0 });
  latest.current = { entry, pages: capacity ? pages : 0 };
  useEffect(() => {
    let disposed = false,
      reading = false,
      again = false;
    const load = async () => {
      if (!latest.current.pages) return;
      if (reading) {
        again = true;
        return;
      }
      reading = true;
      const { entry, pages } = latest.current;
      try {
        let cursor: string | null = null,
          result: ConversationTurnPage | null = null;
        const blocks: ConversationBlock[] = [];
        for (let index = 0; index < pages; index++) {
          const page = await window.helarc.readConversationTurn({
            ...entry.scope,
            turnId: entry.turnId,
            cursor,
          });
          if (disposed) return;
          if (page.status !== "page") throw Error(page.code);
          blocks.push(...page.blocks);
          result = page;
          cursor = page.nextCursor;
          if (!cursor || blocks.length >= 300) break;
        }
        if (result) setFull({ ...result, blocks });
        setError(false);
      } catch {
        if (!disposed) setError(true);
      } finally {
        reading = false;
        if (again && !disposed) {
          again = false;
          void load();
        }
      }
    };
    reader.current = () => {
      void load();
    };
    void load();
    return () => {
      disposed = true;
    };
  }, [entry.id, capacity]);
  useEffect(() => {
    if (pages && capacity) reader.current();
    else setFull(null);
  }, [entry.revision, pages, capacity]);
  const blocks = capacity && pages && full ? full.blocks : entry.blocks;
  const groups: (
    | ConversationBlock
    | {
        kind: "activities";
        id: string;
        blocks: Extract<ConversationBlock, { kind: "activity" }>[];
      }
  )[] = [];
  for (const block of blocks) {
    const previous = groups.at(-1);
    if (block.kind === "activity") {
      if (previous?.kind === "activities") previous.blocks.push(block);
      else
        groups.push({
          kind: "activities",
          id: block.modelItemId,
          blocks: [block],
        });
    } else groups.push(block);
  }
  return (
    <>
      {groups.map((group) =>
        group.kind === "activities" ? (
          <ConversationActivity
            key={group.id}
            scope={entry.scope}
            items={group.blocks.map((b) => b.item)}
            revision={entry.revision}
            visible={props.visible}
            renderChild={(child) => (
              <ChildConversation
                {...props}
                child={child.scope}
                label={child.label}
                live={
                  props.live &&
                  !["completed", "failed", "cancelled", "inactive"].includes(
                    child.status,
                  )
                }
              />
            )}
          />
        ) : (
          group.kind !== "activity" && (
            <div className="wb-response-text" key={group.id}>
              {group.disposition && (
                <small className="wb-muted">{group.disposition}</small>
              )}
              <ConversationText
                text={group.text}
                omittedBytes={group.omittedBytes}
                detail={group.detail}
              />
              <ResultLinks
                snapshot={props.snapshot}
                artifactIds={group.artifactIds}
              />
            </div>
          )
        ),
      )}
      {(full?.partial ?? entry.partial) && (
        <p className="wb-muted">
          Some original response content is no longer retained.
        </p>
      )}
      {(full ? full.nextCursor : entry.nextCursor) && (
        <button
          className="wb-link"
          disabled={pages >= 3}
          onClick={() => setPages((p) => p + 1)}
        >
          More response content{pages >= 3 ? " (reading limit reached)" : ""}
        </button>
      )}
      {pages > 0 && (
        <button className="wb-link" onClick={() => setPages(0)}>
          Show less response content
        </button>
      )}
      {pages > 0 && !capacity && (
        <p className="wb-muted">
          Collapse another long response to read more here.
        </p>
      )}
      {error && (
        <button className="wb-link wb-warning" onClick={() => reader.current()}>
          Response content changed or is unavailable. Reload
        </button>
      )}
    </>
  );
}

function ChildConversation(
  props: Omit<ConversationContentProps, "entries"> & {
    child: WorkbenchScope;
    label: string;
  },
) {
  const capacity = useConversationCapacity("children", 1);
  return capacity ? (
    <ChildConversationContent {...props} />
  ) : (
    <p className="wb-muted">
      Collapse another delegated conversation to open this one.
    </p>
  );
}
function ChildConversationContent(
  props: Omit<ConversationContentProps, "entries"> & {
    child: WorkbenchScope;
    label: string;
  },
) {
  const previews = useResponsePreview(
    props.child,
    props.live && props.visible,
    props.revision,
  );
  const commitKey = previews.attempts
    .filter((a) => a.state === "committed")
    .map((a) => `${a.invocationId}:${a.revision}`)
    .join("|");
  const [page, setPage] = useState<ConversationPage | null>(null),
    [error, setError] = useState(false);
  const [synced, setSynced] = useState("");
  const historical = useRef(false);
  const [hasNew, setHasNew] = useState(false);
  const latest = useRef({ commitKey, page });
  latest.current = { commitKey, page };
  const reader = useRef<(older?: boolean) => void>(() => {});
  useEffect(() => {
    let disposed = false,
      reading = false,
      again = false;
    async function load(older = false) {
      if (reading) {
        again = true;
        return;
      }
      reading = true;
      const previous = latest.current.page,
        committed = latest.current.commitKey;
      try {
        const q = { threadId: props.child.threadId, scope: props.child };
        let result = await window.helarc.readConversation({
          ...q,
          position:
            older && previous?.previousCursor
              ? { kind: "before", cursor: previous.previousCursor }
              : historical.current && previous?.entries.length
                ? {
                    kind: "window",
                    first: previous.entries[0]!.id,
                    last: previous.entries.at(-1)!.id,
                  }
                : { kind: "latest" },
        });
        if (disposed) return;
        if (result.status !== "page") throw Error(result.code);
        const entries = older
          ? [...result.entries, ...(previous?.entries ?? [])]
          : [...result.entries];
        while (result.nextWindowCursor && entries.length < 100) {
          const next = await window.helarc.readConversation({
            ...q,
            position: {
              kind: "window",
              first: previous!.entries[0]!.id,
              last: previous!.entries.at(-1)!.id,
              cursor: result.nextWindowCursor,
            },
          });
          if (disposed) return;
          if (next.status !== "page") throw Error(next.code);
          entries.push(...next.entries);
          result = { ...result, nextWindowCursor: next.nextWindowCursor };
        }
        const bounded: ConversationEntry[] = [];
        let chars = 0;
        for (const entry of entries) {
          const size = JSON.stringify(entry).length;
          if (bounded.length >= 100 || chars + size > 256 * 1024) break;
          bounded.push(entry);
          chars += size;
        }
        if (older) historical.current = true;
        const last = bounded.at(-1)?.position,
          latest = result.latestPosition;
        setHasNew(
          !!last &&
            !!latest &&
            (last[0] < latest[0] ||
              (last[0] === latest[0] && last[1] < latest[1])),
        );
        setPage({ ...result, entries: bounded });
        setSynced(committed);
        setError(false);
      } catch {
        if (!disposed) setError(true);
      } finally {
        reading = false;
        if (again && !disposed) {
          again = false;
          void load();
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
  }, [JSON.stringify(props.child)]);
  useEffect(() => reader.current(), [props.revision, commitKey]);
  return (
    <section className="wb-delegated-conversation" aria-label={props.label}>
      <h4>{props.label}</h4>
      {page?.previousCursor && (
        <button className="wb-link" onClick={() => reader.current(true)}>
          Earlier delegated messages
        </button>
      )}
      {hasNew && (
        <button
          className="wb-link"
          onClick={() => {
            historical.current = false;
            reader.current();
          }}
        >
          Latest delegated messages
        </button>
      )}
      {!!page?.omittedRecords && (
        <p className="wb-muted">Some earlier content is no longer retained.</p>
      )}
      <ConversationEntries
        {...props}
        entries={page?.entries ?? []}
        attempts={previews.attempts}
        syncedCommitKey={synced}
      />
      <ModelResponseProgress attempts={previews.attempts} live={props.live} />
      {page && !page.entries.length && !previews.attempts.length && (
        <p className="wb-muted">No retained response yet.</p>
      )}
      {error && (
        <button
          className="wb-link wb-warning"
          onClick={() => {
            historical.current = false;
            reader.current();
          }}
        >
          Delegated conversation unavailable. Return to latest
        </button>
      )}
    </section>
  );
}

export function ConversationText({
  text,
  omittedBytes,
  detail,
  plain,
}: {
  text: string;
  omittedBytes: number;
  detail: ConversationEntry["detail"];
  plain?: boolean;
}) {
  const [full, setFull] = useState<{
    text: string;
    next: number | null;
    omitted: number;
  } | null>(null);
  const [error, setError] = useState(false),
    [busy, setBusy] = useState(false);
  const generation = useRef(0);
  useEffect(() => {
    generation.current++;
    setFull(null);
    return () => {
      generation.current++;
    };
  }, [JSON.stringify(detail)]);
  async function read() {
    if (!detail) return;
    const gen = generation.current;
    setBusy(true);
    try {
      const page = await window.helarc.readWorkbenchItem({
        ...detail,
        offset: full?.next ?? 0,
      });
      if (gen !== generation.current) return;
      if (page.status !== "page") throw Error("unavailable");
      setFull({
        text: page.text,
        next: page.nextOffset,
        omitted: page.omittedBytes,
      });
      setError(false);
    } catch {
      if (gen === generation.current) setError(true);
    } finally {
      if (gen === generation.current) setBusy(false);
    }
  }
  return (
    <>
      {plain ? (
        <div className="wb-interaction-text">{full?.text ?? text}</div>
      ) : (
        <MarkdownContent text={full?.text ?? text} />
      )}
      {!full && omittedBytes > 0 && detail && (
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
