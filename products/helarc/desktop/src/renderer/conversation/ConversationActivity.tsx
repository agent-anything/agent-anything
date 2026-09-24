import * as React from "react";
import { useEffect, useId, useState } from "react";
import { ChevronDown, ChevronRight, ChevronUp, Terminal, Wrench, MessageCircle, CircleAlert } from "lucide-react";
import type { WorkbenchActivity, WorkbenchActivityItem, WorkbenchScope } from "../../shared/HelarcWorkbench.js";
import { CommandOutput } from "../work/CommandOutput.js";
import { OperationDetail } from "../work/OperationDetail.js";
import { useRead } from "../workbench/useRead.js";
import { ElapsedTime } from "../workbench/ElapsedTime.js";

/** Reading recency, not a cross-Run execution order. Preserve selection on unchanged polls. */
export function latestActivity(previous: WorkbenchActivity | null, next: WorkbenchActivity | null, selectedId?: string): WorkbenchActivityItem | null {
  const items = [...(next?.current ?? []), ...(next?.recent ?? [])];
  const before = new Map([...(previous?.current ?? []), ...(previous?.recent ?? [])]
    .map(item => [item.id, JSON.stringify(item)]));
  const changed = items.filter(item => before.get(item.id) !== JSON.stringify(item));
  return changed.find(item => item.id === selectedId) ?? changed[0]
    ?? items.find(item => item.id === selectedId) ?? items[0] ?? null;
}

export function ConversationActivity({ scope, activity, revision, visible, error, onRetry }: {
  scope: WorkbenchScope; activity: WorkbenchActivity | null; revision: number;
  visible: boolean; error: boolean; onRetry: () => void;
}) {
  const [open, setOpen] = useState(false);
  const contentId = useId();
  const [preview, setPreview] = useState(() => ({ activity, item: latestActivity(null, activity) }));
  if (preview.activity !== activity) {
    setPreview({ activity, item: latestActivity(preview.activity, activity, preview.item?.id) });
  }
  const [more, setMore] = useState(false);
  const [history, setHistory] = useState(false);
  const [expanded, setExpanded] = useState<Record<string, WorkbenchActivityItem>>({});
  const [automatic, setAutomatic] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const current = activity?.current ?? [], recent = activity?.recent ?? [];
  const items = new Map([...current, ...recent].map(item => [item.id, item]));
  const command = current.find(item => item.kind === "command" && item.state === "ongoing");
  useEffect(() => {
    if (open && command && !dismissed.has(command.id)) setAutomatic(command.id);
  }, [open, command?.id]);
  // Keep an opened source readable through settlement/list eviction; it is not execution state.
  useEffect(() => {
    if (!activity) return;
    setExpanded(previous => Object.fromEntries(Object.entries(previous).map(([id, old]) => [id, items.get(id) ?? old])));
  }, [activity]);
  function toggle(item: WorkbenchActivityItem) {
    const open = !!expanded[item.id] || automatic === item.id;
    if (automatic === item.id) setAutomatic(null);
    setDismissed(previous => new Set(previous).add(item.id));
    setExpanded(previous => {
      const next = { ...previous };
      if (open) delete next[item.id]; else next[item.id] = item;
      return next;
    });
  }
  const shown = more ? current : current.slice(0, 3);
  const retained = Object.values(expanded).filter(item => !items.has(item.id));
  const visibleItems = [...shown, ...current.filter(item => !shown.includes(item) && expanded[item.id]),
    ...recent.filter((item, index) => index === 0 || history || expanded[item.id] || automatic === item.id), ...retained];
  if (!current.length && !recent.length && !retained.length && !error && !activity?.omittedCurrent) return null;
  const summary = preview.item ?? retained[0] ?? null;
  return <section className={`wb-conversation-activity ${open ? "is-expanded" : "is-collapsed"}`} aria-label="Current activity">
    <div className="wb-activity-body">
    {!open && <div className="wb-activity-row wb-activity-summary">
      {summary ? <ActivityContents item={summary} retained={!items.has(summary.id)} visible={visible && !error} pulse />
        : <span className="wb-activity-description">Activity</span>}
    </div>}
    {error && <p className="wb-warning" role="alert">Activity could not be updated.
      <button className="wb-link" onClick={onRetry}>Retry</button></p>}
    <div id={contentId} hidden={!open}>
    {open && <>
    <div className="wb-activity-list">
      {visibleItems.map(item => {
        const retainedOnly = !items.has(item.id);
        const open = !!expanded[item.id] || automatic === item.id;
        return <ActivityRow key={item.id} scope={{ ...scope, runId: item.runId }} item={item}
          open={open} retained={retainedOnly} revision={revision} visible={visible && !error}
          onToggle={() => toggle(item)} />;
      })}
    </div>
    <div className="wb-activity-footer">
      {current.length > 3 && <button className="wb-link" aria-expanded={more} onClick={() => setMore(v => !v)}>
        {more ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        {more ? "Fewer activities" : `${current.length - 3} more activities`}
      </button>}
      {recent.length > 0 && <button className="wb-link" aria-expanded={history} onClick={() => setHistory(v => !v)}>
        {history ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        Recent results ({recent.length})
      </button>}
      {!!activity?.omittedCurrent && <small>{activity.omittedCurrent} additional activities not shown.</small>}
      {history && !!activity?.omittedRecent && <small>Showing only the latest retained results.</small>}
    </div>
    </>}
    </div>
    </div>
    <button type="button" className="wb-conversation-disclosure" aria-expanded={open} aria-controls={contentId}
      aria-label={open ? "Collapse activity" : "Expand activity"} title={open ? "Collapse activity" : "Expand activity"}
      onClick={() => setOpen(value => !value)}>
      {open ? <ChevronUp size={14} aria-hidden="true" /> : <ChevronDown size={14} aria-hidden="true" />}
    </button>
  </section>;
}

function ActivityContents({ item, retained, visible, pulse = false }: {
  item: WorkbenchActivityItem; retained: boolean; visible: boolean; pulse?: boolean;
}) {
  const Icon = { command: Terminal, operation: Wrench, response: MessageCircle, attention: CircleAlert }[item.kind];
  const progressing = item.state === "ongoing" && !retained && visible;
  const progressClass = progressing ? `wb-activity-progress-text${pulse ? " wb-activity-progress-pulse" : ""}` : undefined;
  return <>
    <Icon size={14} className="wb-activity-kind" />
    <span className="wb-activity-description"><span className={progressClass}>{item.title}</span>
      {item.attribution && <small>{item.attribution}</small>}
    </span>
    <span className="wb-activity-state">
      <span>{retained ? "Retained detail" : item.status}</span>
      <ElapsedTime start={item.startedAt} end={item.endedAt} ticking={!retained && visible && item.state === "ongoing"} minimumSeconds={5} />
    </span>
  </>;
}

function ActivityRow({ item, scope, open, retained, revision, visible, onToggle }: {
  item: WorkbenchActivityItem; scope: WorkbenchScope; open: boolean; retained: boolean;
  revision: number; visible: boolean; onToggle: () => void;
}) {
  const contents = <>
    <ActivityContents item={item} retained={retained} visible={visible} />
    <span className="wb-activity-disclosure" aria-hidden="true">
      {item.detail && (open ? <ChevronDown size={13} /> : <ChevronRight size={13} />)}
    </span>
  </>;
  return <article className={`wb-activity-item ${item.state}`}>
    {item.detail ? <button className="wb-activity-row" onClick={onToggle} aria-expanded={open}>{contents}</button>
      : <div className="wb-activity-row">{contents}</div>}
    {open && item.detail && <div className="wb-activity-content">
      {item.detail.kind === "command"
        ? <ActivityCommand scope={scope} executionId={item.detail.executionId} revision={revision} visible={visible} />
        : <OperationDetail scope={scope} record={{ id: item.detail.itemId, content: { kind: "tool_call" } }} revision={revision} visible={visible} />}
    </div>}
  </article>;
}

function ActivityCommand({ scope, executionId, revision, visible }: {
  scope: WorkbenchScope; executionId: string; revision: number; visible: boolean;
}) {
  const read = useRead(JSON.stringify([scope, executionId]), revision,
    () => window.helarc.readCommandDetails({ ...scope, executionId }), visible);
  const page = read.value?.status === "page" ? read.value : null;
  return <>
    {page && <details className="wb-activity-command"><summary>Command and working directory</summary>
      <pre>{page.command.command ?? "Command text unavailable"}</pre>
      <p>{page.command.shell}{page.command.cwd ? ` / ${page.command.cwd}` : ""}</p>
    </details>}
    {(read.error || read.value?.status === "rejected") && <p className="wb-warning">Command details unavailable.
      <button className="wb-link" onClick={read.refresh}>Retry</button></p>}
    <CommandOutput key={`${scope.runId}:${executionId}`} scope={scope} executionId={executionId} active={visible} compact />
  </>;
}
