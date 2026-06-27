import {
  Activity,
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
  activity: [],
  output: null,
  error: null,
};

export function App() {
  const [snapshot, setSnapshot] = useState<HelarcMainSnapshot>(initialSnapshot);
  const [taskText, setTaskText] = useState("");
  const [isBusy, setIsBusy] = useState(false);
  const [startResult, setStartResult] = useState<HelarcStartSessionResult | null>(null);

  useEffect(() => {
    const api = getHelarcApi();
    if (!api) {
      return;
    }

    void api.getSnapshot().then(setSnapshot);
  }, []);

  const canStart = useMemo(
    () => Boolean(snapshot.workspace && snapshot.provider.configured && taskText.trim().length > 0 && !isBusy),
    [isBusy, snapshot.provider.configured, snapshot.workspace, taskText],
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

    setIsBusy(true);
    setSnapshot((current) => ({ ...current, status: "running", activity: [], output: null, error: null }));
    try {
      const result = await api.startSession({ taskText });
      setStartResult(result);
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
            <span className="status-indicator"><span /> {statusText}</span>
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
          <div className="review-empty">
            {snapshot.output ? <CheckCircle2 size={24} aria-hidden="true" /> : <FileCode2 size={24} aria-hidden="true" />}
            <span>{snapshot.output?.agentSummary ?? "No pending review"}</span>
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
            disabled={!snapshot.workspace || !snapshot.provider.configured || isBusy}
          />
          <button className="primary-button" type="submit" disabled={!canStart}>
            <Play size={17} fill="currentColor" aria-hidden="true" />
            Start
          </button>
        </div>
        {!snapshot.provider.configured ? <p className="composer-message error">{snapshot.provider.error.message}</p> : null}
        {snapshot.error ? <p className="composer-message error">{snapshot.error.message}</p> : null}
        {startResult?.ok ? <p className="composer-message">Session completed</p> : null}
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

function getHelarcApi() {
  return typeof window === "undefined" ? null : window.helarc;
}
