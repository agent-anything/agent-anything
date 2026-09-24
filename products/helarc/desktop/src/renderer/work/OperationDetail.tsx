import * as React from "react";
import { useEffect, useState } from "react";
import { ChevronRight } from "lucide-react";
import type { HelarcRunPresentationRecord, WorkbenchOperationSection, WorkbenchScope } from "../../shared/HelarcWorkbench.js";
import { useRead } from "../workbench/useRead.js";
import { CopyButton, MarkdownContent } from "../conversation/MarkdownContent.js";

export function OperationDetail({ scope, record, revision, onTask, visible = true }: {
  scope: WorkbenchScope;
  record: Pick<HelarcRunPresentationRecord, "id"> & { content?: { kind: string } };
  revision: number;
  onTask?: (runId: string) => void;
  visible?: boolean;
}) {
  const [offset, setOffset] = useState(0);
  const read = useRead(JSON.stringify([scope, record.id, offset]), revision,
    () => window.helarc.readWorkbenchItem({ ...scope, itemId: record.id, offset }), visible);
  const detail = read.value?.status === "operation" ? read.value.detail : null;
  return <section className="wb-operation-detail">
    <h2>{detail?.title ?? (read.value?.status === "page" ? read.value.title
      : record.content?.kind === "tool_call" ? "Operation" : "Response")}</h2>
    {read.error || read.value?.status === "rejected" ? <div role="alert">
      <p className="wb-warning">Work details unavailable.</p>
      <button className="wb-link" onClick={read.refresh}>Retry</button>
    </div> : detail ? <>
      {detail.summary && <p className="wb-operation-summary">{detail.summary}</p>}
      <p className="wb-muted">Call: {detail.status}</p>
      {detail.child && onTask && <button className="wb-child-link" onClick={() => onTask(detail.child!.runId)}>
        <span><strong>{detail.child.label}</strong><small>{detail.child.status.replaceAll("_", " ")}</small></span>
        <ChevronRight size={16} />
      </button>}
      {detail.sections.map(section => <OperationSection key={section.id}
        scope={scope} itemId={record.id} revision={revision} section={section} />)}
      {detail.facts.length > 0 && <details className="wb-secondary">
        <summary>Additional information</summary>
        <dl className="wb-operation-facts">{detail.facts.map(f => <React.Fragment key={f.label}>
          <dt>{f.label}</dt><dd>{f.value}</dd>
        </React.Fragment>)}</dl>
      </details>}
    </> : read.value?.status === "page" ? <>
      <CopyButton text={read.value.text} /><MarkdownContent text={read.value.text} />
      {read.value.omittedBytes > 0 && <p className="wb-muted">Some original content is no longer retained.</p>}
      {read.value.nextOffset !== null && <button className="wb-link" onClick={() =>
        setOffset(read.value?.status === "page" ? read.value.nextOffset! : 0)}>Next content page</button>}
    </> : <p className="wb-muted">Loading details...</p>}
  </section>;
}

function OperationSection({ scope, itemId, revision, section }: {
  scope: WorkbenchScope; itemId: string; revision: number; section: WorkbenchOperationSection;
}) {
  const [offset, setOffset] = useState(0);
  useEffect(() => setOffset(0), [section.text, section.nextOffset]);
  const read = useRead(offset ? JSON.stringify([scope, itemId, section.id, offset]) : "", revision,
    () => window.helarc.readWorkbenchItem({ ...scope, itemId, section: section.id, offset }));
  const current = offset === 0 ? section : read.value?.status === "operation"
    ? read.value.detail.sections.find(s => s.id === section.id) : null;
  return <section className="wb-operation-section" aria-label={section.label}>
    <header><h3>{section.label}</h3>{current && <CopyButton text={current.text} />}</header>
    {current ? <>
      {current.text === "" ? <p className="wb-muted">Empty content</p>
        : current.format === "markdown" ? <MarkdownContent text={current.text} /> : <pre>{current.text}</pre>}
      <div className="wb-operation-paging">
        {offset > 0 && <button className="wb-link" onClick={() => setOffset(0)}>Back to beginning</button>}
        {current.nextOffset !== null && <button className="wb-link" onClick={() => setOffset(current.nextOffset!)}>Next content page</button>}
      </div>
    </> : read.error || read.value?.status === "rejected" ? <div role="alert">
      <p className="wb-warning">Content unavailable.</p><button className="wb-link" onClick={read.refresh}>Retry</button>
      <button className="wb-link" onClick={() => setOffset(0)}>Back to beginning</button>
    </div> : <p className="wb-muted">Loading content...</p>}
  </section>;
}
