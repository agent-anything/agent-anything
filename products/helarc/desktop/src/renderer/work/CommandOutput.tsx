import * as React from "react";
import { useEffect, useRef, useState } from "react";
import { RefreshCw, RotateCcw, Maximize2, Minimize2 } from "lucide-react";
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
  useEffect(() => {
    if (follow && output.current)
      for (const pre of output.current.querySelectorAll("pre"))
        pre.scrollTop = pre.scrollHeight;
  }, [stdout, stderr, follow, expanded]);
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
  return (
    <div className={`wb-output${compact ? " wb-output-compact" : ""}${expanded ? " is-expanded" : ""}`} ref={output}>
      <div className="wb-output-toolbar">
        {compact && <button className="wb-icon" type="button"
          title={expanded ? "Collapse output" : "Expand output"}
          aria-label={expanded ? "Collapse output" : "Expand output"}
          onClick={() => setExpanded(value => !value)}>
          {expanded ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
        </button>}
        {(!compact || expanded) && <label>
          <input
            type="checkbox"
            checked={follow}
            onChange={(event) => setFollow(event.target.checked)}
          />
          Follow output
        </label>}
        {(!compact || page?.status === "rejected" || page?.status === "unavailable") && <button
          className="wb-icon"
          type="button"
          title="Refresh output"
          aria-label="Refresh output"
          disabled={busy}
          onClick={() => setRefresh((value) => value + 1)}
        >
          <RefreshCw size={14} />
        </button>}
        {(!compact || expanded) && <button
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
        </button>}
        {!compact && <span>
          {page?.status === "page" ? page.source : busy ? "Reading" : ""}
        </span>}
      </div>
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
      {(["stdout", "stderr"] as const).filter(stream => !compact || stream === "stdout" || stderr ||
        (page?.status === "page" && (page.stderr.omittedBytes > 0 || page.stderr.replacementCount > 0))).map((stream) => (
        <section className="wb-output-stream" key={stream}>
          <header>
            <strong>{stream}</strong>
            <CopyButton text={stream === "stdout" ? stdout : stderr} />
          </header>
          <pre onScroll={event => {
            if (follow && event.currentTarget.scrollHeight - event.currentTarget.clientHeight - event.currentTarget.scrollTop > 8)
              setFollow(false);
          }}>
            {(compact && !expanded ? outputPreview(stream === "stdout" ? stdout : stderr) : (stream === "stdout" ? stdout : stderr)) ||
              (page?.status === "page"
                ? page.settled && !page.hasMore
                  ? "(empty)"
                  : "(no output yet)"
                : "")}
          </pre>
          {page?.status === "page" && (!compact || page[stream].omittedBytes > 0 ||
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
      ))}
      {page?.status === "page" && page.hasMore && (
        <button
          className="wb-link"
          disabled={busy}
          type="button"
          onClick={() => setRefresh((value) => value + 1)}
        >
          Read next output page
        </button>
      )}
    </div>
  );
}

function outputPreview(text: string): string {
  const tail = text.split(/\r?\n/).slice(-4).join("\n");
  return tail.length > 800 ? `...${tail.slice(-800)}` : tail;
}
