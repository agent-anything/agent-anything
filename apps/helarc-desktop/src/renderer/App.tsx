import {
  Activity,
  AlertCircle,
  CheckCircle2,
  FileCode2,
  FolderOpen,
  Play,
  Settings,
  ShieldCheck,
} from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import type { HelarcMainSnapshot, HelarcStartSessionResult } from "../shared/HelarcDesktopApi.js";

const initialSnapshot: HelarcMainSnapshot = {
  status: "idle",
  workspace: null,
  provider: { configured: true, error: null },
  acceptedTask: null,
  pendingPermission: null,
  pendingPatchReview: null,
  activity: [],
  output: null,
  error: null,
};

export function App() {
  const [snapshot, setSnapshot] = useState<HelarcMainSnapshot>(initialSnapshot);
  const [taskText, setTaskText] = useState("");
  const [isBusy, setIsBusy] = useState(false);
  const [startResult, setStartResult] = useState<HelarcStartSessionResult | null>(null);
  const sessionActive = isSessionActive(snapshot.status);

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
  const activityTitle = snapshot.acceptedTask
    ? snapshot.acceptedTask.prompt
    : "No active session";

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
        <button className="icon-button" type="button" aria-label="Settings" title="Settings" disabled>
          <Settings size={18} />
        </button>
      </header>

      <section className="workspace-bar" aria-label="Workspace">
        <div className="workspace-identity">
          <FolderOpen size={17} aria-hidden="true" />
          <span className="label">Workspace</span>
          <span className="workspace-path" title={workspaceLabel}>{workspaceLabel}</span>
        </div>
        <button className="secondary-button" type="button" onClick={chooseWorkspace} disabled={isBusy}>
          <FolderOpen size={16} aria-hidden="true" />
          Choose workspace
        </button>
      </section>

      <main className="workbench">
        <section className="activity-pane" aria-labelledby="activity-title">
          <div className="pane-header">
            <div>
              <span className="eyebrow">Current session</span>
              <h1 id="activity-title">Activity</h1>
            </div>
            <span className={`status-indicator ${statusTone(snapshot.status)}`}><span /> {statusText}</span>
          </div>
          <div className={snapshot.activity.length > 0 ? "activity-list" : "empty-state"}>
            {snapshot.activity.length === 0 ? (
              <>
                <Activity size={28} aria-hidden="true" />
                <h2>{activityTitle}</h2>
                {snapshot.acceptedTask ? <p>Validated task {snapshot.acceptedTask.id}</p> : null}
              </>
            ) : snapshot.activity.map((item) => (
              <div className="activity-item" key={item.id}>
                <Activity size={16} aria-hidden="true" />
                <div>
                  <strong>{item.title}</strong>
                  {item.detail ? <span>{item.detail}</span> : null}
                </div>
              </div>
            ))}
          </div>
        </section>

        <aside className="review-pane" aria-labelledby="review-title">
          <div className="pane-header compact">
            <div>
              <span className="eyebrow">Pending action</span>
              <h2 id="review-title">Review</h2>
            </div>
            <ShieldCheck size={19} aria-hidden="true" />
          </div>
          <div className={snapshot.pendingPermission || snapshot.pendingPatchReview || snapshot.output || snapshot.error
            ? "review-content"
            : "review-empty"}
          >
            {snapshot.pendingPermission ? (
              <div className="permission-panel">
                <ShieldCheck size={24} aria-hidden="true" />
                <strong>{snapshot.pendingPermission.toolName}</strong>
                <span>{snapshot.pendingPermission.reason}</span>
                <code>{formatCommand(snapshot.pendingPermission.command, snapshot.pendingPermission.args)}</code>
                <div className="permission-meta">
                  <span>{snapshot.pendingPermission.rootName ?? "workspace"}</span>
                  <span>{snapshot.pendingPermission.cwd ?? "."}</span>
                </div>
                <div className="permission-actions">
                  <button
                    className="secondary-button danger"
                    type="button"
                    onClick={() => void resolvePermission("denied")}
                    disabled={isBusy}
                  >
                    Deny
                  </button>
                  <button
                    className="primary-button compact"
                    type="button"
                    onClick={() => void resolvePermission("granted")}
                    disabled={isBusy}
                  >
                    Approve
                  </button>
                </div>
              </div>
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
            ) : snapshot.output ? (
              <div className="result-panel">
                {snapshot.output.safeErrors.length > 0 || snapshot.status === "failed" ? (
                  <AlertCircle size={24} aria-hidden="true" />
                ) : (
                  <CheckCircle2 size={24} aria-hidden="true" />
                )}
                <strong>{terminalTitle(snapshot)}</strong>
                {snapshot.output.agentSummary ? <span>{snapshot.output.agentSummary}</span> : null}
                <dl>
                  <div>
                    <dt>Runtime</dt>
                    <dd>{snapshot.output.runtimeStatus}</dd>
                  </div>
                  <div>
                    <dt>Patch</dt>
                    <dd>{snapshot.output.patchStatus ?? "none"}</dd>
                  </div>
                  {snapshot.output.appliedPath ? (
                    <div>
                      <dt>Applied</dt>
                      <dd>{snapshot.output.appliedPath}</dd>
                    </div>
                  ) : null}
                </dl>
                {snapshot.output.safeErrors.length > 0 ? (
                  <ul className="error-list">
                    {snapshot.output.safeErrors.map((error) => (
                      <li key={`${error.code}:${error.message}`}>
                        <strong>{error.code}</strong>
                        <span>{error.message}</span>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
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
        <label htmlFor="task-input">Task</label>
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

function isSessionActive(status: HelarcMainSnapshot["status"]): boolean {
  return status === "running" ||
    status === "waiting_for_permission" ||
    status === "waiting_for_patch_review" ||
    status === "applying_patch";
}

function terminalTitle(snapshot: HelarcMainSnapshot): string {
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

function getHelarcApi() {
  return typeof window === "undefined" ? null : window.helarc;
}

function formatCommand(command: string | null, args: string[]): string {
  if (!command) {
    return "unknown command";
  }

  return [command, ...args].join(" ");
}
