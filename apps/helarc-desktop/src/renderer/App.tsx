import {
  Activity,
  AlertCircle,
  CheckCircle2,
  CircleStop,
  Boxes,
  FileCode2,
  FolderOpen,
  History,
  MessageSquareText,
  Play,
  Settings,
  ShieldCheck,
} from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import type {
  HelarcApprovalSubmissionReceipt,
  HelarcMainSnapshot,
  HelarcProviderKind,
  HelarcStartRunResult,
} from "../shared/HelarcDesktopApi.js";

const initialSnapshot: HelarcMainSnapshot = {
  status: "idle",
  workspace: null,
  workspaceProfiles: [],
  taskTemplates: [],
  provider: {
    configured: true,
      activeProfile: {
        id: "initial",
        providerKind: "openai-compatible",
        displayName: "Initial Provider",
      endpointLabel: "provider.local",
      baseUrl: "https://provider.local/v1",
      baseUrlOrigin: "https://provider.local",
      model: "initial",
      timeoutMs: 30_000,
      credentialStatus: "missing",
      isActive: true,
    },
    profiles: [],
    error: null,
  },
  acceptedTask: null,
  activeThread: null,
  threadSummaries: [],
  run: null,
  error: null,
};

type ActiveRunProjection = NonNullable<HelarcMainSnapshot["run"]>;
type HostApprovalProjection = NonNullable<ActiveRunProjection["platform"]["approval"]>;
type PendingApprovalView = NonNullable<HostApprovalProjection["review"]> &
  Pick<HostApprovalProjection, "phase">;

type SidePanelMode = "review" | "threads" | "settings";

export function App() {
  const [snapshot, setSnapshot] = useState<HelarcMainSnapshot>(initialSnapshot);
  const [taskText, setTaskText] = useState("");
  const [isBusy, setIsBusy] = useState(false);
  const [startResult, setStartResult] = useState<HelarcStartRunResult | null>(null);
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [sidePanelMode, setSidePanelMode] = useState<SidePanelMode>("review");
  const [approvalSubmissionError, setApprovalSubmissionError] = useState<string | null>(null);
  const pendingApproval = getPendingApproval(snapshot.run);
  const pendingPatchReview = getPendingPatchReview(snapshot.run);
  const runActive = isRunActive(snapshot.status);
  const selectedThread = snapshot.threadSummaries.find((thread) => thread.id === selectedThreadId) ?? null;
  const activePanelMode: SidePanelMode = pendingApproval || pendingPatchReview
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

  async function chooseWorkspace() {
    const api = getHelarcApi();
    if (!api) {
      return;
    }

    setIsBusy(true);
    try {
      setSnapshot(await api.chooseWorkspace());
      setStartResult(null);
      setSelectedThreadId(null);
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
      setSnapshot(await api.selectWorkspaceProfile({ profileId }));
      setStartResult(null);
      setSelectedThreadId(null);
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
      const result = await api.openThread({ threadId });
      setSelectedThreadId(threadId);
      setSnapshot(result.snapshot);
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
      const result = await api.startRun({ taskText });
      setStartResult(result);
      setSnapshot(result.snapshot);
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
    option: PendingApprovalView["request"]["decisionOptions"][number],
  ) {
    const api = getHelarcApi();
    if (!api || !pendingApproval || pendingApproval.phase !== "reviewing") {
      return;
    }

    setIsBusy(true);
    try {
      const receipt: HelarcApprovalSubmissionReceipt = await api.submitApprovalDecision({
        submissionId: `helarc-desktop-${crypto.randomUUID()}`,
        runId: pendingApproval.request.runId,
        requestId: pendingApproval.request.id,
        pendingVersion: pendingApproval.pendingVersion,
        optionId: option.id,
        grantedPermissions: defaultGrantedPermissions(pendingApproval, option.kind),
        reason: option.kind === "decline"
          ? "Declined from Helarc desktop."
          : option.kind === "cancel"
            ? "Cancelled from Helarc desktop."
            : null,
      });
      setApprovalSubmissionError(
        receipt.status === "rejected" ? receipt.code : null,
      );
    } finally {
      setIsBusy(false);
    }
  }

  async function cancelRun() {
    const api = getHelarcApi();
    if (!api) {
      return;
    }

    setIsBusy(true);
    try {
      const result = await api.cancelRun();
      setSnapshot(result.snapshot);
    } finally {
      setIsBusy(false);
    }
  }

  async function resolvePatchReview(decision: "accepted" | "rejected") {
    const api = getHelarcApi();
    if (!api || !pendingPatchReview) {
      return;
    }

    setIsBusy(true);
    try {
      const result = await api.resolvePatchReview({
        submissionId: globalThis.crypto.randomUUID(),
        runId: pendingPatchReview.runId,
        proposalId: pendingPatchReview.proposalId,
        reviewId: pendingPatchReview.reviewId,
        pendingVersion: pendingPatchReview.pendingVersion,
        decision,
        reason: decision === "accepted" ? "Accepted from Helarc desktop." : "Rejected from Helarc desktop.",
      });
      setSnapshot(result.snapshot);
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
            <ConversationPanel activeThread={snapshot.activeThread} />
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
          <div className={activePanelMode !== "review" || pendingApproval || pendingPatchReview || snapshot.run?.display.terminal || snapshot.error
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
            ) : pendingApproval ? (
              <ApprovalPromptPanel
                approval={pendingApproval}
                submissionError={approvalSubmissionError}
                isBusy={isBusy}
                onSubmit={(option) => void submitApprovalDecision(option)}
              />
            ) : pendingPatchReview ? (
              <div className="patch-panel">
                <FileCode2 size={24} aria-hidden="true" />
                <strong>{pendingPatchReview.summary}</strong>
                <span>{pendingPatchReview.operation} - {pendingPatchReview.path}</span>
                <div className="patch-preview">
                  <section>
                    <span>Original</span>
                    <pre>{pendingPatchReview.originalContent ?? ""}</pre>
                  </section>
                  <section>
                    <span>Proposed</span>
                    <pre>{pendingPatchReview.proposedContent ?? ""}</pre>
                  </section>
                </div>
                <div className="permission-actions">
                  <button
                    className="secondary-button danger"
                    type="button"
                    onClick={() => void resolvePatchReview("rejected")}
                    disabled={isBusy}
                  >
                    Reject
                  </button>
                  <button
                    className="primary-button compact"
                    type="button"
                    onClick={() => void resolvePatchReview("accepted")}
                    disabled={isBusy}
                  >
                    Apply
                  </button>
                </div>
              </div>
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

      <form className="task-composer" onSubmit={startRun}>
        <div className="composer-heading">
          <label htmlFor="task-input">Task</label>
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
            placeholder="Describe a code task..."
            value={taskText}
            onChange={(event) => setTaskText(event.target.value)}
            disabled={!snapshot.workspace || !snapshot.provider.configured || isBusy || runActive}
          />
          <button className="primary-button" type="submit" disabled={!canStart}>
            <Play size={17} fill="currentColor" aria-hidden="true" />
            Start
          </button>
        </div>
        {!snapshot.provider.configured ? <p className="composer-message error">{snapshot.provider.error.message}</p> : null}
        {snapshot.error ? <p className="composer-message error">{snapshot.error.message}</p> : null}
        {startResult?.ok ? <p className="composer-message">Run started</p> : null}
      </form>
    </div>
  );
}

export function ConversationPanel({
  activeThread,
}: {
  activeThread: HelarcMainSnapshot["activeThread"];
}) {
  if (!activeThread) {
    return null;
  }

  return (
    <section className="conversation-panel" aria-label="Active conversation">
      <div className="conversation-header">
        <MessageSquareText size={16} aria-hidden="true" />
        <strong>{activeThread.title}</strong>
        <span>{activeThread.messages.length} messages</span>
      </div>
      <div className="conversation-list">
        {activeThread.messages.map((message) => (
          <article className={`conversation-message role-${message.role}`} key={message.id}>
            <div>
              <strong>{conversationRoleLabel(message.role)}</strong>
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
  if (activity.length === 0) {
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
        <strong>{acceptedTask?.prompt ?? run?.platform.taskId ?? "Run"}</strong>
        <span>{runStatusLabel(run?.display.status ?? "running")}</span>
      </div>
      {activity.map((event) => {
        const trace = formatTraceMetadata(event.metadata);
        return (
          <div className={`activity-item severity-${activitySeverity(event)}`} key={event.id}>
            <Activity size={16} aria-hidden="true" />
            <div>
              <strong>{event.title}</strong>
              {event.detail ? <span>{event.detail}</span> : null}
              {trace ? <small>{trace}</small> : null}
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
  const terminal = run.platform.terminal;
  if (terminal === null) return null;
  const safeOutput = run.product.result?.output ?? null;
  const failed = run.display.status === "failed" || run.display.status === "blocked" ||
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
        <div>
          <dt>Started</dt>
          <dd>{formatTimestamp(run.platform.startedAt)}</dd>
        </div>
        <div>
          <dt>Completed</dt>
          <dd>{formatTimestamp(terminal.completedAt)}</dd>
        </div>
        {safeOutput?.patchStatus ? (
          <div>
            <dt>Patch</dt>
            <dd>{safeOutput.patchStatus}</dd>
          </div>
        ) : null}
        {safeOutput?.appliedPath ? (
          <div>
            <dt>Applied</dt>
            <dd>{safeOutput.appliedPath}</dd>
          </div>
        ) : null}
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
    option: PendingApprovalView["request"]["decisionOptions"][number],
  ) => void;
}) {
  if (!approval) {
    return null;
  }
  const request = approval.request;
  const submitted = approval.phase === "submitted_for_resolution";

  return (
    <div className="permission-panel">
      <ShieldCheck size={24} aria-hidden="true" />
      <strong>{approvalCategoryLabel(request.category)}</strong>
      <span>{request.reason}</span>
      <code>{approvalRequestSummary(request)}</code>
      <div className="permission-meta">
        <span>{request.category}</span>
        <span>{approval.phase === "reviewing" ? "Awaiting review" : "Submitted for resolution"}</span>
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

function SettingsPanel({
  snapshot,
  onSaved,
}: {
  snapshot: HelarcMainSnapshot;
  onSaved: (snapshot: HelarcMainSnapshot) => void;
}) {
  const provider = snapshot.provider.configured ? snapshot.provider.activeProfile : null;
  const [isSaving, setIsSaving] = useState(false);
  const formKey = provider
    ? `${provider.id}:${provider.providerKind}:${provider.displayName}:${provider.baseUrl}:${provider.model}:${provider.timeoutMs}:${provider.credentialStatus}`
    : "unconfigured-provider";

  async function saveProviderConfig(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const api = getHelarcApi();
    if (!api) {
      return;
    }

    const formData = new FormData(event.currentTarget);
    const submittedProviderKind = readProviderKind(formData, provider?.providerKind ?? "openai-compatible");
    const submittedDisplayName = readFormString(formData, "displayName");
    const submittedBaseUrl = readFormString(formData, "baseUrl");
    const submittedModel = readFormString(formData, "model");
    const submittedTimeoutMs = readFormNumber(formData, "timeoutMs", provider?.timeoutMs ?? 30_000);
    const submittedApiKey = readFormString(formData, "apiKey");

    setIsSaving(true);
    try {
      const nextSnapshot = await api.saveProviderConfig({
        providerKind: submittedProviderKind,
        displayName: submittedDisplayName,
        baseUrl: submittedBaseUrl,
        model: submittedModel,
        timeoutMs: submittedTimeoutMs,
        apiKeyUpdate: submittedApiKey.trim().length > 0
          ? "set"
          : provider?.credentialStatus === "present"
            ? "keep"
            : "clear",
        apiKey: submittedApiKey,
      });
      onSaved(nextSnapshot);
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
          defaultValue={provider?.providerKind ?? "openai-compatible"}
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
          defaultValue={provider?.displayName ?? "OpenAI-compatible Provider"}
          autoComplete="off"
          disabled={isSaving}
        />
      </label>
      <label>
        <span>Base URL</span>
        <input
          name="baseUrl"
          defaultValue={provider?.baseUrl ?? "https://api.openai.com/v1"}
          autoComplete="off"
          disabled={isSaving}
        />
      </label>
      <label>
        <span>Model</span>
        <input
          name="model"
          defaultValue={provider?.model ?? ""}
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
          defaultValue={provider?.timeoutMs.toString() ?? "30000"}
          autoComplete="off"
          disabled={isSaving}
        />
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

  if (status === "failed" || status === "blocked" || status === "rejected" || status === "cancelled") {
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

function isRunActive(status: HelarcMainSnapshot["status"]): boolean {
  return status === "starting" ||
    status === "running" ||
    status === "cancelling" ||
    status === "waiting_for_approval" ||
    status === "waiting_for_patch_review" ||
    status === "applying_patch";
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

function conversationRoleLabel(role: NonNullable<HelarcMainSnapshot["activeThread"]>["messages"][number]["role"]): string {
  if (role === "product-event") {
    return "Product";
  }

  return role.charAt(0).toUpperCase() + role.slice(1);
}

function artifactKindLabel(kind: NonNullable<HelarcMainSnapshot["activeThread"]>["artifacts"][number]["kind"]): string {
  return kind.split("-").map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ");
}

function terminalTitle(snapshot: HelarcMainSnapshot): string {
  const terminalStatus = snapshot.run?.platform.terminal?.status;
  if (terminalStatus === "cancelled") {
    return "Run cancelled";
  }

  if (snapshot.status === "rejected") {
    return "Change rejected";
  }

  if (snapshot.status === "failed") {
    return "Run failed";
  }

  if (snapshot.status === "blocked") {
    return "Run blocked";
  }

  if (snapshot.run?.product.result?.output.patchStatus === "applied") {
    return "Patch applied";
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
  const action = readMetadataString(metadata, "controllerAction");
  if (!action) {
    return null;
  }

  const parts = [`action ${action}`];
  const requestedToolName = readMetadataString(metadata, "requestedToolName");
  const patchOperation = readMetadataString(metadata, "patchOperation");
  const patchPath = readMetadataString(metadata, "patchPath");
  const versions = [
    readMetadataString(metadata, "promptArchitectureVersion"),
    readMetadataString(metadata, "actionContractVersion"),
    readMetadataString(metadata, "toolCatalogVersion"),
  ].filter((item): item is string => Boolean(item));
  const exposedToolNames = readMetadataStringArray(metadata, "exposedToolNames");

  if (requestedToolName) {
    parts.push(`tool ${requestedToolName}`);
  }

  if (patchOperation && patchPath) {
    parts.push(`patch ${patchOperation} ${patchPath}`);
  }

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

function getHelarcApi() {
  return typeof window === "undefined" ? null : window.helarc;
}

function approvalCategoryLabel(
  category: PendingApprovalView["request"]["category"],
): string {
  switch (category) {
    case "commandExecution": return "Command execution";
    case "fileChange": return "File change";
    case "permissions": return "Additional permissions";
    case "mcpToolCall": return "MCP tool call";
    case "skill": return "Skill action";
    case "networkAccess": return "Network access";
  }
}

function approvalRequestSummary(
  request: PendingApprovalView["request"],
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
    case "mcpToolCall":
      return `${request.payload.serverDisplayName}: ${request.payload.toolName}`;
    case "skill":
      return `${request.payload.skillDisplayName}: ${request.payload.action}`;
    case "networkAccess":
      return request.payload.actionSummary;
  }
}

function approvalOptionButtonClass(
  kind: PendingApprovalView["request"]["decisionOptions"][number]["kind"],
): string {
  if (kind === "decline" || kind === "cancel") {
    return "secondary-button danger";
  }
  return "primary-button compact";
}

function defaultGrantedPermissions(
  approval: PendingApprovalView,
  optionKind: PendingApprovalView["request"]["decisionOptions"][number]["kind"],
) {
  if (optionKind !== "grantPermissions") return null;
  const request = approval.request;
  switch (request.category) {
    case "commandExecution":
    case "fileChange":
      return request.payload.additionalPermissions;
    case "permissions":
      return request.payload.permissions;
    case "skill":
      return request.payload.requiredPermissions;
    case "mcpToolCall":
    case "networkAccess":
      return null;
  }
}

function getPendingApproval(run: HelarcMainSnapshot["run"]): PendingApprovalView | null {
  const approval = run?.platform.approval ?? null;
  return approval?.review === null || approval === null
    ? null
    : { ...approval.review, phase: approval.phase };
}

function getPendingPatchReview(run: HelarcMainSnapshot["run"]) {
  const phase = run?.product.phase;
  return phase?.kind === "waiting_for_patch_review" ? phase.review : null;
}

function activitySeverity(
  activity: ActiveRunProjection["product"]["activity"][number],
): "info" | "warning" | "error" {
  if (
    activity.kind === "run.failed" || activity.kind === "run.blocked" ||
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

function renderTaskTemplatePrompt(promptText: string, constraints: string[]): string {
  if (constraints.length === 0) {
    return promptText;
  }

  return `${promptText}\n\nConstraints:\n${constraints.map((constraint) => `- ${constraint}`).join("\n")}`;
}
