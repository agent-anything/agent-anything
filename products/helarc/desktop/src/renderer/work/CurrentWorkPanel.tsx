import * as React from "react";
import { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  Check,
  ChevronRight,
  Circle,
  FileText,
  Play,
  RefreshCw,
  Terminal,
  Wrench,
  X,
} from "lucide-react";
import type {
  HelarcActiveDelegationSnapshot,
  HelarcMainSnapshot,
} from "../../shared/HelarcDesktopApi.js";
import type {
  CurrentWorkPage,
  HelarcCommandProgress,
  HelarcPresentationValue,
  HelarcRunPresentationRecord,
  TaskSummary,
  WorkbenchScope,
  WorkHistoryPage,
} from "../../shared/HelarcWorkbench.js";
import { useRead } from "../workbench/useRead.js";
import {
  CopyButton,
  MarkdownContent,
} from "../conversation/MarkdownContent.js";
import { useResponsePreview } from "../conversation/useResponsePreview.js";
import { CommandOutput } from "./CommandOutput.js";
import { ResultLinks } from "./ResultContent.js";

type Detail =
  | { kind: "task"; scope: WorkbenchScope }
  | { kind: "command"; scope: WorkbenchScope; command: HelarcCommandProgress }
  | {
      kind: "operation";
      scope: WorkbenchScope;
      record: HelarcRunPresentationRecord;
    };
export function CurrentWorkPanel({
  snapshot,
  scope,
  currentScope,
  visible,
  onClose,
  onCurrent,
  onResume,
  onAttention,
}: {
  snapshot: HelarcMainSnapshot;
  scope: WorkbenchScope | null;
  currentScope: WorkbenchScope | null;
  visible: boolean;
  onClose: () => void;
  onCurrent: () => void;
  onResume: (value: HelarcActiveDelegationSnapshot) => void;
  onAttention: (runId: string) => void;
}) {
  const [detail, setDetail] = useState<Detail | null>(null),
    [finished, setFinished] = useState(false);
  const scopeKey = useRef("");
  const key = scope ? `${scope.threadId}:${scope.productRunId}` : "";
  scopeKey.current = key;
  const revision =
    (snapshot.activeThread?.revision ?? 0) +
    (snapshot.run?.product.presentationRevision ?? 0) +
    (snapshot.run?.host.runRevision ?? 0);
  const read = useRead(
    key,
    revision,
    () => window.helarc.readCurrentWork(scope!),
    visible,
  );
  const [expanded, setExpanded] = useState<CurrentWorkPage | null>(null);
  useEffect(() => {
    setDetail(null);
    setFinished(false);
  }, [scope?.threadId]);
  useEffect(() => {
    setExpanded(null);
  }, [key]);
  useEffect(() => {
    setExpanded(null);
  }, [read.value]);
  const page = expanded ?? (read.value?.status === "page" ? read.value : null);
  const previous =
    (detail?.scope ?? scope)?.productRunId !== currentScope?.productRunId;
  async function more(collection: "tasks" | "calls" | "commands") {
    if (!scope || !page?.nextCursors[collection]) return;
    const currentKey = key;
    let result;
    try {
      result = await window.helarc.readCurrentWork({
        ...scope,
        collection,
        cursor: page.nextCursors[collection],
      });
    } catch {
      if (currentKey === scopeKey.current) read.refresh();
      return;
    }
    if (currentKey !== scopeKey.current) return;
    if (result.status !== "page") {
      read.refresh();
      return;
    }
    const field = collection === "calls" ? "activeCalls" : collection;
    setExpanded({
      ...page,
      [field]: [...page[field], ...result[field]],
      nextCursors: {
        ...page.nextCursors,
        [collection]: result.nextCursors[collection],
      },
      omitted: { ...page.omitted, [collection]: result.omitted[collection] },
    });
  }
  function command(c: HelarcCommandProgress) {
    const owner = detail?.scope ?? scope;
    if (owner)
      setDetail({
        kind: "command",
        scope: { ...owner, runId: c.runId },
        command: c,
      });
  }
  function operation(r: HelarcRunPresentationRecord) {
    const owner = detail?.scope ?? scope;
    if (owner)
      setDetail({
        kind: "operation",
        scope: { ...owner, runId: r.runId },
        record: r,
      });
  }
  return (
    <aside className="wb-work" aria-label="Current work">
      <header className="wb-panel-header">
        <strong>{previous ? "Previous work" : "Current work"}</strong>
        <button
          className="wb-icon"
          title="Refresh work"
          aria-label="Refresh work"
          onClick={read.refresh}
        >
          <RefreshCw size={15} />
        </button>
        <button
          className="wb-icon"
          title="Close work"
          aria-label="Close work"
          onClick={onClose}
        >
          <X size={16} />
        </button>
      </header>
      <div className="wb-work-scroll">
        {previous && (
          <button
            className="wb-link"
            onClick={() => {
              setDetail(null);
              onCurrent();
            }}
          >
            <ArrowLeft size={14} />
            Back to current work
          </button>
        )}
        {detail ? (
          <>
            <button className="wb-link" onClick={() => setDetail(null)}>
              <ArrowLeft size={14} />
              Back to work
            </button>
            {detail.kind === "task" ? (
              <TaskDetail
                key={detail.scope.runId}
                scope={detail.scope}
                revision={revision}
                snapshot={snapshot}
                visible={visible}
                onOperation={operation}
                onCommand={command}
                onResume={onResume}
                onAttention={onAttention}
                onTask={(runId) =>
                  setDetail({ kind: "task", scope: { ...detail.scope, runId } })
                }
              />
            ) : detail.kind === "command" ? (
              <CommandDetail
                key={detail.command.executionId}
                scope={detail.scope}
                command={detail.command}
                revision={revision}
                visible={visible}
              />
            ) : (
              <OperationDetail
                key={detail.record.id}
                record={detail.record}
                scope={detail.scope}
                revision={revision}
              />
            )}
          </>
        ) : page && scope ? (
          <>
            <section className="wb-section">
              <h3>Now</h3>
              {page.commands.map((c) => (
                <WorkRow
                  key={c.executionId}
                  icon={<Terminal size={16} />}
                  title={c.command ?? "Shell command"}
                  status={page.live ? c.phase : "Last observed: " + c.phase}
                  attribution={taskLabel(page, c.runId)}
                  onClick={() => command(c)}
                />
              ))}
              {page.activeCalls
                .filter(
                  (r) =>
                    r.content.kind !== "tool_call" ||
                    !page.commands.some(
                      (c) =>
                        c.invocationId &&
                        r.content.kind === "tool_call" &&
                        c.invocationId === r.content.invocationId,
                    ),
                )
                .map((r) => (
                  <WorkRow
                    key={r.id}
                    icon={<Wrench size={16} />}
                    title={operationTitle(r)}
                    status={
                      page.live
                        ? page.attention.some((a) => a.runId === r.runId)
                          ? "Needs your input"
                          : "Working"
                        : "Last observed work"
                    }
                    attribution={taskLabel(page, r.runId)}
                    onClick={() => operation(r)}
                  />
                ))}
              {!page.commands.length && !page.activeCalls.length && (
                <p className="wb-muted">
                  {page.live
                    ? displayStatus(page.workStatus)
                    : page.workStatus === "inactive"
                      ? "No active work. Showing retained information."
                      : "Work ended"}
                </p>
              )}
              {page.attention.map((a) => (
                <button
                  className="wb-link"
                  key={a.request.id}
                  onClick={() => onAttention(a.runId)}
                >
                  Review / answer: {taskLabel(page, a.runId)}
                </button>
              ))}
              {(["calls", "commands"] as const).map((c) => (
                <React.Fragment key={c}>
                  {page.omitted[c] > 0 && (
                    <p className="wb-muted">Some {c} are outside this view.</p>
                  )}
                  {page.nextCursors[c] && (
                    <button className="wb-link" onClick={() => void more(c)}>
                      Show more {c}
                    </button>
                  )}
                </React.Fragment>
              ))}
            </section>
            <PlanView value={page.plan} />
            {page.tasks.length > 1 && (
              <section className="wb-section">
                <h3>Delegated tasks</h3>
                <TaskBranches
                  tasks={page.tasks}
                  parentId={page.rootRunId}
                  depth={0}
                  attention={page.attention.map((a) => a.runId)}
                  onOpen={(id) =>
                    setDetail({ kind: "task", scope: { ...scope, runId: id } })
                  }
                />
                {page.nextCursors.tasks && (
                  <button
                    className="wb-link"
                    onClick={() => void more("tasks")}
                  >
                    Show more tasks
                  </button>
                )}
                {page.omitted.tasks > 0 && (
                  <p className="wb-muted">Some tasks are outside this view.</p>
                )}
              </section>
            )}
            <ResultLinks snapshot={snapshot} artifactIds={page.artifactIds} />
            <details
              className="wb-finished"
              open={finished}
              onToggle={(e) => setFinished(e.currentTarget.open)}
            >
              <summary>Finished work</summary>
              {finished &&
                page.tasks.map((task) => (
                  <details
                    key={task.runId}
                    open={task.runId === page.rootRunId}
                  >
                    <summary>{taskLabel(page, task.runId)}</summary>
                    <WorkHistory
                      scope={{ ...scope, runId: task.runId }}
                      collection="commands"
                      revision={revision}
                      enabled={visible}
                      onCommand={command}
                      onOperation={operation}
                    />
                    <WorkHistory
                      scope={{ ...scope, runId: task.runId }}
                      collection="operations"
                      revision={revision}
                      enabled={visible}
                      onCommand={command}
                      onOperation={operation}
                    />
                  </details>
                ))}
            </details>
            <button
              className="wb-link wb-secondary"
              onClick={() => setDetail({ kind: "task", scope })}
            >
              Details
            </button>
          </>
        ) : (
          <p className="wb-muted">
            {read.error ||
              (read.value?.status === "rejected"
                ? "Work details unavailable."
                : scope
                  ? "Loading work..."
                  : "No work yet")}
          </p>
        )}
      </div>
    </aside>
  );
}
export function operationTitle(record: HelarcRunPresentationRecord): string {
  const c = record.content;
  if (c.kind !== "tool_call") return "Operation";
  const input =
    c.input && typeof c.input === "object" && !Array.isArray(c.input)
      ? (c.input as Record<string, HelarcPresentationValue>)
      : {};
  const label = ["command", "file_path", "path", "pattern", "description"]
    .map((k) => input[k])
    .find((v) => typeof v === "string");
  return label ? `${c.name}: ${label}` : c.name;
}
function taskLabel(page: CurrentWorkPage, id: string) {
  return id === page.rootRunId
    ? "Main task"
    : (page.tasks.find((t) => t.runId === id)?.label ?? "Delegated task");
}
export function displayStatus(value: string) {
  return (
    (
      {
        running: "Working",
        ready: "Working",
        waiting_for_approval: "Approval needed",
        waiting_for_input: "Needs your input",
        cancelling: "Stopping",
        completed: "Completed",
        failed: "Failed",
        cancelled: "Stopped",
        suspended: "Suspended",
      } as Record<string, string>
    )[value] ?? value.replaceAll("_", " ")
  );
}
function WorkRow({
  icon,
  title,
  status,
  attribution,
  onClick,
}: {
  icon: React.ReactNode;
  title: string;
  status: string;
  attribution?: string;
  onClick: () => void;
}) {
  return (
    <button className="wb-work-row" onClick={onClick}>
      {icon}
      <span>
        <strong>{title}</strong>
        <small>
          {attribution && `${attribution} / `}
          {displayStatus(status)}
        </small>
      </span>
      <ChevronRight size={14} />
    </button>
  );
}
function TaskBranches({
  tasks,
  parentId,
  depth,
  attention,
  onOpen,
}: {
  tasks: readonly TaskSummary[];
  parentId: string;
  depth: number;
  attention: readonly string[];
  onOpen: (id: string) => void;
}) {
  return (
    <ul className="wb-task-branches">
      {tasks
        .filter((t) => t.parentRunId === parentId)
        .map((task, index) => {
          const children = tasks.some((t) => t.parentRunId === task.runId);
          return (
            <li key={task.runId}>
              <WorkRow
                icon={<FileText size={15} />}
                title={task.label || `Task ${index + 1}`}
                status={
                  attention.includes(task.runId)
                    ? "Needs your input"
                    : task.status
                }
                onClick={() => onOpen(task.runId)}
              />
              {children && depth < 3 && (
                <details open={depth === 0}>
                  <summary>Subtasks</summary>
                  <TaskBranches
                    tasks={tasks}
                    parentId={task.runId}
                    depth={depth + 1}
                    attention={attention}
                    onOpen={onOpen}
                  />
                </details>
              )}
              {children && depth >= 3 && (
                <button className="wb-link" onClick={() => onOpen(task.runId)}>
                  View subtasks
                </button>
              )}
            </li>
          );
        })}
    </ul>
  );
}
export function PlanView({ value }: { value: HelarcPresentationValue }) {
  const plan = value as {
    steps?: { description?: string; title?: string; status?: string }[];
  } | null;
  const [showCompleted, setShowCompleted] = useState(false);
  if (!plan?.steps?.length) return null;
  const completed = plan.steps.filter((s) => s.status === "completed").length;
  return (
    <section className="wb-section">
      <h3>
        Plan{" "}
        <span>
          {completed} of {plan.steps.length}
        </span>
      </h3>
      <ol className="wb-plan">
        {plan.steps.map((step, i) =>
          plan.steps!.length > 6 &&
          step.status === "completed" &&
          !showCompleted ? null : (
            <li key={i} className={step.status}>
              {step.status === "completed" ? (
                <Check size={15} />
              ) : step.status === "in_progress" ? (
                <Play size={15} />
              ) : (
                <Circle size={13} />
              )}
              <span>
                {step.description ?? step.title}
                <small>{step.status?.replaceAll("_", " ")}</small>
              </span>
            </li>
          ),
        )}
      </ol>
      {plan.steps.length > 6 && completed > 0 && (
        <button className="wb-link" onClick={() => setShowCompleted((v) => !v)}>
          {showCompleted ? "Hide" : "Show"} completed steps
        </button>
      )}
    </section>
  );
}
function TaskDetail({
  scope,
  revision,
  snapshot,
  visible,
  onOperation,
  onCommand,
  onResume,
  onAttention,
  onTask,
}: {
  scope: WorkbenchScope;
  revision: number;
  snapshot: HelarcMainSnapshot;
  visible: boolean;
  onOperation: (r: HelarcRunPresentationRecord) => void;
  onCommand: (c: HelarcCommandProgress) => void;
  onResume: (d: HelarcActiveDelegationSnapshot) => void;
  onAttention: (id: string) => void;
  onTask: (id: string) => void;
}) {
  const read = useRead(
    JSON.stringify(scope),
    revision,
    () => window.helarc.readTaskDetails(scope),
    visible,
  );
  const page = read.value?.status === "page" ? read.value : null;
  const currentRead = useRead(
    JSON.stringify([scope, "work"]),
    revision,
    () => window.helarc.readCurrentWork(scope),
    visible,
  );
  const work = currentRead.value?.status === "page" ? currentRead.value : null;
  const preview = useResponsePreview(scope, !!page?.live, revision);
  const delegation = page?.live
    ? snapshot.run?.host.activeDelegations.find(
        (d) => d.child.id === scope.runId,
      )
    : null;
  return (
    <div className="wb-task-detail">
      {page && (
        <>
          <h2>{page.task.label}</h2>
          <p>{page.task.objective}</p>
          <p className="wb-muted">{displayStatus(page.task.status)}</p>
          {page.task.terminalCode && (
            <p className="wb-warning">{page.task.terminalCode}</p>
          )}
          {snapshot.run?.host.pendingInteractions.some(
            (i) => i.runId === scope.runId,
          ) && (
            <button
              className="wb-link"
              onClick={() => onAttention(scope.runId)}
            >
              Review / answer
            </button>
          )}
          {delegation?.suspension && (
            <button className="wb-link" onClick={() => onResume(delegation)}>
              Resume task
            </button>
          )}
          {work && (
            <>
              <TaskBranches
                tasks={work.tasks}
                parentId={scope.runId}
                depth={0}
                attention={work.attention.map((a) => a.runId)}
                onOpen={onTask}
              />
              {work.commands
                .filter((c) => c.runId === scope.runId)
                .map((c) => (
                  <WorkRow
                    key={c.executionId}
                    icon={<Terminal size={15} />}
                    title={c.command ?? "Command"}
                    status={page.live ? c.phase : "Last observed: " + c.phase}
                    onClick={() => onCommand(c)}
                  />
                ))}
            </>
          )}
          <PlanView value={page.plan} />
          <ResultLinks snapshot={snapshot} artifactIds={page.artifactIds} />
          <WorkHistory
            scope={scope}
            revision={revision}
            collection="assistant"
            enabled={visible}
            onOperation={onOperation}
            onCommand={onCommand}
          />
          {preview.attempts
            .filter((a) => a.state !== "committed")
            .map((a) => (
              <div key={a.invocationId}>
                {a.parts
                  .filter((p) => p.kind === "text" && p.text)
                  .map((p) => (
                    <div key={p.id}>
                      <small>{a.state} response</small>
                      <MarkdownContent text={p.text} />
                    </div>
                  ))}
              </div>
            ))}
          <WorkHistory
            scope={scope}
            revision={revision}
            collection="commands"
            enabled={visible}
            onOperation={onOperation}
            onCommand={onCommand}
          />
          <WorkHistory
            scope={scope}
            revision={revision}
            collection="operations"
            enabled={visible}
            onOperation={onOperation}
            onCommand={onCommand}
          />
          <details className="wb-secondary">
            <summary>Technical details</summary>
            <pre>
              {JSON.stringify(
                {
                  identity: scope.runId,
                  retry: page.retries,
                  ...(page.diagnostics as object),
                },
                null,
                2,
              )}
            </pre>
          </details>
        </>
      )}
      {(read.error || read.value?.status === "rejected") && (
        <button className="wb-link" onClick={read.refresh}>
          Task unavailable. Reload
        </button>
      )}
    </div>
  );
}
function WorkHistory({
  scope,
  collection,
  revision,
  enabled,
  onCommand,
  onOperation,
}: {
  scope: WorkbenchScope;
  collection: WorkHistoryPage["collection"];
  revision: number;
  enabled: boolean;
  onCommand: (c: HelarcCommandProgress) => void;
  onOperation: (r: HelarcRunPresentationRecord) => void;
}) {
  const [cursor, setCursor] = useState<string | null>(null);
  const read = useRead(
    JSON.stringify([scope, collection, cursor]),
    cursor ? 0 : revision,
    () => window.helarc.readWorkHistory({ ...scope, collection, cursor }),
    enabled,
  );
  const page = read.value?.status === "page" ? read.value : null;
  return (
    <div className="wb-history">
      {page?.commands.map((c) => (
        <WorkRow
          key={c.executionId}
          icon={<Terminal size={15} />}
          title={c.command ?? "Shell command"}
          status={c.outcome ?? c.phase}
          onClick={() => onCommand(c)}
        />
      ))}
      {page?.records.map((r) =>
        r.content.kind === "assistant_text" ? (
          <div key={r.id}>
            <MarkdownContent text={r.content.text} />
            {r.content.omittedBytes > 0 && (
              <button className="wb-link" onClick={() => onOperation(r)}>
                Read retained text
              </button>
            )}
          </div>
        ) : (
          <WorkRow
            key={r.id}
            icon={<Wrench size={15} />}
            title={operationTitle(r)}
            status={
              r.content.kind === "tool_call"
                ? (r.content.settlement ?? "Recorded")
                : "Recorded"
            }
            onClick={() => onOperation(r)}
          />
        ),
      )}
      {!!page?.omittedRecords && (
        <p className="wb-muted">Earlier work is not fully retained.</p>
      )}
      {page?.previousCursor && (
        <button
          className="wb-link"
          onClick={() => setCursor(page.previousCursor)}
        >
          Earlier {collection}
        </button>
      )}
      {cursor && (
        <button className="wb-link" onClick={() => setCursor(null)}>
          Latest {collection}
        </button>
      )}
      {(read.error || read.value?.status === "rejected") && (
        <button
          className="wb-link"
          onClick={() => {
            setCursor(null);
            read.refresh();
          }}
        >
          History unavailable. Reload
        </button>
      )}
    </div>
  );
}
function CommandDetail({
  scope,
  command,
  revision,
  visible,
}: {
  scope: WorkbenchScope;
  command: HelarcCommandProgress;
  revision: number;
  visible: boolean;
}) {
  const read = useRead(
    JSON.stringify([scope, command.executionId]),
    revision,
    () =>
      window.helarc.readCommandDetails({
        ...scope,
        executionId: command.executionId,
      }),
    visible,
  );
  const c = read.value?.status === "page" ? read.value.command : null;
  return (
    <section className="wb-command">
      <h2>Command</h2>
      {c ? (
        <>
          <CopyButton text={c.command ?? ""} />
          <pre className="wb-command-text">{c.command}</pre>
          <div className="wb-command-meta">
            <span>{c.shell}</span>
            <span>{c.cwd}</span>
            <span>
              {c.outcome ??
                (read.value?.status === "page" && !read.value.live
                  ? "Last observed: "
                  : "") + c.phase}
            </span>
          </div>
          <CommandOutput
            scope={scope}
            executionId={c.executionId}
            active={visible}
          />
          <details className="wb-secondary">
            <summary>Details</summary>
            <pre>
              {JSON.stringify(
                {
                  exitCode: c.exitCode,
                  started: c.startedAt,
                  completed: c.completedAt,
                  output: c.outputPersistence,
                },
                null,
                2,
              )}
            </pre>
          </details>
        </>
      ) : (
        <p className="wb-muted">
          {read.error || read.value?.status === "rejected"
            ? "Command unavailable."
            : "Loading command..."}
        </p>
      )}
    </section>
  );
}
function OperationDetail({
  scope,
  record,
  revision,
}: {
  scope: WorkbenchScope;
  record: HelarcRunPresentationRecord;
  revision: number;
}) {
  const [offset, setOffset] = useState(0);
  const read = useRead(
    JSON.stringify([scope, record.id, offset]),
    revision,
    () =>
      window.helarc.readWorkbenchItem({ ...scope, itemId: record.id, offset }),
  );
  return (
    <section>
      <h2>{operationTitle(record)}</h2>
      {read.value?.status === "page" ? (
        <>
          <CopyButton text={read.value.text} />
          <pre>{read.value.text}</pre>
          {read.value.nextOffset !== null && (
            <button
              className="wb-link"
              onClick={() =>
                setOffset(
                  read.value?.status === "page" ? read.value.nextOffset! : 0,
                )
              }
            >
              Next content page
            </button>
          )}
        </>
      ) : (
        <pre>{JSON.stringify(record.content, null, 2)}</pre>
      )}
    </section>
  );
}
