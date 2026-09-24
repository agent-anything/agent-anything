import * as React from "react";
import { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ChevronRight,
  FileText,
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
import { PlanView } from "../plan/PlanView.js";
import { OperationDetail } from "./OperationDetail.js";
import { isFinishedTask, selectWorkTasks, type WorkTaskGroup } from "./WorkTaskGroups.js";

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
  const currentTasks = selectWorkTasks(page?.tasks ?? [], "current");
  const finishedTasks = selectWorkTasks(page?.tasks ?? [], "finished");
  const hasCurrentActivity =
    !!page &&
    (page.commands.length > 0 ||
      page.activeCalls.length > 0 ||
      page.attention.length > 0 ||
      currentTasks.tasks.length > 0 ||
      page.omitted.calls > 0 ||
      page.omitted.commands > 0 ||
      !!page.nextCursors.calls ||
      !!page.nextCursors.commands);
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
        <div className="wb-work-heading">
          <strong>{previous ? "Previous work" : "Current work"}</strong>
          {page && !detail && !read.error && page.workStatus !== "running" && page.workStatus !== "ready" && (
            <span
              className={`wb-status ${page.workStatus}`}
              aria-label="Work status"
            >
              {page.workStatus === "inactive"
                ? "Not active"
                : displayStatus(page.workStatus)}
            </span>
          )}
        </div>
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
        {read.error && (
          <div role="alert">
            <p className="wb-warning">{read.error}</p>
            <button className="wb-link" onClick={read.refresh}>
              Retry
            </button>
          </div>
        )}
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
                onTask={(runId) => setDetail({ kind: "task", scope: { ...detail.scope, runId } })}
              />
            )}
          </>
        ) : page && scope ? (
          <>
            <section className="wb-section" aria-label="Ongoing work" hidden={!hasCurrentActivity}>
              <TaskBranches
                tasks={currentTasks.tasks}
                members={currentTasks.members}
                group="current"
                parentId={null}
                depth={0}
                attention={page.attention.map((a) => a.runId)}
                onOpen={(id) =>
                  setDetail({ kind: "task", scope: { ...scope, runId: id } })
                }
              />
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
            <details
              className="wb-finished"
              open={finished}
              onToggle={(e) => setFinished(e.currentTarget.open)}
            >
              <summary>Finished work</summary>
              {finished && <>
                <TaskBranches
                  tasks={finishedTasks.tasks}
                  members={finishedTasks.members}
                  group="finished"
                  parentId={null}
                  depth={0}
                  attention={[]}
                  onOpen={(runId) => setDetail({ kind: "task", scope: { ...scope, runId } })}
                />
                <WorkHistory
                  scope={{ ...scope, runId: page.rootRunId }}
                  collection="commands"
                  revision={revision}
                  enabled={visible}
                  onCommand={command}
                  onOperation={operation}
                />
                <WorkHistory
                  scope={{ ...scope, runId: page.rootRunId }}
                  collection="operations"
                  revision={revision}
                  enabled={visible}
                  onCommand={command}
                  onOperation={operation}
                />
                <ResultLinks snapshot={snapshot} artifactIds={page.artifactIds} />
              </>}
            </details>
            {page.nextCursors.tasks && (
              <button className="wb-link" onClick={() => void more("tasks")}>Show more tasks</button>
            )}
            {page.omitted.tasks > 0 && <p className="wb-muted">Some tasks are outside this view.</p>}
          </>
        ) : !read.error ? (
          <p className="wb-muted">
            {read.value?.status === "rejected"
              ? "Work details unavailable."
              : scope
                ? "Loading work..."
                : "No work yet"}
          </p>
        ) : null}
      </div>
    </aside>
  );
}
export function operationTitle(record: HelarcRunPresentationRecord): string {
  const c = record.content;
  return c.kind === "tool_call" ? c.title : "Response";
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
  members,
  group,
}: {
  tasks: readonly TaskSummary[];
  parentId: string | null;
  depth: number;
  attention: readonly string[];
  onOpen: (id: string) => void;
  members?: ReadonlySet<string>;
  group?: WorkTaskGroup;
}) {
  return (
    <ul className="wb-task-branches">
      {tasks
        .filter((t) => t.parentRunId === parentId)
        .map((task, index) => {
          const children = tasks.some((t) => t.parentRunId === task.runId);
          const mainTask = task.parentRunId === null;
          const contextOnly = members !== undefined && !members.has(task.runId);
          return (
            <li key={task.runId}>
              {contextOnly ? <button className="wb-task-context" onClick={() => onOpen(task.runId)}>
                {task.label}<small>{mainTask ? "Main task" : "Parent task"} / {displayStatus(task.status)}</small>
              </button> : <WorkRow
                icon={<FileText size={15} />}
                title={task.label || `Task ${index + 1}`}
                attribution={mainTask ? "Main task" : undefined}
                status={
                  group === "finished" && !isFinishedTask(task)
                    ? "Earlier operations"
                    : attention.includes(task.runId)
                    ? "Needs your input"
                    : task.status
                }
                onClick={() => onOpen(task.runId)}
              />}
              {children && mainTask && (
                <TaskBranches
                  tasks={tasks}
                  parentId={task.runId}
                  depth={depth}
                  attention={attention}
                  onOpen={onOpen}
                  members={members}
                  group={group}
                />
              )}
              {children && !mainTask && depth < 3 && (
                <details open={depth === 0}>
                  <summary>Subtasks</summary>
                  <TaskBranches
                    tasks={tasks}
                    parentId={task.runId}
                    depth={depth + 1}
                    attention={attention}
                    onOpen={onOpen}
                    members={members}
                    group={group}
                  />
                </details>
              )}
              {children && !mainTask && depth >= 3 && (
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
  const subtask = page?.task.parentRunId != null;
  const commands = work?.commands.filter(c => c.runId === scope.runId) ?? [];
  const calls = work?.activeCalls.filter(r => r.runId === scope.runId &&
    (r.content.kind !== "tool_call" || !commands.some(c =>
      c.invocationId && r.content.kind === "tool_call" && c.invocationId === r.content.invocationId))) ?? [];
  const hasSubtasks = work?.tasks.some(t => t.parentRunId === scope.runId);
  const previewAttempts = preview.attempts.filter(a => a.state !== "committed" &&
    a.parts.some(p => p.kind === "text" && p.text));
  const artifactIds = page?.artifactIds.filter(id => snapshot.activeThread?.artifacts.some(a =>
    a.id === id && a.kind !== "final-output")) ?? [];
  return (
    <div className="wb-task-detail">
      {page && (
        <>
          <header className="wb-task-heading">
            <small>{subtask ? "Subtask" : "Main task"}</small>
            <h2>{page.task.label}</h2>
            <span className={`wb-status ${page.task.status}`}>{displayStatus(page.task.status)}</span>
          </header>
          {!subtask && page.task.objective && page.task.objective !== page.task.label && (
            <details className="wb-task-request">
              <summary>Request</summary><p>{page.task.objective}</p>
            </details>
          )}
          {page.problem && (
            <section className="wb-task-problem" aria-label="Problem">
              <h3>Problem</h3><p>{page.problem.message}</p>
              {page.problem.code && <details className="wb-secondary"><summary>Reference code</summary>
                <code>{page.problem.code}</code></details>}
            </section>
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
          {hasSubtasks && work && (
            <section className="wb-task-section" aria-label="Subtasks">
              <h3>Subtasks</h3>
              <TaskBranches
                tasks={work.tasks}
                parentId={scope.runId}
                depth={0}
                attention={work.attention.map((a) => a.runId)}
                onOpen={onTask}
              />
            </section>
          )}
          {(commands.length > 0 || calls.length > 0) && (
            <section className="wb-task-section" aria-label="In progress">
              <h3>{page.live ? "In progress" : "Last observed work"}</h3>
              {commands.map((c) => (
                  <WorkRow
                    key={c.executionId}
                    icon={<Terminal size={15} />}
                    title={c.command ?? "Command"}
                    status={page.live ? c.phase : "Last observed: " + c.phase}
                    onClick={() => onCommand(c)}
                  />
                ))}
              {calls.map(r => <WorkRow key={r.id} icon={<Wrench size={15} />}
                title={operationTitle(r)} status={page.live ? "In progress" : "Last observed work"}
                onClick={() => onOperation(r)} />)}
            </section>
          )}
          {(currentRead.error || currentRead.value?.status === "rejected") &&
            <button className="wb-link" onClick={currentRead.refresh}>Current work unavailable. Retry</button>}
          <PlanView value={page.plan} />
          {artifactIds.length > 0 && <section className="wb-task-section" aria-label="Outputs">
            <h3>Outputs</h3><ResultLinks snapshot={snapshot} artifactIds={artifactIds} />
          </section>}
          <WorkHistory
            title={subtask ? "Subtask findings and updates" : "Responses"}
            scope={scope}
            revision={revision}
            collection="assistant"
            enabled={visible}
            onOperation={onOperation}
            onCommand={onCommand}
          >
          {previewAttempts.length > 0 ? previewAttempts.map((a) => (
              <div key={a.invocationId} className="wb-task-response">
                {a.parts
                  .filter((p) => p.kind === "text" && p.text)
                  .map((p) => (
                    <div key={p.id}>
                      <small>{a.state.replaceAll("_", " ")} response</small>
                      <MarkdownContent text={p.text} />
                    </div>
                  ))}
              </div>
            )) : null}
          </WorkHistory>
          <WorkHistory
            title="Earlier commands"
            collapsible
            scope={scope}
            revision={revision}
            collection="commands"
            enabled={visible}
            onOperation={onOperation}
            onCommand={onCommand}
          />
          <WorkHistory
            title="Earlier operations"
            collapsible
            scope={scope}
            revision={revision}
            collection="operations"
            enabled={visible}
            onOperation={onOperation}
            onCommand={onCommand}
          />
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
  title,
  collapsible = false,
  children,
  scope,
  collection,
  revision,
  enabled,
  onCommand,
  onOperation,
}: {
  title?: string;
  collapsible?: boolean;
  children?: React.ReactNode;
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
  if (title && page && !read.error && !page.commands.length && !page.records.length &&
      !page.omittedRecords && !page.previousCursor && !cursor && !children) return null;
  const content = (
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
      {children}
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
  if (!title) return content;
  return collapsible ? <details className="wb-task-history">
    <summary>{title}</summary>{content}
  </details> : <section className="wb-task-section" aria-label={title}>
    <h3>{title}</h3>{content}
  </section>;
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
