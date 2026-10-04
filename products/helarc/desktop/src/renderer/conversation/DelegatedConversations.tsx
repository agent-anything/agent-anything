import * as React from "react";
import { useContext, useEffect, useId, useRef, useState } from "react";
import { ChevronDown, ChevronUp, MessageSquare, Terminal, Wrench } from "lucide-react";
import type { ConversationActivityItem, ConversationPage } from "../../shared/HelarcWorkbench.js";
import { ConversationReading, ResponseExpansions } from "./ConversationReading.js";

export type ConversationChild = NonNullable<ConversationActivityItem["child"]>;
export interface ChildReadingPosition {
  page: ConversationPage | null;
  historical: boolean;
  expandedResponses: Set<string>;
}
type ChildRenderer = (child: ConversationChild, reading: ChildReadingPosition) => React.ReactNode;

export function DelegatedConversations({items, visible, renderChild}: {
  items: readonly ConversationActivityItem[];
  visible: boolean;
  renderChild: ChildRenderer;
}) {
  const children = items.flatMap(item => item.child ? [item.child] : []);
  const positions = useRef(new Map<string, ChildReadingPosition>());
  const group = children[0]?.concurrentGroup;
  if (!children.length) return null;
  const readingFor = (runId: string) => {
    let reading = positions.current.get(runId);
    if (!reading) {
      if (positions.current.size >= 8) positions.current.delete(positions.current.keys().next().value!);
      reading = {page: null, historical: false, expandedResponses: new Set()};
      positions.current.set(runId, reading);
    }
    return reading;
  };
  return <section className="wb-child-group" aria-label={group ? "Parallel subtasks" : "Delegated work"}>
    {group && <div className="wb-child-group-heading">Parallel subtasks</div>}
    {group && children.length < group.count && <p className="wb-muted wb-child-availability">
      Conversations available for {children.length} of {group.count} requested subtasks.
    </p>}
    {children.map(child => <DelegatedBranch key={child.scope.runId} child={child} visible={visible}
      readingFor={readingFor} renderChild={renderChild} />)}
  </section>;
}

function DelegatedBranch({child, visible, renderChild, readingFor}: {
  child: ConversationChild;
  visible: boolean;
  renderChild: ChildRenderer;
  readingFor: (runId: string) => ChildReadingPosition;
}) {
  const preserve = useContext(ConversationReading);
  const navigation = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const seen = useRef(child.textRevision);
  const activityId = useRef<string | null>(null);
  const id = useId();
  useEffect(() => {
    if (open && visible) seen.current = child.textRevision;
  }, [open, visible, child.textRevision]);
  const unread = !open && child.textRevision && seen.current !== child.textRevision;
  const activities = child.activity?.items ?? [];
  const operations = activities.filter(item => item.kind !== "model");
  const candidates = operations.length ? operations : activities;
  const activity = candidates.find(item => item.id === activityId.current) ?? candidates[0];
  activityId.current = activity?.id ?? null;
  const additional = Math.max(0, (child.activity?.activeCount ?? 0) - 1);
  const Icon = activity?.kind === "command" ? Terminal : activity?.kind === "model" ? MessageSquare : Wrench;
  const reading = open && visible ? readingFor(child.scope.runId) : null;
  return <section className={`wb-child-branch${open ? " is-expanded" : ""}`} aria-label={child.displayName}>
    <div className="wb-child-navigation" ref={navigation} data-reading-anchor={`delegation:${child.scope.runId}`}>
      <strong>{child.displayName}</strong>
      <span className="wb-child-status">{child.status.replaceAll("_", " ")}</span>
      {child.textPreview?.disposition && <small className="wb-child-preview-note" title={child.textPreview.disposition}>
        {child.textPreview.disposition}
      </small>}
      {unread && <small className="wb-child-unread">New response</small>}
      {(child.textPreview?.retentionLimited || child.activity?.retentionLimited) &&
        <small className="wb-child-preview-note" title="Some response or activity content was not retained">Limited preview</small>}
      <button type="button" className="wb-child-collapse" aria-expanded={open} aria-controls={`${id}-body`}
        title={`${open ? "Collapse" : "Expand"} ${child.displayName}`}
        aria-label={`${open ? "Collapse" : "Expand"} ${child.displayName}`}
        onClick={() => { preserve(navigation.current!); setOpen(value => !value); }}>
        {open ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
      </button>
    </div>
    {!open && <div className="wb-child-compact">
      <div className={`wb-child-text-preview${child.textPreview ? "" : " is-empty"}`}
        aria-label={child.textPreview ? "Latest response excerpt" : "Delegated task"}>
        <span>{child.textPreview?.text ?? child.label}</span>
      </div>
      <div className="wb-child-activity-preview" aria-label="Current activity">
        {activity && <>
          <Icon size={13} aria-hidden="true" />
          {activity.runId !== child.scope.runId && <small>{activity.attribution}</small>}
          <span className="wb-child-activity-title" title={activity.title}>{activity.title}</span>
          {activity.status && <small className="wb-child-activity-status">{activity.status}</small>}
          {additional > 0 && <small className="wb-child-more" title={`${additional} additional activities`}>+{additional}</small>}
        </>}
      </div>
    </div>}
    {open && <div id={`${id}-body`}>
      <div className="wb-child-objective">{child.label}</div>
      {reading && <ResponseExpansions.Provider value={reading.expandedResponses}>
        {renderChild(child, reading)}
      </ResponseExpansions.Provider>}
    </div>}
  </section>;
}
