import * as React from "react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { RefreshCw, RotateCcw, Maximize2, X } from "lucide-react";
import type {
  CommandOutputPage,
  WorkbenchScope,
} from "../../shared/HelarcWorkbench.js";
import { CopyButton } from "../conversation/MarkdownContent.js";

const MAX_TEXT_BYTES = 512 * 1024;
export function appendOutput(
  previous: string,
  next: string,
): { text: string; trimmed: boolean } {
  const bytes = new TextEncoder().encode(previous + next);
  if (bytes.length <= MAX_TEXT_BYTES)
    return { text: previous + next, trimmed: false };
  let start = bytes.length - MAX_TEXT_BYTES;
  while ((bytes[start]! & 0xc0) === 0x80) start++;
  return {
    text: new TextDecoder().decode(bytes.subarray(start)),
    trimmed: true,
  };
}
export function CommandOutput({
  scope,
  executionId,
  active,
  compact = false,
}: {
  scope: WorkbenchScope;
  executionId: string;
  active: boolean;
  compact?: boolean;
}) {
  const [stdout, setStdout] = useState("");
  const [stderr, setStderr] = useState("");
  const [trimmed, setTrimmed] = useState(false);
  const [page, setPage] = useState<CommandOutputPage | null>(null);
  const [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [follow, setFollow] = useState(true);
  const [expanded, setExpanded] = useState(false);
  const cursor = useRef<string | null>(null);
  const flight = useRef(false);
  const generation = useRef(0);
  const output = useRef<HTMLDivElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const dialogBody = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = dialog.current;
    if (!expanded || !element) return;
    element.showModal();
    return () => element.close();
  }, [expanded]);
  useEffect(() => {
    if (follow && compact && dialogBody.current)
      dialogBody.current.scrollTop = dialogBody.current.scrollHeight;
    else if (follow && !compact && output.current)
      for (const pre of output.current.querySelectorAll("pre"))
        pre.scrollTop = pre.scrollHeight;
  }, [stdout, stderr, follow, expanded, compact]);
  useEffect(() => {
    const version = ++generation.current;
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (!active) {
      setBusy(false);
      return;
    }
    async function read() {
      if (!active || document.visibilityState === "hidden" || flight.current) {
        timer = setTimeout(() => void read(), 1000);
        return;
      }
      flight.current = true;
      setBusy(true);
      try {
        const result = await window.helarc.readCommandOutput({
          ...scope,
          executionId,
          cursor: cursor.current,
        });
        if (version !== generation.current) return;
        setPage(result);
        if (result.status === "cursor_reset_required") {
          cursor.current = null;
          setStdout("");
          setStderr("");
          setTrimmed(false);
          timer = setTimeout(() => void read(), 0);
        } else if (result.status === "page") {
          cursor.current = result.nextCursor;
          setStdout((previous) => {
            const value = appendOutput(previous, result.stdout.text);
            if (value.trimmed) setTrimmed(true);
            return value.text;
          });
          setStderr((previous) => {
            const value = appendOutput(previous, result.stderr.text);
            if (value.trimmed) setTrimmed(true);
            return value.text;
          });
          if (!result.settled) timer = setTimeout(() => void read(), 1000);
        }
      } catch {
        if (version === generation.current)
          setPage({ status: "rejected", code: "read_failed" });
      } finally {
        flight.current = false;
        if (version === generation.current) setBusy(false);
      }
    }
    void read();
    return () => {
      generation.current++;
      clearTimeout(timer);
    };
  }, [
    scope.threadId,
    scope.productRunId,
    scope.runId,
    executionId,
    active,
    refresh,
  ]);
  const toolbar = <div className="wb-output-toolbar">
        <label>
          <input
            type="checkbox"
            checked={follow}
            onChange={(event) => setFollow(event.target.checked)}
          />
          Follow output
        </label>
        <button
          className="wb-icon"
          type="button"
          title="Refresh output"
          aria-label="Refresh output"
          disabled={busy}
          onClick={() => setRefresh((value) => value + 1)}
        >
          <RefreshCw size={14} />
        </button>
        <button
          className="wb-icon"
          type="button"
          title="Read from beginning"
          aria-label="Read from beginning"
          disabled={busy}
          onClick={() => {
            cursor.current = null;
            setStdout("");
            setStderr("");
            setTrimmed(false);
            setRefresh((value) => value + 1);
          }}
        >
          <RotateCcw size={14} />
        </button>
        <span>
          {page?.status === "page" ? page.source : busy ? "Reading" : ""}
        </span>
      </div>;
  const notices = <>
      {page?.status === "unavailable" ? (
        <p className="wb-warning">Output unavailable: {page.reason}</p>
      ) : page?.status === "rejected" ? (
        <p className="wb-warning">{page.code}</p>
      ) : null}
      {trimmed && (
        <p className="wb-muted">
          Earlier mounted output omitted; read from beginning to inspect it.
        </p>
      )}
  </>;
  const streams = (preview: boolean) => (["stdout", "stderr"] as const).filter(stream => !preview || stream === "stdout" || stderr ||
        (page?.status === "page" && (page.stderr.omittedBytes > 0 || page.stderr.replacementCount > 0))).map((stream) => (
        <section className="wb-output-stream" key={stream}>
          <header>
            <strong>{stream}</strong>
            <CopyButton text={stream === "stdout" ? stdout : stderr} />
          </header>
          <pre onScroll={event => {
            if (!compact && follow && event.currentTarget.scrollHeight - event.currentTarget.clientHeight - event.currentTarget.scrollTop > 8)
              setFollow(false);
          }}>
            {(preview ? outputPreview(stream === "stdout" ? stdout : stderr) : (stream === "stdout" ? stdout : stderr)) ||
              (page?.status === "page"
                ? page.settled && !page.hasMore
                  ? "(empty)"
                  : "(no output yet)"
                : "")}
          </pre>
          {page?.status === "page" && (!preview || page[stream].omittedBytes > 0 ||
            page[stream].replacementCount > 0 || page[stream].integrity !== "exact") && (
            <small className="wb-muted">
              {page[stream].encoding ?? "Encoding unknown"} /{" "}
              {page[stream].integrity}
              {page[stream].omittedBytes > 0
                ? ` / ${page[stream].omittedBytes} bytes not captured`
                : ""}
              {page[stream].replacementCount > 0
                ? ` / ${page[stream].replacementCount} decoding replacements`
                : ""}
            </small>
          )}
        </section>
      ));
  const more = page?.status === "page" && page.hasMore && (
        <button
          className="wb-link"
          disabled={busy}
          type="button"
          onClick={() => setRefresh((value) => value + 1)}
        >
          Read next output page
        </button>
      );
  return (
    <div className={`wb-output${compact ? " wb-output-compact" : ""}`} ref={output}>
      {compact ? <div className="wb-output-toolbar">
        <button className="wb-icon" type="button" title="Open full output" aria-label="Open full output"
          onClick={() => setExpanded(true)}><Maximize2 size={14} /></button>
        {(page?.status === "rejected" || page?.status === "unavailable") && <button className="wb-link"
          disabled={busy} onClick={() => setRefresh(value => value + 1)}>Retry output</button>}
      </div> : toolbar}
      {notices}
      {streams(compact)}
      {!compact && more}
      {compact && expanded && createPortal(<dialog ref={dialog} className="wb-output-dialog" aria-label="Command output"
        onCancel={event => {event.preventDefault(); setExpanded(false);}}>
        <header><strong>Command output</strong><button type="button" className="wb-icon" title="Close output" aria-label="Close output"
          onClick={() => setExpanded(false)}><X size={18} /></button></header>
        <div className="wb-output-dialog-body" ref={dialogBody} onScroll={event => {
          if (follow && event.currentTarget.scrollHeight - event.currentTarget.clientHeight - event.currentTarget.scrollTop > 8)
            setFollow(false);
        }}>
          {toolbar}{notices}{streams(false)}{more}
        </div>
      </dialog>, document.body)}
    </div>
  );
}

function outputPreview(text: string): string {
  const tail = text.split(/\r?\n/).slice(-4).join("\n");
  return tail.length > 800 ? `...${tail.slice(-800)}` : tail;
}
