import {
  Activity,
  AlertCircle,
  CheckCircle2,
  CircleStop,
  FileCode2,
  FolderOpen,
  History,
  Play,
  Settings,
  ShieldCheck,
} from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import type {
  HelarcMainSnapshot,
  HelarcProviderKind,
  HelarcSessionHistoryRecord,
  HelarcStartSessionResult,
} from "../shared/HelarcDesktopApi.js";

const initialSnapshot: HelarcMainSnapshot = {
  status: "idle",
  workspace: null,
  workspaceProfiles: [],
  sessionHistory: [],
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
  pendingPermission: null,
  pendingPatchReview: null,
  activity: [],
  activeRun: {
    runId: "",
    status: "idle",
    task: {
      text: "",
      templateId: null,
    },
    workspace: null,
    provider: null,
    events: [],
    pendingPermission: null,
    terminal: null,
    startedAt: null,
    metadata: {},
  },
  output: null,
  error: null,
};

type SidePanelMode = "review" | "history" | "settings";

export function App() {
  const [snapshot, setSnapshot] = useState<HelarcMainSnapshot>(initialSnapshot);
  const [taskText, setTaskText] = useState("");
  const [isBusy, setIsBusy] = useState(false);
  const [startResult, setStartResult] = useState<HelarcStartSessionResult | null>(null);
  const [selectedHistoryId, setSelectedHistoryId] = useState<string | null>(null);
  const [sidePanelMode, setSidePanelMode] = useState<SidePanelMode>("review");
  const sessionActive = isSessionActive(snapshot.status);
  const selectedHistory = snapshot.sessionHistory.find((record) => record.id === selectedHistoryId) ?? null;
  const activePanelMode: SidePanelMode = snapshot.pendingPermission || snapshot.pendingPatchReview
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
      && !sessionActive
    ),
    [isBusy, sessionActive, snapshot.provider.configured, snapshot.workspace, taskText],
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
      setSelectedHistoryId(null);
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
      setSelectedHistoryId(null);
    } finally {
      setIsBusy(false);
    }
  }

  async function startSession(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const api = getHelarcApi();
    if (!api || !canStart) {
      return;
    }

    setSnapshot((current) => ({ ...current, status: "running", activity: [], output: null, error: null }));
    setIsBusy(true);
    try {
      const result = await api.startSession({ taskText });
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

  async function resolvePermission(decision: "granted" | "denied") {
    const api = getHelarcApi();
    const pendingPermission = snapshot.pendingPermission;
    if (!api || !pendingPermission) {
      return;
    }

    setIsBusy(true);
    try {
      const result = await api.resolvePermission({
        requestId: pendingPermission.requestId,
        decision,
      });
      setSnapshot(result.snapshot);
    } finally {
      setIsBusy(false);
    }
  }

  async function cancelSession() {
    const api = getHelarcApi();
    if (!api) {
      return;
    }

    setIsBusy(true);
    try {
      const result = await api.cancelSession();
      setSnapshot(result.snapshot);
    } finally {
      setIsBusy(false);
    }
  }

  async function resolvePatchReview(decision: "accepted" | "rejected") {
    const api = getHelarcApi();
    const pendingPatchReview = snapshot.pendingPatchReview;
    if (!api || !pendingPatchReview) {
      return;
    }

    setIsBusy(true);
    try {
      const result = await api.resolvePatchReview({
        patchId: pendingPatchReview.patchId,
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
  const canCancelRun = isRunCancellable(snapshot.activeRun.status) &&
    snapshot.activeRun.status !== "cancelling" &&
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
            className={activePanelMode === "history" ? "nav-button active" : "nav-button"}
            type="button"
            onClick={() => setSidePanelMode("history")}
            title="History"
          >
            <History size={16} aria-hidden="true" />
            History
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
              {isRunCancellable(snapshot.activeRun.status) ? (
                <button
                  className="secondary-button danger compact-icon"
                  type="button"
                  onClick={() => void cancelSession()}
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
          <RunTimelinePanel
            activeRun={snapshot.activeRun}
            acceptedTask={snapshot.acceptedTask}
          />
        </section>

        <aside className="review-pane" aria-labelledby="review-title">
          <div className="pane-header compact">
            <div>
              <span className="eyebrow">{sidePanelEyebrow(activePanelMode)}</span>
              <h2 id="review-title">{sidePanelTitle(activePanelMode)}</h2>
            </div>
            {activePanelMode === "history"
              ? <History size={19} aria-hidden="true" />
              : activePanelMode === "settings"
                ? <Settings size={19} aria-hidden="true" />
                : <ShieldCheck size={19} aria-hidden="true" />}
          </div>
          <div className={activePanelMode !== "review" || snapshot.pendingPermission || snapshot.pendingPatchReview || snapshot.activeRun.terminal || snapshot.error
            ? "review-content"
            : "review-empty"}
          >
            {activePanelMode === "history" ? (
              <HistoryPanel
                records={snapshot.sessionHistory}
                selectedHistory={selectedHistory}
                selectedHistoryId={selectedHistoryId}
                onSelectHistory={setSelectedHistoryId}
              />
            ) : activePanelMode === "settings" ? (
              <SettingsPanel snapshot={snapshot} onSaved={setSnapshot} />
            ) : snapshot.pendingPermission ? (
              <PermissionPromptPanel
                prompt={snapshot.pendingPermission}
                isBusy={isBusy}
                onCancel={() => void cancelSession()}
                onResolve={(decision) => void resolvePermission(decision)}
              />
            ) : snapshot.pendingPatchReview ? (
              <div className="patch-panel">
                <FileCode2 size={24} aria-hidden="true" />
                <strong>{snapshot.pendingPatchReview.summary}</strong>
                <span>{snapshot.pendingPatchReview.operation} - {snapshot.pendingPatchReview.path}</span>
                <div className="patch-preview">
                  <section>
                    <span>Original</span>
                    <pre>{snapshot.pendingPatchReview.originalContent ?? ""}</pre>
                  </section>
                  <section>
                    <span>Proposed</span>
                    <pre>{snapshot.pendingPatchReview.proposedContent ?? ""}</pre>
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
            ) : snapshot.activeRun.terminal ? (
              <RunTerminalPanel
                title={terminalTitle(snapshot)}
                terminal={snapshot.activeRun.terminal}
                events={snapshot.activeRun.events}
              />
            ) : (
              <>
                <FileCode2 size={24} aria-hidden="true" />
                <span>{sessionActive ? "Waiting for next action" : "No pending review"}</span>
              </>
            )}
          </div>
        </aside>
      </main>

      <form className="task-composer" onSubmit={startSession}>
        <div className="composer-heading">
          <label htmlFor="task-input">Task</label>
          <select
            aria-label="Task templates"
            value=""
            onChange={(event) => applyTaskTemplate(event.target.value)}
            disabled={isBusy || sessionActive || snapshot.taskTemplates.length === 0}
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
            disabled={!snapshot.workspace || !snapshot.provider.configured || isBusy || sessionActive}
          />
          <button className="primary-button" type="submit" disabled={!canStart}>
            <Play size={17} fill="currentColor" aria-hidden="true" />
            Start
          </button>
        </div>
        {!snapshot.provider.configured ? <p className="composer-message error">{snapshot.provider.error.message}</p> : null}
        {snapshot.error ? <p className="composer-message error">{snapshot.error.message}</p> : null}
        {startResult?.ok ? <p className="composer-message">Session started</p> : null}
      </form>
    </div>
  );
}

export function RunTimelinePanel({
  activeRun,
  acceptedTask,
}: {
  activeRun: HelarcMainSnapshot["activeRun"];
  acceptedTask: HelarcMainSnapshot["acceptedTask"];
}) {
  if (activeRun.events.length === 0) {
    const title = activeRun.task.text || acceptedTask?.prompt || "No active session";
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
        <strong>{activeRun.task.text}</strong>
        <span>{runStatusLabel(activeRun.status)}</span>
      </div>
      {activeRun.events.map((event) => (
        <div className={`activity-item severity-${event.severity}`} key={event.id}>
          <Activity size={16} aria-hidden="true" />
          <div>
            <strong>{event.title}</strong>
            {event.detail ? <span>{event.detail}</span> : null}
            <small>{formatTimestamp(event.timestamp)}</small>
          </div>
        </div>
      ))}
    </div>
  );
}

export function RunTerminalPanel({
  title,
  terminal,
  events,
}: {
  title: string;
  terminal: NonNullable<HelarcMainSnapshot["activeRun"]["terminal"]>;
  events: HelarcMainSnapshot["activeRun"]["events"];
}) {
  const safeOutput = isSessionOutput(terminal.safeOutput) ? terminal.safeOutput : null;
  const failed = terminal.status === "failed" || terminal.status === "denied" || terminal.status === "cancelled";

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
          <dd>{terminal.runtimeStatus ?? "unknown"}</dd>
        </div>
        {terminal.runtimeCode ? (
          <div>
            <dt>Code</dt>
            <dd>{terminal.runtimeCode}</dd>
          </div>
        ) : null}
        <div>
          <dt>Events</dt>
          <dd>{terminal.eventCount}</dd>
        </div>
        <div>
          <dt>Started</dt>
          <dd>{formatTimestamp(terminal.startedAt)}</dd>
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
      {terminal.errorSummary.length > 0 ? (
        <ul className="error-list">
          {terminal.errorSummary.map((error) => (
            <li key={`${error.code}:${error.message}`}>
              <strong>{error.code}</strong>
              <span>{error.message}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {events.length > 0 ? (
        <section className="terminal-events" aria-label="Terminal event summary">
          <strong>Event summary</strong>
          {events.slice(-4).map((event) => (
            <span key={event.id}>{event.title}</span>
          ))}
        </section>
      ) : null}
    </div>
  );
}

export function PermissionPromptPanel({
  prompt,
  isBusy,
  onCancel,
  onResolve,
}: {
  prompt: HelarcMainSnapshot["pendingPermission"];
  isBusy: boolean;
  onCancel: () => void;
  onResolve: (decision: "granted" | "denied") => void;
}) {
  if (!prompt) {
    return null;
  }

  return (
    <div className="permission-panel">
      <ShieldCheck size={24} aria-hidden="true" />
      <strong>{prompt.toolName}</strong>
      <span>{prompt.reason}</span>
      <code>{formatCommand(prompt.command, prompt.args)}</code>
      <div className="permission-meta">
        <span>{prompt.rootName ?? "workspace"}</span>
        <span>{prompt.cwd ?? "."}</span>
      </div>
      <div className="permission-actions">
        <button
          className="secondary-button"
          type="button"
          onClick={onCancel}
          disabled={isBusy}
        >
          Cancel
        </button>
        <button
          className="secondary-button danger"
          type="button"
          onClick={() => onResolve("denied")}
          disabled={isBusy}
        >
          Deny
        </button>
        <button
          className="primary-button compact"
          type="button"
          onClick={() => onResolve("granted")}
          disabled={isBusy}
        >
          Approve
        </button>
      </div>
    </div>
  );
}

function HistoryPanel({
  records,
  selectedHistory,
  selectedHistoryId,
  onSelectHistory,
}: {
  records: HelarcSessionHistoryRecord[];
  selectedHistory: HelarcSessionHistoryRecord | null;
  selectedHistoryId: string | null;
  onSelectHistory: (recordId: string) => void;
}) {
  if (records.length === 0) {
    return (
      <div className="panel-empty">
        <History size={24} aria-hidden="true" />
        <span>No completed sessions yet</span>
      </div>
    );
  }

  return (
    <>
      <section className="history-list" aria-label="Session history">
        <strong>History</strong>
        {records.slice(0, 8).map((record) => (
          <button
            className={record.id === selectedHistoryId ? "history-item selected" : "history-item"}
            key={record.id}
            type="button"
            onClick={() => onSelectHistory(record.id)}
          >
            <span>{record.taskText}</span>
            <small>{record.status} - {record.workspace.displayName}</small>
          </button>
        ))}
      </section>
      {selectedHistory ? <HistoryRecordView record={selectedHistory} /> : null}
    </>
  );
}

function HistoryRecordView({ record }: { record: HelarcSessionHistoryRecord }) {
  return (
    <section className="history-record" aria-label="Selected session history">
      <strong>{record.taskText}</strong>
      <dl>
        <div>
          <dt>Run</dt>
          <dd>{record.run.status}</dd>
        </div>
        <div>
          <dt>Workspace</dt>
          <dd>{record.workspace.displayName}</dd>
        </div>
        <div>
          <dt>Provider</dt>
          <dd>{record.provider.displayName}</dd>
        </div>
        <div>
          <dt>Patch</dt>
          <dd>{record.patch.status ?? "none"}</dd>
        </div>
      </dl>
      <RunTerminalPanel
        title={`History ${record.run.status}`}
        terminal={record.run.terminal}
        events={record.run.events}
      />
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
          min="1"
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

  if (isSessionActive(status)) {
    return "active";
  }

  return "idle";
}

function sidePanelEyebrow(mode: SidePanelMode): string {
  if (mode === "history") {
    return "Completed work";
  }

  if (mode === "settings") {
    return "Desktop state";
  }

  return "Pending action";
}

function sidePanelTitle(mode: SidePanelMode): string {
  if (mode === "history") {
    return "History";
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

function isSessionActive(status: HelarcMainSnapshot["status"]): boolean {
  return status === "running" ||
    status === "waiting_for_permission" ||
    status === "waiting_for_patch_review" ||
    status === "applying_patch";
}

function isRunCancellable(status: HelarcMainSnapshot["activeRun"]["status"]): boolean {
  return status === "starting" ||
    status === "running" ||
    status === "waiting_for_permission" ||
    status === "cancelling";
}

function runStatusLabel(status: HelarcMainSnapshot["activeRun"]["status"]): string {
  return status[0]?.toUpperCase() + status.slice(1).replaceAll("_", " ");
}

function terminalTitle(snapshot: HelarcMainSnapshot): string {
  const terminalStatus = snapshot.activeRun.terminal?.status;
  if (terminalStatus === "denied") {
    return "Run denied";
  }

  if (terminalStatus === "cancelled") {
    return "Run cancelled";
  }

  if (snapshot.status === "rejected") {
    return "Change rejected";
  }

  if (snapshot.status === "failed") {
    return "Session failed";
  }

  if (snapshot.status === "blocked") {
    return "Session blocked";
  }

  if (snapshot.output?.patchStatus === "applied") {
    return "Patch applied";
  }

  return "Session completed";
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

function isSessionOutput(value: unknown): value is NonNullable<HelarcMainSnapshot["output"]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const output = value as Partial<NonNullable<HelarcMainSnapshot["output"]>>;
  return typeof output.taskId === "string" &&
    typeof output.runtimeStatus === "string" &&
    Array.isArray(output.safeErrors);
}

function getHelarcApi() {
  return typeof window === "undefined" ? null : window.helarc;
}

function formatCommand(command: string | null, args: string[]): string {
  if (!command) {
    return "unknown command";
  }

  return [command, ...args].join(" ");
}

function renderTaskTemplatePrompt(promptText: string, constraints: string[]): string {
  if (constraints.length === 0) {
    return promptText;
  }

  return `${promptText}\n\nConstraints:\n${constraints.map((constraint) => `- ${constraint}`).join("\n")}`;
}
