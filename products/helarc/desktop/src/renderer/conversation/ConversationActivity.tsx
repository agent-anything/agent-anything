import * as React from "react";
import { useId, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Terminal,
  Wrench,
} from "lucide-react";
import type {
  ConversationActivityItem,
  WorkbenchScope,
} from "../../shared/HelarcWorkbench.js";
import { CommandOutput } from "../work/CommandOutput.js";
import { OperationDetail } from "../work/OperationDetail.js";
import { useRead } from "../workbench/useRead.js";
import { ElapsedTime } from "../workbench/ElapsedTime.js";
import { useConversationCapacity } from "./ConversationReadingBudget.js";

/** A group belongs to one contiguous set of calls in one model response. */
export function ConversationActivity({
  scope,
  items,
  revision,
  visible,
  renderChild,
}: {
  scope: WorkbenchScope;
  items: readonly ConversationActivityItem[];
  revision: number;
  visible: boolean;
  renderChild: (
    child: NonNullable<ConversationActivityItem["child"]>,
  ) => React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const contentId = useId();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const count = useConversationCapacity(
    "rows",
    open ? items.length : Math.min(1, items.length),
  );
  const current = items.filter(
    (i) =>
      i.state === "ongoing" ||
      (i.child?.relationship === "created" &&
        !["completed", "failed", "cancelled", "inactive"].includes(
          i.child.status,
        )),
  );
  const summary = current[0] ?? items.at(-1);
  if (!summary) return null;
  if (!count)
    return (
      <p className="wb-muted">
        More activity is retained. Collapse other activity groups to show it.
      </p>
    );
  return (
    <section
      className={`wb-conversation-activity ${open ? "is-expanded" : "is-collapsed"}`}
      aria-label="Response activity"
    >
      <div className="wb-activity-body">
        {!open && (
          <div className="wb-activity-row wb-activity-summary">
            <ActivityContents item={summary} visible={visible} pulse />
            {items.length > 1 && (
              <small className="wb-activity-count">
                {current.length ? `${current.length} active / ` : ""}
                {items.length} operations
              </small>
            )}
          </div>
        )}
        <div id={contentId} hidden={!open}>
          {open &&
            items.slice(0, count).map((item) => {
              const expandedItem = expanded.has(item.id);
              return (
                <article
                  className={`wb-activity-item ${item.state}`}
                  key={item.id}
                >
                  <button
                    className="wb-activity-row"
                    onClick={() =>
                      setExpanded((previous) => {
                        const next = new Set(previous);
                        if (next.has(item.id)) next.delete(item.id);
                        else next.add(item.id);
                        return next;
                      })
                    }
                    aria-expanded={expandedItem}
                  >
                    <ActivityContents item={item} visible={visible} />
                    <span className="wb-activity-disclosure" aria-hidden="true">
                      {expandedItem ? (
                        <ChevronDown size={13} />
                      ) : (
                        <ChevronRight size={13} />
                      )}
                    </span>
                  </button>
                  {expandedItem && (
                    <div className="wb-activity-content">
                      {item.detail?.kind === "command" ? (
                        <ActivityCommand
                          key={item.detail.executionId}
                          scope={scope}
                          executionId={item.detail.executionId}
                          revision={revision}
                          visible={visible}
                        />
                      ) : item.child ? (
                        <>
                          <p className="wb-muted">
                            {item.child.relationship === "created"
                              ? "Delegated work"
                              : "Related delegated work"}
                            : {item.child.status.replaceAll("_", " ")}
                          </p>
                          {renderChild(item.child)}
                        </>
                      ) : item.detail?.kind === "operation" ? (
                        <OperationDetail
                          scope={scope}
                          record={{
                            id: item.detail.itemId,
                            content: { kind: "tool_call" },
                          }}
                          revision={revision}
                          visible={visible}
                        />
                      ) : (
                        <p className="wb-muted">Details no longer retained.</p>
                      )}
                    </div>
                  )}
                </article>
              );
            })}
        </div>
        {open && count < items.length && (
          <p className="wb-muted">
            More operations are retained. Collapse other activity groups to show
            them.
          </p>
        )}
      </div>
      <button
        className="wb-conversation-disclosure"
        type="button"
        aria-expanded={open}
        aria-controls={contentId}
        title={open ? "Collapse activity" : "Expand activity"}
        aria-label={open ? "Collapse activity" : "Expand activity"}
        onClick={() => setOpen((v) => !v)}
      >
        {open ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
      </button>
    </section>
  );
}

function ActivityContents({
  item,
  visible,
  pulse = false,
}: {
  item: ConversationActivityItem;
  visible: boolean;
  pulse?: boolean;
}) {
  const Icon = item.kind === "command" ? Terminal : Wrench;
  const active =
    visible &&
    (item.state === "ongoing" ||
      (item.child?.relationship === "created" &&
        !["completed", "failed", "cancelled", "inactive"].includes(
          item.child.status,
        )));
  return (
    <>
      <Icon size={14} className="wb-activity-kind" />
      <span className="wb-activity-description">
        <span
          className={
            active
              ? `wb-activity-progress-text${pulse ? " wb-activity-progress-pulse" : ""}`
              : undefined
          }
        >
          {item.title}
        </span>
      </span>
      <span className="wb-activity-state">
        <span>
          {item.child?.relationship === "created"
            ? item.child.status.replaceAll("_", " ")
            : item.status}
        </span>
        <ElapsedTime
          start={item.startedAt}
          end={item.endedAt}
          ticking={visible && item.state === "ongoing"}
          minimumSeconds={5}
        />
      </span>
    </>
  );
}

function ActivityCommand({
  scope,
  executionId,
  revision,
  visible,
}: {
  scope: WorkbenchScope;
  executionId: string;
  revision: number;
  visible: boolean;
}) {
  const read = useRead(
    JSON.stringify([scope, executionId]),
    revision,
    () => window.helarc.readCommandDetails({ ...scope, executionId }),
    visible,
  );
  const page = read.value?.status === "page" ? read.value : null;
  return (
    <>
      {page && (
        <details className="wb-activity-command">
          <summary>Command and working directory</summary>
          <pre>{page.command.command ?? "Command text unavailable"}</pre>
          <p>
            {page.command.shell}
            {page.command.cwd ? ` / ${page.command.cwd}` : ""}
          </p>
        </details>
      )}
      {(read.error || read.value?.status === "rejected") && (
        <p className="wb-warning">
          Command details unavailable.{" "}
          <button className="wb-link" onClick={read.refresh}>
            Retry
          </button>
        </p>
      )}
      <CommandOutput
        scope={scope}
        executionId={executionId}
        active={visible}
        compact
      />
    </>
  );
}
