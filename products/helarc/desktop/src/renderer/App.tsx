import {
  Activity,
  AlertCircle,
  CheckCircle2,
  CircleStop,
  Boxes,
  FileCode2,
  FolderOpen,
  GitBranch,
  History,
  MessageSquareText,
  Play,
  Settings,
  ShieldCheck,
} from "lucide-react";
import * as React from "react";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import type {
  HelarcMainSnapshot,
  HelarcModelUsePolicy,
  HelarcProviderKind,
  HelarcStartRunResult,
} from "../shared/HelarcDesktopApi.js";
import {
  HELARC_DEFAULT_OLLAMA_RUNTIME_PROFILE,
  HELARC_DEFAULT_PROVIDER_SETTINGS,
} from "../shared/HelarcDesktopApi.js";

const initialSnapshot: HelarcMainSnapshot = {
  status: "idle",
  workspace: null,
  workspaceProfiles: [],
  taskTemplates: [],
  provider: {
    configured: false,
    nativeToolInteraction: { supported: false },
    activeProfile: null,
    profiles: [],
    error: {
      code: "provider_config_missing",
      message: "Provider configuration is incomplete.",
    },
  },
  acceptedTask: null,
  activeThread: null,
  threadSummaries: [],
  run: null,
  error: null,
};

type ActiveRunProjection = NonNullable<HelarcMainSnapshot["run"]>;
type PendingInteractionView = ActiveRunProjection["host"]["pendingInteractions"][number];
type PendingApprovalView = Extract<PendingInteractionView, { family: "approval" }>;
type PendingClarificationView = Extract<PendingInteractionView, { family: "clarification" }>;

type SidePanelMode = "review" | "threads" | "settings";

export function App() {
  const [snapshot, setSnapshot] = useState<HelarcMainSnapshot>(initialSnapshot);
  const [taskText, setTaskText] = useState("");
  const [steeringText, setSteeringText] = useState("");
  const [isBusy, setIsBusy] = useState(false);
  const [startResult, setStartResult] = useState<HelarcStartRunResult | null>(null);
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [sidePanelMode, setSidePanelMode] = useState<SidePanelMode>("review");
  const [interactionSubmissionError, setInteractionSubmissionError] = useState<string | null>(null);
  const [runControlError, setRunControlError] = useState<string | null>(null);
  const pendingApproval = getPendingApproval(snapshot.run);
  const pendingClarification = getPendingClarification(snapshot.run);
  const runActive = isRunActive(snapshot.status);
  const selectedThread = snapshot.threadSummaries.find((thread) => thread.id === selectedThreadId) ?? null;
  const activePanelMode: SidePanelMode = pendingApproval || pendingClarification
    ? "review"
    : sidePanelMode;

  useEffect(() => {
    const api = getHelarcApi();
    if (!api) {
      return;
    }

    void api.getSnapshot().then(setSnapshot);
    return api.subscribeSnapshot(setSnapshot);
  }, []);

  const canStart = useMemo(
    () => Boolean(
      snapshot.workspace
      && snapshot.provider.configured
      && taskText.trim().length > 0
      && !isBusy
      && !runActive
    ),
    [isBusy, runActive, snapshot.provider.configured, snapshot.workspace, taskText],
  );
  const canSteer = Boolean(
    snapshot.run &&
    runActive &&
    snapshot.run.display.status !== "cancelling" &&
    steeringText.trim().length > 0 &&
    !isBusy
  );

  async function chooseWorkspace() {
    const api = getHelarcApi();
    if (!api) {
      return;
    }

    setIsBusy(true);
    try {
      const receipt = await api.chooseWorkspace({
        commandId: createCommandId("workspace.choose"),
      });
      if (receipt.status === "handled") {
        setSnapshot(receipt.result);
        setStartResult(null);
        setSelectedThreadId(null);
      }
    } finally {
      setIsBusy(false);
    }
  }

  async function selectWorkspaceProfile(profileId: string) {
    const api = getHelarcApi();
    if (!api || profileId.length === 0) {
      return;
    }

    setIsBusy(true);
    try {
      const receipt = await api.selectWorkspaceProfile({
        commandId: createCommandId("workspace.select"),
        profileId,
      });
      if (receipt.status === "handled") {
        setSnapshot(receipt.result);
        setStartResult(null);
        setSelectedThreadId(null);
      }
    } finally {
      setIsBusy(false);
    }
  }

  async function openThread(threadId: string) {
    const api = getHelarcApi();
    if (!api || threadId.length === 0) {
      return;
    }
    setIsBusy(true);
    try {
      const receipt = await api.openThread({
        commandId: createCommandId("thread.open"),
        threadId,
      });
      if (receipt.status === "handled") {
        setSelectedThreadId(threadId);
        setSnapshot(receipt.result.snapshot);
      }
    } finally {
      setIsBusy(false);
    }
  }

  async function startRun(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const api = getHelarcApi();
    if (!api || !canStart) {
      return;
    }

    setIsBusy(true);
    try {
      const receipt = await api.startRun({
        commandId: createCommandId("run.start"),
        taskText,
        target: snapshot.activeThread === null
          ? { kind: "new_thread" }
          : {
              kind: "continue_thread",
              threadId: snapshot.activeThread.id,
            },
      });
      if (receipt.status === "handled") {
        setStartResult(receipt.result);
        setSnapshot(receipt.result.snapshot);
        if (receipt.result.ok) {
          setSelectedThreadId(receipt.result.threadId);
        }
      }
    } finally {
      setIsBusy(false);
    }
  }

  function applyTaskTemplate(templateId: string) {
    const template = snapshot.taskTemplates.find((item) => item.id === templateId);
    if (!template) {
      return;
    }

    setTaskText(renderTaskTemplatePrompt(template.promptText, template.defaultConstraints));
    setStartResult(null);
  }

  async function submitApprovalDecision(
    option: PendingApprovalView["presentation"]["decisionOptions"][number],
  ) {
    const api = getHelarcApi();
    const runId = snapshot.run?.harnessRunId;
    if (!api || !runId || !pendingApproval || pendingApproval.phase !== "pending") {
      return;
    }

    setIsBusy(true);
    try {
      const submissionId = `helarc-desktop-${crypto.randomUUID()}`;
      const response = await api.submitInteraction({
        commandId: createCommandId("interaction.submit"),
        submissionId,
        runId,
        request: pendingApproval.request,
        payload: {
          submissionId,
          runId: pendingApproval.presentation.runId,
          requestId: pendingApproval.request.id,
          pendingVersion: pendingApproval.request.requestVersion,
          optionId: option.id,
          grantedPermissions: defaultGrantedPermissions(pendingApproval, option.kind),
          reason: option.kind === "decline"
            ? "Declined from Helarc desktop."
            : option.kind === "cancel"
              ? "Cancelled from Helarc desktop."
              : null,
        },
      });
      setSnapshot(response.snapshot);
      setInteractionSubmissionError(
        response.receipt.status === "rejected"
          ? response.receipt.code
          : response.receipt.kind === "interaction.submit" &&
              response.receipt.result.status === "rejected"
            ? response.receipt.result.code
            : null,
      );
    } finally {
      setIsBusy(false);
    }
  }

  async function submitClarificationAnswers(
    answers: readonly {
      readonly question_id: string;
      readonly selected_labels: readonly string[];
      readonly text: string | null;
    }[],
  ) {
    const api = getHelarcApi();
    const runId = snapshot.run?.harnessRunId;
    if (!api || !runId || !pendingClarification || pendingClarification.phase !== "pending") {
      return;
    }
    setIsBusy(true);
    try {
      const submissionId = `helarc-desktop-${crypto.randomUUID()}`;
      const response = await api.submitInteraction({
        commandId: createCommandId("interaction.clarification"),
        submissionId,
        runId,
        request: pendingClarification.request,
        payload: { answers },
      });
      setSnapshot(response.snapshot);
      setInteractionSubmissionError(
        response.receipt.status === "rejected"
          ? response.receipt.code
          : response.receipt.kind === "interaction.submit" &&
              response.receipt.result.status === "rejected"
            ? response.receipt.result.code
            : null,
      );
    } finally {
      setIsBusy(false);
    }
  }

  async function steerRun(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const api = getHelarcApi();
    const run = snapshot.run;
    if (!api || !run || !canSteer) return;

    setIsBusy(true);
    try {
      const response = await api.steerRun({
        commandId: createCommandId("run.steer"),
        runId: run.harnessRunId,
        expectedRunRevision: run.host.runRevision,
        instruction: steeringText,
      });
      setSnapshot(response.snapshot);
      const error = response.receipt.status === "rejected"
        ? response.receipt.code
        : response.receipt.kind === "run.steer" && response.receipt.result.status === "rejected"
          ? response.receipt.result.code
          : null;
      setRunControlError(error);
      if (error === null) setSteeringText("");
    } finally {
      setIsBusy(false);
    }
  }

  async function cancelRun() {
    const api = getHelarcApi();
    const runId = snapshot.run?.harnessRunId;
    if (!api || !runId) {
      return;
    }

    setIsBusy(true);
    try {
      const response = await api.cancelRun({
        commandId: createCommandId("run.cancel"),
        runId,
        reason: "Cancelled from Helarc desktop.",
      });
      setSnapshot(response.snapshot);
    } finally {
      setIsBusy(false);
    }
  }

  const workspaceLabel = snapshot.workspace
    ? snapshot.workspace.path
    : "No workspace selected";
  const statusText = statusLabel(snapshot.status, snapshot.provider.configured);
  const canCancelRun = snapshot.run !== null &&
    isRunCancellable(snapshot.run.display.status) &&
    snapshot.run.display.status !== "cancelling" &&
    !isBusy;

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="brand-block">
          <span className="brand-mark" aria-hidden="true">H</span>
          <div>
            <strong>Helarc</strong>
            <span>Developer workbench</span>
          </div>
        </div>
        <nav className="app-nav" aria-label="Workbench navigation">
          <button
            className={activePanelMode === "review" ? "nav-button active" : "nav-button"}
            type="button"
            onClick={() => setSidePanelMode("review")}
            title="Workbench review"
          >
            <ShieldCheck size={16} aria-hidden="true" />
            Workbench
          </button>
          <button
            className={activePanelMode === "threads" ? "nav-button active" : "nav-button"}
            type="button"
            onClick={() => setSidePanelMode("threads")}
            title="Threads"
          >
            <History size={16} aria-hidden="true" />
            Threads
          </button>
          <button
            className={activePanelMode === "settings" ? "nav-button active" : "nav-button"}
            type="button"
            onClick={() => setSidePanelMode("settings")}
            title="Settings"
          >
            <Settings size={16} aria-hidden="true" />
            Settings
          </button>
        </nav>
      </header>

      <section className="workspace-bar" aria-label="Workspace">
        <div className="workspace-identity">
          <FolderOpen size={17} aria-hidden="true" />
          <span className="label">Workspace</span>
          <span className="workspace-path" title={workspaceLabel}>{workspaceLabel}</span>
        </div>
        <div className="workspace-actions">
          <select
            aria-label="Recent workspaces"
            value=""
            onChange={(event) => void selectWorkspaceProfile(event.target.value)}
            disabled={isBusy || snapshot.workspaceProfiles.length === 0}
          >
            <option value="">Recent workspaces</option>
            {snapshot.workspaceProfiles.map((profile) => (
              <option key={profile.id} value={profile.id}>
                {profile.displayName}
              </option>
            ))}
          </select>
          <button className="secondary-button" type="button" onClick={chooseWorkspace} disabled={isBusy}>
            <FolderOpen size={16} aria-hidden="true" />
            Choose workspace
          </button>
        </div>
      </section>

      <main className="workbench">
        <section className="activity-pane" aria-labelledby="activity-title">
          <div className="pane-header">
            <div>
              <span className="eyebrow">Current run</span>
              <h1 id="activity-title">Run timeline</h1>
            </div>
            <div className="run-header-actions">
              {snapshot.run !== null && isRunCancellable(snapshot.run.display.status) ? (
                <button
                  className="secondary-button danger compact-icon"
                  type="button"
                  onClick={() => void cancelRun()}
                  disabled={!canCancelRun}
                  title="Cancel run"
                >
                  <CircleStop size={16} aria-hidden="true" />
                  Cancel
                </button>
              ) : null}
              <span className={`status-indicator ${statusTone(snapshot.status)}`}><span /> {statusText}</span>
            </div>
          </div>
          <div className="activity-stack">
            <ThreadTimeline activeThread={snapshot.activeThread} />
            <RunTimelinePanel
              run={snapshot.run}
              acceptedTask={snapshot.acceptedTask}
            />
          </div>
        </section>

        <aside className="review-pane" aria-labelledby="review-title">
          <div className="pane-header compact">
            <div>
              <span className="eyebrow">{sidePanelEyebrow(activePanelMode)}</span>
              <h2 id="review-title">{sidePanelTitle(activePanelMode)}</h2>
            </div>
            {activePanelMode === "threads"
              ? <History size={19} aria-hidden="true" />
              : activePanelMode === "settings"
                ? <Settings size={19} aria-hidden="true" />
                : <ShieldCheck size={19} aria-hidden="true" />}
          </div>
          <div className={activePanelMode !== "review" || pendingApproval || pendingClarification || snapshot.run?.display.terminal || snapshot.error
            ? "review-content"
            : "review-empty"}
          >
            {activePanelMode === "threads" ? (
              <ThreadPanel
                threads={snapshot.threadSummaries}
                selectedThread={selectedThread}
                selectedThreadId={selectedThreadId}
                onSelectThread={(threadId) => void openThread(threadId)}
              />
            ) : activePanelMode === "settings" ? (
              <SettingsPanel snapshot={snapshot} onSaved={setSnapshot} />
            ) : pendingClarification ? (
              <ClarificationPromptPanel
                clarification={pendingClarification}
                submissionError={interactionSubmissionError}
                isBusy={isBusy}
                onSubmit={(answers) => void submitClarificationAnswers(answers)}
              />
            ) : pendingApproval ? (
              <ApprovalPromptPanel
                approval={pendingApproval}
                submissionError={interactionSubmissionError}
                isBusy={isBusy}
                onSubmit={(option) => void submitApprovalDecision(option)}
              />
            ) : snapshot.run?.display.terminal ? (
              <RunTerminalPanel
                title={terminalTitle(snapshot)}
                run={snapshot.run}
              />
            ) : (
              <>
                <FileCode2 size={24} aria-hidden="true" />
                <span>{runActive ? "Waiting for next action" : "No pending review"}</span>
              </>
            )}
          </div>
        </aside>
      </main>

      <form className="task-composer" onSubmit={runActive ? steerRun : startRun}>
        <div className="composer-heading">
          <label htmlFor="task-input">{runActive ? "Steer run" : "Task"}</label>
          <select
            aria-label="Task templates"
            value=""
            onChange={(event) => applyTaskTemplate(event.target.value)}
            disabled={isBusy || runActive || snapshot.taskTemplates.length === 0}
          >
            <option value="">Templates</option>
            {snapshot.taskTemplates.map((template) => (
              <option key={template.id} value={template.id}>
                {template.title}
              </option>
            ))}
          </select>
        </div>
        <div className="composer-row">
          <textarea
            id="task-input"
            name="task"
            rows={2}
            placeholder={runActive ? "Add guidance to the active run..." : "Describe a code task..."}
            value={runActive ? steeringText : taskText}
            onChange={(event) => runActive
              ? setSteeringText(event.target.value)
              : setTaskText(event.target.value)}
            disabled={!snapshot.workspace || !snapshot.provider.configured || isBusy}
          />
          <button className="primary-button" type="submit" disabled={runActive ? !canSteer : !canStart}>
            <Play size={17} fill="currentColor" aria-hidden="true" />
            {runActive ? "Steer" : "Start"}
          </button>
        </div>
        {!snapshot.provider.configured ? <p className="composer-message error">{snapshot.provider.error.message}</p> : null}
        {snapshot.error ? <p className="composer-message error">{snapshot.error.message}</p> : null}
        {runControlError ? <p className="composer-message error">{runControlError}</p> : null}
        {startResult?.ok ? <p className="composer-message">Run started</p> : null}
      </form>
    </div>
  );
}

export function ThreadTimeline({
  activeThread,
}: {
  activeThread: HelarcMainSnapshot["activeThread"];
}) {
  if (!activeThread) {
    return null;
  }

  return (
    <section className="thread-timeline" aria-label="Active Thread">
      <div className="thread-timeline-header">
        <MessageSquareText size={16} aria-hidden="true" />
        <strong>{activeThread.title}</strong>
        <span>{activeThread.messages.length} messages</span>
      </div>
      <div className="thread-message-list">
        {activeThread.messages.map((message) => (
          <article className={`thread-message role-${message.role}`} key={message.id}>
            <div>
              <strong>{threadMessageRoleLabel(message.role)}</strong>
              <time dateTime={message.createdAt}>{formatTimestamp(message.createdAt)}</time>
            </div>
            <p>{message.content}</p>
          </article>
        ))}
      </div>
      {activeThread.artifacts.length > 0 ? (
        <div className="artifact-strip" aria-label="Thread artifacts">
          {activeThread.artifacts.map((artifact) => (
            <article className="artifact-chip" key={artifact.id}>
              <Boxes size={14} aria-hidden="true" />
              <div>
                <strong>{artifact.title}</strong>
                <span>{artifact.summary ?? artifactKindLabel(artifact.kind)}</span>
              </div>
            </article>
          ))}
        </div>
      ) : null}
    </section>
  );
}

export function RunTimelinePanel({
  run,
  acceptedTask,
}: {
  run: HelarcMainSnapshot["run"];
  acceptedTask: HelarcMainSnapshot["acceptedTask"];
}) {
  const activity = run?.product.activity ?? [];
  if (run === null && activity.length === 0) {
    const title = acceptedTask?.prompt || "No active run";
    return (
      <div className="empty-state">
        <Activity size={28} aria-hidden="true" />
        <h2>{title}</h2>
        {acceptedTask ? <p>Validated task {acceptedTask.id}</p> : null}
      </div>
    );
  }

  return (
    <div className="activity-list" aria-label="Run timeline">
      <div className="run-summary">
        <strong>{acceptedTask?.prompt ?? run?.host.taskId ?? "Run"}</strong>
        <span>{runStatusLabel(run?.display.status ?? "running")}</span>
        {run ? (
          <span>{`Model use: ${run.product.qualification.status}`}</span>
        ) : null}
        {run?.product.continuation ? (
          <span>{`Model continuity: ${run.product.continuation.kind}`}</span>
        ) : null}
      </div>
      {run !== null ? (
        <RunTreePanel
          tree={run.host.runTree}
          activeDelegations={run.host.activeDelegations}
        />
      ) : null}
      {activity.length === 0 ? (
        <div className="run-waiting-state">
          <Activity size={16} aria-hidden="true" />
          <span>Waiting for run activity</span>
        </div>
      ) : null}
      {activity.map((event) => {
        const trace = formatTraceMetadata(event.metadata);
        return (
          <div className={`activity-item severity-${activitySeverity(event)}`} key={event.id}>
            <Activity size={16} aria-hidden="true" />
            <div>
              <strong>{event.title}</strong>
              {event.detail ? <span>{event.detail}</span> : null}
              {trace ? <small>{trace}</small> : null}
              <small>{activitySourceLabel(event.source)}</small>
              <small>{formatTimestamp(event.timestamp)}</small>
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function RunTerminalPanel({
  title,
  run,
}: {
  title: string;
  run: ActiveRunProjection;
}) {
  const terminal = run.host.terminal;
  if (terminal === null) return null;
  const safeOutput = run.product.result?.output ?? null;
  const verification = run.product.result?.verification ?? null;
  const failed = run.display.status === "failed" ||
    run.display.status === "rejected" || run.display.status === "cancelled";

  return (
    <div className="result-panel">
      {failed ? (
        <AlertCircle size={24} aria-hidden="true" />
      ) : (
        <CheckCircle2 size={24} aria-hidden="true" />
      )}
      <strong>{title}</strong>
      {safeOutput?.agentSummary ? <span>{safeOutput.agentSummary}</span> : null}
      <dl>
        <div>
          <dt>Run</dt>
          <dd>{terminal.status}</dd>
        </div>
        <div>
          <dt>Runtime</dt>
          <dd>{safeOutput?.runtimeStatus ?? terminal.status}</dd>
        </div>
        {safeOutput ? (
          <div>
            <dt>Execution</dt>
            <dd>{enforcementLabel(safeOutput.enforcement)}</dd>
          </div>
        ) : null}
        {verification ? (
          <div>
            <dt>Verification</dt>
            <dd>{verificationLabel(verification)}</dd>
          </div>
        ) : null}
        <div>
          <dt>Model use</dt>
          <dd>{run.product.qualification.status}</dd>
        </div>
        {run.host.lifecycleHooks.stopEventSequence > 0 ? (
          <div>
            <dt>Lifecycle hooks</dt>
            <dd>{runLifecycleHookLabel(run.host.lifecycleHooks)}</dd>
          </div>
        ) : null}
        {terminal.code ? (
          <div>
            <dt>Code</dt>
            <dd>{terminal.code}</dd>
          </div>
        ) : null}
        <div>
          <dt>Events</dt>
          <dd>{run.product.activity.length}</dd>
        </div>
        {run.product.continuation ? (
          <div>
            <dt>Model continuity</dt>
            <dd>{run.product.continuation.kind}</dd>
          </div>
        ) : null}
        <div>
          <dt>Started</dt>
          <dd>{formatTimestamp(run.host.startedAt)}</dd>
        </div>
        <div>
          <dt>Completed</dt>
          <dd>{formatTimestamp(terminal.completedAt)}</dd>
        </div>
      </dl>
      {safeOutput !== null && safeOutput.safeErrors.length > 0 ? (
        <ul className="error-list">
          {safeOutput.safeErrors.map((error) => (
            <li key={`${error.code}:${error.message}`}>
              <strong>{error.code}</strong>
              <span>{error.message}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {run.product.activity.length > 0 ? (
        <section className="terminal-events" aria-label="Terminal event summary">
          <strong>Event summary</strong>
          {run.product.activity.slice(-4).map((event) => (
            <span key={event.id}>{event.title}</span>
          ))}
        </section>
      ) : null}
    </div>
  );
}

export function ApprovalPromptPanel({
  approval,
  submissionError,
  isBusy,
  onSubmit,
}: {
  approval: PendingApprovalView | null;
  submissionError: string | null;
  isBusy: boolean;
  onSubmit: (
    option: PendingApprovalView["presentation"]["decisionOptions"][number],
  ) => void;
}) {
  if (!approval) {
    return null;
  }
  const request = approval.presentation;
  const submitted = approval.phase === "submitted_for_resolution";

  return (
    <div className="permission-panel">
      <ShieldCheck size={24} aria-hidden="true" />
      <strong>{approvalCategoryLabel(request)}</strong>
      <span>{request.reason}</span>
      <code>{approvalRequestSummary(request)}</code>
      <div className="permission-meta">
        <span>{request.category}</span>
        <span>{approval.phase === "pending" ? "Awaiting review" : "Submitted for resolution"}</span>
      </div>
      {submissionError ? <span className="error-text">{submissionError}</span> : null}
      <div className="permission-actions">
        {request.decisionOptions.map((option) => (
          <button
            className={approvalOptionButtonClass(option.kind)}
            key={option.id}
            type="button"
            title={option.description ?? undefined}
            onClick={() => onSubmit(option)}
            disabled={isBusy || submitted}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}

export function ThreadPanel({
  threads,
  selectedThread,
  selectedThreadId,
  onSelectThread,
}: {
  threads: HelarcMainSnapshot["threadSummaries"];
  selectedThread: HelarcMainSnapshot["threadSummaries"][number] | null;
  selectedThreadId: string | null;
  onSelectThread: (threadId: string) => void;
}) {
  if (threads.length === 0) {
    return (
      <div className="panel-empty">
        <History size={24} aria-hidden="true" />
        <span>No threads yet</span>
      </div>
    );
  }

  return (
    <>
      <section className="history-list" aria-label="Thread summaries">
        <strong>Threads</strong>
        {threads.slice(0, 8).map((thread) => (
          <button
            className={thread.id === selectedThreadId ? "history-item selected" : "history-item"}
            key={thread.id}
            type="button"
            onClick={() => onSelectThread(thread.id)}
          >
            <span>{thread.title}</span>
            <small>{thread.latestRun?.status ?? thread.status} - {thread.workspace.name}</small>
          </button>
        ))}
      </section>
      {selectedThread ? <ThreadSummaryView thread={selectedThread} /> : null}
    </>
  );
}

function ThreadSummaryView({ thread }: { thread: HelarcMainSnapshot["threadSummaries"][number] }) {
  return (
    <section className="history-record" aria-label="Selected thread summary">
      <strong>{thread.title}</strong>
      <dl>
        <div>
          <dt>Status</dt>
          <dd>{thread.status}</dd>
        </div>
        <div>
          <dt>Workspace</dt>
          <dd>{thread.workspace.name}</dd>
        </div>
        <div>
          <dt>Latest run</dt>
          <dd>{thread.latestRun?.status ?? "none"}</dd>
        </div>
        <div>
          <dt>Updated</dt>
          <dd>{formatTimestamp(thread.updatedAt)}</dd>
        </div>
      </dl>
    </section>
  );
}

export function SettingsPanel({
  snapshot,
  onSaved,
}: {
  snapshot: HelarcMainSnapshot;
  onSaved: (snapshot: HelarcMainSnapshot) => void;
}) {
  const provider = snapshot.provider.configured ? snapshot.provider.activeProfile : null;
  const [isSaving, setIsSaving] = useState(false);
  const [selectedProviderKind, setSelectedProviderKind] = useState<HelarcProviderKind>(
    provider?.providerKind ?? HELARC_DEFAULT_PROVIDER_SETTINGS.providerKind,
  );
  const formKey = provider
    ? `${provider.id}:${provider.providerKind}:${provider.displayName}:${provider.baseUrl}:${provider.model}:${provider.timeoutMs}:${provider.ollamaRuntime?.contextWindowTokens ?? "managed"}:${provider.ollamaRuntime?.maximumOutputTokens ?? "managed"}:${provider.credentialStatus}:${provider.qualificationPolicy}`
    : "unconfigured-provider";

  async function saveProviderConfig(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const api = getHelarcApi();
    if (!api) {
      return;
    }

    const formData = new FormData(event.currentTarget);
    const submittedProviderKind = readProviderKind(
      formData,
      provider?.providerKind ?? HELARC_DEFAULT_PROVIDER_SETTINGS.providerKind,
    );
    const submittedDisplayName = readFormString(formData, "displayName");
    const submittedBaseUrl = readFormString(formData, "baseUrl");
    const submittedModel = readFormString(formData, "model");
    const submittedTimeoutMs = readFormNumber(
      formData,
      "timeoutMs",
      provider?.timeoutMs ?? HELARC_DEFAULT_PROVIDER_SETTINGS.timeoutMs,
    );
    const submittedOllamaRuntime = submittedProviderKind === "ollama"
      ? {
          contextWindowTokens: readFormNumber(
            formData,
            "ollamaContextWindowTokens",
            provider?.ollamaRuntime?.contextWindowTokens ??
              HELARC_DEFAULT_OLLAMA_RUNTIME_PROFILE.contextWindowTokens,
          ),
          maximumOutputTokens: readFormNumber(
            formData,
            "ollamaMaximumOutputTokens",
            provider?.ollamaRuntime?.maximumOutputTokens ??
              HELARC_DEFAULT_OLLAMA_RUNTIME_PROFILE.maximumOutputTokens,
          ),
        }
      : null;
    const submittedQualificationPolicy = readQualificationPolicy(
      formData,
      provider?.qualificationPolicy ?? HELARC_DEFAULT_PROVIDER_SETTINGS.qualificationPolicy,
    );
    const submittedApiKey = readFormString(formData, "apiKey");

    setIsSaving(true);
    try {
      const receipt = await api.saveProviderConfig({
        commandId: createCommandId("provider.save"),
        providerKind: submittedProviderKind,
        displayName: submittedDisplayName,
        baseUrl: submittedBaseUrl,
        model: submittedModel,
        timeoutMs: submittedTimeoutMs,
        ollamaRuntime: submittedOllamaRuntime,
        qualificationPolicy: submittedQualificationPolicy,
        apiKeyUpdate: submittedApiKey.trim().length > 0
          ? "set"
          : provider?.credentialStatus === "present"
            ? "keep"
            : "clear",
        apiKey: submittedApiKey,
      });
      if (receipt.status === "handled") {
        onSaved(receipt.result);
      }
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <form key={formKey} className="settings-panel" aria-label="Provider settings" onSubmit={saveProviderConfig}>
      <strong>Provider</strong>
      <label>
        <span>Type</span>
        <select
          name="providerKind"
          defaultValue={provider?.providerKind ?? HELARC_DEFAULT_PROVIDER_SETTINGS.providerKind}
          onChange={(event) => setSelectedProviderKind(readProviderKindValue(event.target.value))}
          disabled={isSaving}
        >
          <option value="openai-compatible">OpenAI-compatible</option>
          <option value="ollama">Ollama</option>
        </select>
      </label>
      <label>
        <span>Name</span>
        <input
          name="displayName"
          defaultValue={provider?.displayName ?? HELARC_DEFAULT_PROVIDER_SETTINGS.displayName}
          autoComplete="off"
          disabled={isSaving}
        />
      </label>
      <label>
        <span>Base URL</span>
        <input
          name="baseUrl"
          defaultValue={provider?.baseUrl ?? HELARC_DEFAULT_PROVIDER_SETTINGS.baseUrl}
          autoComplete="off"
          disabled={isSaving}
        />
      </label>
      <label>
        <span>Model</span>
        <input
          name="model"
          defaultValue={provider?.model ?? HELARC_DEFAULT_PROVIDER_SETTINGS.model}
          autoComplete="off"
          disabled={isSaving}
        />
      </label>
      <label>
        <span>Timeout</span>
        <input
          name="timeoutMs"
          type="number"
          min="1000"
          step="1000"
          defaultValue={(provider?.timeoutMs ?? HELARC_DEFAULT_PROVIDER_SETTINGS.timeoutMs).toString()}
          autoComplete="off"
          disabled={isSaving}
        />
      </label>
      {selectedProviderKind === "ollama" ? (
        <>
          <label>
            <span>Context window</span>
            <input
              name="ollamaContextWindowTokens"
              type="number"
              min="4096"
              step="1024"
              defaultValue={(provider?.ollamaRuntime?.contextWindowTokens ??
                HELARC_DEFAULT_OLLAMA_RUNTIME_PROFILE.contextWindowTokens).toString()}
              autoComplete="off"
              disabled={isSaving}
            />
          </label>
          <label>
            <span>Maximum output</span>
            <input
              name="ollamaMaximumOutputTokens"
              type="number"
              min="256"
              step="256"
              defaultValue={(provider?.ollamaRuntime?.maximumOutputTokens ??
                HELARC_DEFAULT_OLLAMA_RUNTIME_PROFILE.maximumOutputTokens).toString()}
              autoComplete="off"
              disabled={isSaving}
            />
          </label>
        </>
      ) : null}
      <label>
        <span>Model qualification</span>
        <select
          name="qualificationPolicy"
          defaultValue={provider?.qualificationPolicy ??
            HELARC_DEFAULT_PROVIDER_SETTINGS.qualificationPolicy}
          disabled={isSaving}
        >
          <option value="require_qualified">Require qualified</option>
          <option value="allow_experimental">Allow experimental</option>
        </select>
      </label>
      <label>
        <span>API key</span>
        <input
          name="apiKey"
          type="password"
          defaultValue=""
          autoComplete="off"
          disabled={isSaving}
          placeholder={provider?.credentialStatus === "present" ? "Stored key is present" : "Optional for local endpoints"}
        />
      </label>
      <div className="settings-status">
        <span>Credential</span>
        <strong>{provider?.credentialStatus ?? "missing"}</strong>
      </div>
      <div className="settings-status">
        <span>Qualification policy</span>
        <strong>{provider?.qualificationPolicy ??
          HELARC_DEFAULT_PROVIDER_SETTINGS.qualificationPolicy}</strong>
      </div>
      {snapshot.provider.configured ? null : <p className="settings-error">{snapshot.provider.error.message}</p>}
      <button className="primary-button compact" type="submit" disabled={isSaving}>
        Save
      </button>
    </form>
  );
}

function statusLabel(status: HelarcMainSnapshot["status"], providerConfigured: boolean): string {
  if (!providerConfigured) {
    return "Provider missing";
  }

  if (status === "workspace_selected") {
    return "Idle";
  }

  return status[0]?.toUpperCase() + status.slice(1).replaceAll("_", " ");
}

function statusTone(status: HelarcMainSnapshot["status"]): string {
  if (status === "completed") {
    return "success";
  }

  if (status === "failed" || status === "rejected" || status === "cancelled") {
    return "danger";
  }

  if (isRunActive(status)) {
    return "active";
  }

  return "idle";
}

function sidePanelEyebrow(mode: SidePanelMode): string {
  if (mode === "threads") {
    return "Work context";
  }

  if (mode === "settings") {
    return "Desktop state";
  }

  return "Pending action";
}

function sidePanelTitle(mode: SidePanelMode): string {
  if (mode === "threads") {
    return "Threads";
  }

  if (mode === "settings") {
    return "Settings";
  }

  return "Review";
}

function readFormString(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === "string" ? value : "";
}

function readFormNumber(formData: FormData, key: string, fallback: number): number {
  const parsed = Number(readFormString(formData, key));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function readProviderKind(formData: FormData, fallback: HelarcProviderKind): HelarcProviderKind {
  const value = readFormString(formData, "providerKind");
  return value === "openai-compatible" || value === "ollama" ? value : fallback;
}

function readProviderKindValue(value: string): HelarcProviderKind {
  return value === "ollama" ? "ollama" : "openai-compatible";
}

function isRunActive(status: HelarcMainSnapshot["status"]): boolean {
  return status === "starting" ||
    status === "running" ||
    status === "cancelling" ||
    status === "waiting_for_approval";
}

function isRunCancellable(status: ActiveRunProjection["display"]["status"]): boolean {
  return status === "starting" ||
    status === "running" ||
    status === "waiting_for_approval" ||
    status === "cancelling";
}

function runStatusLabel(status: ActiveRunProjection["display"]["status"]): string {
  return status[0]?.toUpperCase() + status.slice(1).replaceAll("_", " ");
}

function threadMessageRoleLabel(role: NonNullable<HelarcMainSnapshot["activeThread"]>["messages"][number]["role"]): string {
  return role.charAt(0).toUpperCase() + role.slice(1);
}

function readQualificationPolicy(
  formData: FormData,
  fallback: HelarcModelUsePolicy,
): HelarcModelUsePolicy {
  const value = formData.get("qualificationPolicy");
  return value === "require_qualified" || value === "allow_experimental"
    ? value
    : fallback;
}

export function ClarificationPromptPanel({
  clarification,
  submissionError,
  isBusy,
  onSubmit,
}: {
  clarification: PendingClarificationView;
  submissionError: string | null;
  isBusy: boolean;
  onSubmit: (answers: readonly {
    readonly question_id: string;
    readonly selected_labels: readonly string[];
    readonly text: string | null;
  }[]) => void;
}) {
  const [answers, setAnswers] = useState<Record<string, { selected: string[]; text: string }>>({});
  const submitted = clarification.phase === "submitted_for_resolution";
  const complete = clarification.presentation.questions.every((question) => {
    const answer = answers[question.id];
    return Boolean(answer && (answer.selected.length > 0 || answer.text.trim().length > 0));
  });

  function toggleLabel(questionId: string, label: string, allowMultiple: boolean) {
    setAnswers((current) => {
      const existing = current[questionId] ?? { selected: [], text: "" };
      const selected = existing.selected.includes(label)
        ? existing.selected.filter((item) => item !== label)
        : allowMultiple
          ? [...existing.selected, label]
          : [label];
      return { ...current, [questionId]: { ...existing, selected } };
    });
  }

  function setText(questionId: string, text: string) {
    setAnswers((current) => ({
      ...current,
      [questionId]: {
        selected: current[questionId]?.selected ?? [],
        text,
      },
    }));
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!complete || submitted || isBusy) return;
    onSubmit(clarification.presentation.questions.map((question) => {
      const answer = answers[question.id]!;
      const text = answer.text.trim();
      return {
        question_id: question.id,
        selected_labels: answer.selected,
        text: text.length === 0 ? null : text,
      };
    }));
  }

  return (
    <form className="clarification-panel" onSubmit={submit}>
      <MessageSquareText size={24} aria-hidden="true" />
      <strong>Helarc needs your input</strong>
      {clarification.presentation.questions.map((question) => {
        const answer = answers[question.id] ?? { selected: [], text: "" };
        return (
          <fieldset className="clarification-question" key={question.id} disabled={isBusy || submitted}>
            <legend>{question.prompt}</legend>
            {question.options.map((option) => (
              <label className="clarification-option" key={option.label} title={option.description}>
                <input
                  type={question.allowMultiple ? "checkbox" : "radio"}
                  name={`clarification-${question.id}`}
                  checked={answer.selected.includes(option.label)}
                  onChange={() => toggleLabel(question.id, option.label, question.allowMultiple)}
                />
                <span><strong>{option.label}</strong><small>{option.description}</small></span>
              </label>
            ))}
            <textarea
              aria-label={`Free-text answer for ${question.prompt}`}
              placeholder="Type an answer"
              value={answer.text}
              onChange={(event) => setText(question.id, event.target.value)}
              rows={3}
            />
          </fieldset>
        );
      })}
      {submissionError ? <span className="error-text">{submissionError}</span> : null}
      <div className="permission-actions">
        <button className="primary-button compact" type="submit" disabled={!complete || isBusy || submitted}>
          {submitted ? "Submitted" : "Submit"}
        </button>
      </div>
    </form>
  );
}

export function RunTreePanel({
  tree,
  activeDelegations,
}: {
  tree: ActiveRunProjection["host"]["runTree"];
  activeDelegations: ActiveRunProjection["host"]["activeDelegations"];
}) {
  return (
    <section className="run-tree" aria-label="Run hierarchy">
      <div className="run-tree-header">
        <GitBranch size={16} aria-hidden="true" />
        <strong>Run hierarchy</strong>
        <span>{tree.activeDescendantRuns} active / {tree.totalDescendantRuns} descendants</span>
      </div>
      <div className="run-tree-list">
        {tree.nodes.map((node) => {
          const activeDelegation = activeDelegations.find(
            ({ child }) => child.id === node.runId,
          );
          return (
            <div
            className="run-tree-node"
            key={node.runId}
            style={{ "--run-indent": `${8 + Math.min(node.depth, 8) * 16}px` } as React.CSSProperties}
          >
            <span className={`run-tree-status ${runTreeStatusTone(node.status)}`} aria-hidden="true" />
            <div>
              <strong>{node.depth === 0 ? "Root run" : `Descendant depth ${node.depth}`}</strong>
              <span title={node.runId}>{node.runId}</span>
              {node.parentRunActionId !== null ? (
                <small title={node.parentRunActionId}>Created by {node.parentRunActionId}</small>
              ) : null}
              {node.dispatch !== null ? (
                <small title={`${node.dispatch.controllerRequestId} | ${node.dispatch.controllerTurnId}`}>
                  {node.dispatch.requestedForm === "concurrent_sibling"
                    ? `Concurrent request ${node.dispatch.siblingIndex + 1} of ${node.dispatch.siblingCount}`
                    : "Single child request"}
                </small>
              ) : null}
              {activeDelegation !== undefined ? (
                <small title={activeDelegation.request.id}>
                  Steerable at revision {activeDelegation.childRunRevision}
                </small>
              ) : null}
              {node.terminal !== null ? <small>{node.terminal.code}</small> : null}
            </div>
            <span className="run-tree-node-status">{node.status}</span>
            </div>
          );
        })}
      </div>
      <div className="run-tree-limits">
        <span>Depth {tree.limits.maxDescendantDepth}</span>
        <span>Total {tree.limits.maxTotalDescendantRuns}</span>
        <span>Active {tree.limits.maxActiveDescendantRuns}</span>
        <span>Turns {tree.resources.controllerTurns.enforcement === "hard" ? tree.resources.controllerTurns.measuredConsumed : tree.resources.controllerTurns.observed}/{tree.resources.controllerTurns.enforcement === "hard" ? tree.resources.controllerTurns.capacity : tree.resources.controllerTurns.threshold}</span>
        <span>Actions {tree.resources.actions.enforcement === "hard" ? tree.resources.actions.measuredConsumed : tree.resources.actions.observed}/{tree.resources.actions.enforcement === "hard" ? tree.resources.actions.capacity : tree.resources.actions.threshold}</span>
        <span>Approvals {tree.approvals.activeReviews} active / {tree.approvals.totalRequests} total</span>
        <span>Settlement {tree.settlement.complete ? "complete" : `${tree.settlement.unsettledDescendantRuns} pending`}</span>
        {tree.cancellation.latestScope !== null ? (
          <span>Cancellation {tree.cancellation.latestScope}</span>
        ) : null}
      </div>
    </section>
  );
}

function artifactKindLabel(kind: NonNullable<HelarcMainSnapshot["activeThread"]>["artifacts"][number]["kind"]): string {
  return kind.split("-").map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ");
}

function terminalTitle(snapshot: HelarcMainSnapshot): string {
  const terminalStatus = snapshot.run?.host.terminal?.status;
  if (terminalStatus === "cancelled") {
    return "Run cancelled";
  }

  if (snapshot.status === "rejected") {
    return "Change rejected";
  }

  if (snapshot.status === "failed") {
    return "Run failed";
  }

  return "Run completed";
}

function formatTimestamp(timestamp: string): string {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) {
    return timestamp;
  }

  return date.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function formatTraceMetadata(metadata: Record<string, unknown>): string | null {
  const protocol = readMetadataString(metadata, "controllerProtocol");
  if (!protocol) {
    return null;
  }

  const parts = [`protocol ${protocol}`];
  const versions = [
    readMetadataString(metadata, "promptArchitectureVersion"),
    readMetadataString(metadata, "controllerControlSetRevision"),
    readMetadataString(metadata, "toolExposureVersion"),
  ].filter((item): item is string => Boolean(item));
  const exposedToolNames = readMetadataStringArray(metadata, "exposedToolNames");

  if (versions.length > 0) {
    parts.push(`versions ${versions.join(", ")}`);
  }

  if (exposedToolNames.length > 0) {
    parts.push(`tools ${exposedToolNames.join(", ")}`);
  }

  return parts.join(" | ");
}

function readMetadataString(metadata: Record<string, unknown>, key: string): string | null {
  const value = metadata[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readMetadataStringArray(metadata: Record<string, unknown>, key: string): string[] {
  const value = metadata[key];
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value
    : [];
}

function enforcementLabel(
  enforcement: NonNullable<ActiveRunProjection["product"]["result"]>["output"]["enforcement"],
): string {
  switch (enforcement.status) {
    case "not_exercised": return "Not exercised";
    case "unisolated": return "Unisolated";
    case "enforced": return `${enforcement.selected} enforced`;
    case "unavailable": return `${enforcement.selected} unavailable`;
    case "denied": return `${enforcement.selected} denied`;
    case "interrupted": return "Interrupted";
    case "failed": return "Failed";
  }
}

function runLifecycleHookLabel(hooks: ActiveRunProjection["host"]["lifecycleHooks"]): string {
  const limitations = hooks.limitations.length === 0
    ? ""
    : `, ${hooks.limitations.length} limitations`;
  return `${hooks.stopEventSequence} stop events, ${hooks.consecutiveBlockingRounds} consecutive blocking rounds${limitations}`;
}

function verificationLabel(
  verification: NonNullable<ActiveRunProjection["product"]["result"]>["verification"],
): string {
  switch (verification.status) {
    case "not_required":
      return "Not required";
    case "pending":
      return verification.activeChecks > 0
        ? `${verification.activeChecks} check${verification.activeChecks === 1 ? "" : "s"} running`
        : "Pending";
    case "satisfied":
      return "Satisfied";
    case "attention_required": {
      const count = verification.counts
        .filter(({ state }) => state === "violated" || state === "inconclusive" || state === "stale")
        .reduce((total, entry) => total + entry.count, 0);
      return count > 0 ? `Attention required (${count})` : "Attention required";
    }
    case "unavailable":
      return "Unavailable";
  }
}

function getHelarcApi() {
  return typeof window === "undefined" ? null : window.helarc;
}

function approvalCategoryLabel(
  request: PendingApprovalView["presentation"],
): string {
  switch (request.category) {
    case "commandExecution": return "Command execution";
    case "fileChange": return "File change";
    case "permissions": return "Additional permissions";
    case "remoteToolCall":
      return request.payload.sourceKind === "mcp"
        ? "MCP tool call"
        : "Remote tool call";
    case "skill": return "Skill action";
    case "networkAccess": return "Network access";
  }
}

function approvalRequestSummary(
  request: PendingApprovalView["presentation"],
): string {
  switch (request.category) {
    case "commandExecution":
      return request.payload.commandDisplay;
    case "fileChange":
      return request.payload.changes
        .map((change) => `${change.operation} ${change.displayPath}`)
        .join(", ");
    case "permissions": {
      const readCount = request.payload.permissions.fileSystem?.read?.length ?? 0;
      const writeCount = request.payload.permissions.fileSystem?.write?.length ?? 0;
      const network = request.payload.permissions.network?.enabled === true ? "network" : null;
      return [
        readCount > 0 ? `${readCount} read target(s)` : null,
        writeCount > 0 ? `${writeCount} write target(s)` : null,
        network,
      ].filter((value): value is string => value !== null).join(", ") || "Permission expansion";
    }
    case "remoteToolCall":
      return `${request.payload.sourceDisplayName} / ${request.payload.serverDisplayName}: ${request.payload.toolDisplayName}`;
    case "skill":
      return `${request.payload.skillDisplayName}: ${request.payload.action}`;
    case "networkAccess":
      return request.payload.actionSummary;
  }
}

function approvalOptionButtonClass(
  kind: PendingApprovalView["presentation"]["decisionOptions"][number]["kind"],
): string {
  if (kind === "decline" || kind === "cancel") {
    return "secondary-button danger";
  }
  return "primary-button compact";
}

function defaultGrantedPermissions(
  approval: PendingApprovalView,
  optionKind: PendingApprovalView["presentation"]["decisionOptions"][number]["kind"],
) {
  if (optionKind !== "grantPermissions") return null;
  const request = approval.presentation;
  switch (request.category) {
    case "commandExecution":
    case "fileChange":
      return request.payload.additionalPermissions;
    case "permissions":
      return request.payload.permissions;
    case "skill":
      return request.payload.requiredPermissions;
    case "remoteToolCall":
    case "networkAccess":
      return null;
  }
}

function getPendingApproval(run: HelarcMainSnapshot["run"]): PendingApprovalView | null {
  return run?.host.pendingInteractions.find(
    (interaction): interaction is PendingApprovalView => interaction.family === "approval",
  ) ?? null;
}

function getPendingClarification(run: HelarcMainSnapshot["run"]): PendingClarificationView | null {
  return run?.host.pendingInteractions.find(
    (interaction): interaction is PendingClarificationView => interaction.family === "clarification",
  ) ?? null;
}

function activitySeverity(
  activity: ActiveRunProjection["product"]["activity"][number],
): "info" | "warning" | "error" {
  if (
    activity.kind === "run.failed" ||
    activity.kind === "action.invalidated" ||
    activity.metadata.status === "failed" || activity.metadata.status === "blocked"
  ) {
    return "error";
  }
  if (
    activity.kind === "run.cancelled" || activity.kind === "retry.exhausted" ||
    activity.kind === "retry.cancelled"
  ) {
    return "warning";
  }
  return "info";
}

function activitySourceLabel(
  source: ActiveRunProjection["product"]["activity"][number]["source"],
): string {
  return source.lineage.kind === "root"
    ? `Root run | event ${source.eventSequence}`
    : `Descendant depth ${source.lineage.depth} | event ${source.eventSequence}`;
}

function runTreeStatusTone(
  status: ActiveRunProjection["host"]["runTree"]["nodes"][number]["status"],
): "active" | "warning" | "success" | "danger" | "neutral" {
  if (status === "running" || status === "waiting") return "active";
  if (status === "suspended" || status === "cancelling") return "warning";
  if (status === "succeeded") return "success";
  if (status === "failed" || status === "cancelled") return "danger";
  return "neutral";
}

function renderTaskTemplatePrompt(promptText: string, constraints: string[]): string {
  if (constraints.length === 0) {
    return promptText;
  }

  return `${promptText}\n\nConstraints:\n${constraints.map((constraint) => `- ${constraint}`).join("\n")}`;
}

function createCommandId(kind: string): string {
  return `helarc-desktop-${kind}-${globalThis.crypto.randomUUID()}`;
}
