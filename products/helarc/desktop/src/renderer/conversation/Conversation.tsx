import * as React from "react";
import { useLayoutEffect, useRef, useState } from "react";
import { ChevronDown, FileText, Wrench } from "lucide-react";
import type {
  HelarcMainSnapshot,
  HelarcArtifactSnapshot,
  HelarcThreadMessageSnapshot,
} from "../../shared/HelarcDesktopApi.js";
import type {
  HelarcRunPresentationRecord,
  ThreadRunSummary,
  WorkbenchScope,
} from "../../shared/HelarcWorkbench.js";
import { useWorkbench } from "../workbench/useWorkbench.js";
import { CopyButton, MarkdownContent } from "./MarkdownContent.js";

export function isRepresentedFinal(
  message: HelarcThreadMessageSnapshot,
  records: readonly HelarcRunPresentationRecord[],
): boolean {
  const source = message.outputSource;
  return (
    source?.kind === "model_text" &&
    source.modelItemIds.length > 0 &&
    source.modelItemIds.every((id) =>
      records.some(
        (record) =>
          record.content.kind === "assistant_text" &&
          record.content.modelItemId === id,
      ),
    )
  );
}
export function Conversation({
  snapshot,
  runs,
  onInspect,
}: {
  snapshot: HelarcMainSnapshot;
  runs: readonly ThreadRunSummary[];
  onInspect: (run: ThreadRunSummary) => void;
}) {
  const viewport = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  useLayoutEffect(() => {
    if (!content.current) return;
    const observer = new ResizeObserver(() => {
      if (following.current && viewport.current)
        viewport.current.scrollTop = viewport.current.scrollHeight;
    });
    observer.observe(content.current);
    return () => observer.disconnect();
  }, []);
  useLayoutEffect(() => {
    if (following.current && viewport.current)
      viewport.current.scrollTop = viewport.current.scrollHeight;
  }, [
    snapshot.activeThread?.revision,
    snapshot.run?.product.presentationRevision,
  ]);
  const thread = snapshot.activeThread;
  const displayed = new Set<string>();
  return (
    <div
      className="wb-conversation-scroll"
      ref={viewport}
      onScroll={() => {
        const node = viewport.current;
        if (node)
          following.current =
            node.scrollHeight - node.scrollTop - node.clientHeight < 80;
      }}
    >
      <div ref={content}>
        {!thread?.messages.length && (
          <div className="wb-empty">
            <h1>Helarc</h1>
            <span>No conversation yet</span>
          </div>
        )}
        {thread?.messages.map((message) => {
          if (
            message.role === "assistant" &&
            message.relatedRunIds.some((id) =>
              runs.some((run) => run.productRunId === id && run.harnessRunId),
            )
          )
            return null;
          const related = runs.filter(
            (run) =>
              run.harnessRunId &&
              message.relatedRunIds.includes(run.productRunId) &&
              !displayed.has(run.productRunId),
          );
          related.forEach((run) => displayed.add(run.productRunId));
          return (
            <React.Fragment key={message.id}>
              <article className={`wb-message wb-message-${message.role}`}>
                <header>
                  <strong>
                    {message.role === "user"
                      ? "You"
                      : message.role === "assistant"
                        ? "Helarc"
                        : message.role}
                  </strong>
                  <time>
                    {new Date(message.createdAt).toLocaleTimeString([], {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </time>
                  <CopyButton text={message.content} />
                </header>
                <MarkdownContent text={message.content} />
              </article>
              {related.map((run) => (
                <RunConversation
                  key={run.productRunId}
                  scope={{
                    threadId: thread.id,
                    productRunId: run.productRunId,
                    runId: run.harnessRunId!,
                  }}
                  revision={
                    snapshot.run?.productRunId === run.productRunId
                      ? snapshot.run.product.presentationRevision
                      : 0
                  }
                  finalMessages={thread.messages.filter(
                    (item) =>
                      item.role === "assistant" &&
                      item.relatedRunIds.includes(run.productRunId),
                  )}
                  artifacts={thread.artifacts.filter(
                    (item) => item.runId === run.productRunId,
                  )}
                  onInspect={() => onInspect(run)}
                />
              ))}
            </React.Fragment>
          );
        })}
      </div>
    </div>
  );
}
function RunConversation({
  scope,
  revision,
  finalMessages,
  artifacts,
  onInspect,
}: {
  scope: WorkbenchScope;
  revision: number;
  finalMessages: readonly HelarcThreadMessageSnapshot[];
  artifacts: readonly HelarcArtifactSnapshot[];
  onInspect: () => void;
}) {
  const { page, error, loadMore, busy } = useWorkbench(scope, revision);
  return (
    <section className="wb-run-conversation" aria-label="Run conversation">
      <button className="wb-link" onClick={onInspect} type="button">
        Execution <ChevronDown size={13} />
      </button>
      {page?.records.map((record) =>
        record.content.kind === "assistant_text" ? (
          <AssistantBlock key={record.id} record={record} scope={scope} />
        ) : record.content.kind === "tool_call" ? (
          <details className="wb-tool-row" key={record.id}>
            <summary>
              <Wrench size={13} />
              <strong>{record.content.name}</strong>
              <span>{record.content.settlement ?? "Requested"}</span>
            </summary>
            <pre>
              {JSON.stringify(
                { input: record.content.input, result: record.content.result },
                null,
                2,
              )}
            </pre>
          </details>
        ) : record.content.kind === "plan_update" ? (
          <div className="wb-plan-marker" key={record.id}>
            Plan updated
          </div>
        ) : null,
      )}
      {page?.omittedRecords ? (
        <p className="wb-muted">
          {page.omittedRecords} earlier display records are no longer retained.
        </p>
      ) : null}
      {page?.nextCursor && (
        <button
          className="wb-link"
          type="button"
          disabled={busy}
          onClick={() => void loadMore()}
        >
          Load more activity
        </button>
      )}
      {error && <p className="wb-muted">Activity unavailable: {error}</p>}
      {finalMessages
        .filter((message) => !isRepresentedFinal(message, page?.records ?? []))
        .map((message) => (
          <article className="wb-message" key={message.id}>
            <header>
              <strong>Helarc</strong>
              <CopyButton text={message.content} />
            </header>
            <MarkdownContent text={message.content} />
          </article>
        ))}
      {artifacts.map((artifact) => (
        <details className="wb-tool-row" key={artifact.id}>
          <summary>
            <FileText size={13} />
            <strong>{artifact.title}</strong>
            <span>{artifact.kind}</span>
          </summary>
          <p>{artifact.summary ?? "No summary recorded"}</p>
          <button className="wb-link" type="button" onClick={onInspect}>
            Inspect execution
          </button>
        </details>
      ))}
    </section>
  );
}
export function AssistantBlock({
  record,
  scope,
}: {
  record: HelarcRunPresentationRecord;
  scope: WorkbenchScope;
}) {
  const [fullText, setFullText] = useState<string | null>(null);
  const [retainedOmission, setRetainedOmission] = useState(0);
  const [busy, setBusy] = useState(false);
  const [readError, setReadError] = useState(false);
  if (record.content.kind !== "assistant_text") return null;
  const content = record.content;
  async function readFull() {
    setBusy(true);
    setReadError(false);
    try {
      let text = "",
        offset: number | null = 0;
      while (offset !== null) {
        const result = await window.helarc.readWorkbenchItem({
          ...scope,
          itemId: record.id,
          offset,
        });
        if (result.status !== "page") {
          setReadError(true);
          return;
        }
        text += result.text;
        setRetainedOmission(result.omittedBytes);
        offset = result.nextOffset;
      }
      setFullText(text);
    } catch {
      setReadError(true);
    } finally {
      setBusy(false);
    }
  }
  return (
    <article className="wb-message">
      <header>
        <strong>Helarc</strong>
        <CopyButton text={fullText ?? content.text} />
      </header>
      <MarkdownContent text={fullText ?? content.text} />
      {content.omittedBytes > 0 && fullText === null && (
        <button
          type="button"
          className="wb-link"
          disabled={busy}
          onClick={() => void readFull()}
        >
          Read retained text
        </button>
      )}
      {readError && <p className="wb-muted">Retained text unavailable.</p>}
      {fullText !== null && retainedOmission > 0 && (
        <p className="wb-muted">
          {retainedOmission} bytes were not retained in this display.
        </p>
      )}
    </article>
  );
}
