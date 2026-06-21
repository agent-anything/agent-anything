import {
  Activity,
  FileCode2,
  FolderOpen,
  Play,
  Settings,
  ShieldCheck,
} from "lucide-react";

export function App() {
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
          <span className="workspace-path">No workspace selected</span>
        </div>
        <button className="secondary-button" type="button" disabled>
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
            <span className="status-indicator"><span /> Idle</span>
          </div>
          <div className="empty-state">
            <Activity size={28} aria-hidden="true" />
            <h2>No active session</h2>
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
            <FileCode2 size={24} aria-hidden="true" />
            <span>No pending review</span>
          </div>
        </aside>
      </main>

      <form className="task-composer">
        <label htmlFor="task-input">Task</label>
        <div className="composer-row">
          <textarea
            id="task-input"
            name="task"
            rows={2}
            placeholder="Describe a code task..."
            disabled
          />
          <button className="primary-button" type="submit" disabled>
            <Play size={17} fill="currentColor" aria-hidden="true" />
            Start
          </button>
        </div>
      </form>
    </div>
  );
}
