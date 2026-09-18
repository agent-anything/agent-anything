import * as React from "react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Group, Panel, Separator, type Layout } from "react-resizable-panels";
import {
  ArrowUp,
  CircleStop,
  FolderOpen,
  History,
  PanelRight,
  Settings,
  X,
  RotateCcw,
  Plus,
} from "lucide-react";
import type {
  HelarcActiveDelegationSnapshot,
  HelarcMainSnapshot,
} from "../shared/HelarcDesktopApi.js";
import type {
  ThreadRunSummary,
  WorkbenchScope,
} from "../shared/HelarcWorkbench.js";
import { SettingsPage } from "./SettingsPage.js";
import { Conversation } from "./conversation/Conversation.js";
import { AttentionPanel } from "./interactions/AttentionPanel.js";
import { ExecutionPanel } from "./execution/ExecutionPanel.js";

const initialSnapshot: HelarcMainSnapshot = {
  status: "idle",
  workspace: null,
  workspaceProfiles: [],
  acceptedTask: null,
  activeThread: null,
  threadSummaries: [],
  run: null,
  error: null,
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
};
const commandId = (kind: string) =>
  `helarc-desktop-${kind}-${crypto.randomUUID()}`;
export function App() {
  const [snapshot, setSnapshot] = useState(initialSnapshot);
  const [settings, setSettings] = useState(false);
  const [threads, setThreads] = useState(false);
  const [execution, setExecution] = useState(true);
  const [requests, setRequests] = useState(false);
  const [draft, setDraft] = useState("");
  const [steering, setSteering] = useState("");
  const [newThread, setNewThread] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [runs, setRuns] = useState<readonly ThreadRunSummary[]>([]);
  const [selected, setSelected] = useState<WorkbenchScope | null>(null);
  const [wide, setWide] = useState(
    () => typeof window === "undefined" || window.innerWidth >= 1100,
  );
  const [layout, setLayout] = useState<Layout | undefined>(() => {
    try {
      return (
        JSON.parse(localStorage.getItem("helarc.workbench.layout") ?? "null") ??
        undefined
      );
    } catch {
      return undefined;
    }
  });
  const [layoutKey, setLayoutKey] = useState(0);
  const input = useRef<HTMLTextAreaElement>(null);
  const runActive = !!snapshot.run && !snapshot.run.display.terminal;
  const attentionCount = runActive
    ? snapshot.run!.host.pendingInteractions.length
    : 0;
  useEffect(() => {
    if (!window.helarc) return;
    void window.helarc
      .getSnapshot()
      .then(setSnapshot)
      .catch(() => setError("Desktop connection unavailable."));
    return window.helarc.subscribeSnapshot(setSnapshot);
  }, []);
  useEffect(() => {
    const query = window.matchMedia("(min-width: 1100px)");
    const changed = () => setWide(query.matches);
    query.addEventListener("change", changed);
    return () => query.removeEventListener("change", changed);
  }, []);
  useEffect(() => {
    let disposed = false;
    const threadId = snapshot.activeThread?.id;
    if (!threadId) {
      setRuns([]);
      setSelected(null);
      return;
    }
    void window.helarc
      .listThreadRuns({ threadId })
      .then((result) => {
        if (disposed || result.status !== "page") return;
        setRuns(result.runs);
        setSelected((previous) =>
          previous?.threadId === threadId &&
          result.runs.some((run) => run.productRunId === previous.productRunId)
            ? previous
            : result.runs.at(-1)?.harnessRunId
              ? {
                  threadId,
                  productRunId: result.runs.at(-1)!.productRunId,
                  runId: result.runs.at(-1)!.harnessRunId!,
                }
              : null,
        );
      })
      .catch(() => {
        if (!disposed) setError("Run history could not be read.");
      });
    return () => {
      disposed = true;
    };
  }, [
    snapshot.activeThread?.id,
    snapshot.activeThread?.revision,
    snapshot.run?.display.status,
  ]);
  async function perform(work: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch {
      setError("The request could not be delivered.");
    } finally {
      setBusy(false);
    }
  }
  async function chooseWorkspace(profileId?: string) {
    await perform(async () => {
      const receipt = profileId
        ? await window.helarc.selectWorkspaceProfile({
            commandId: commandId("workspace.select"),
            profileId,
          })
        : await window.helarc.chooseWorkspace({
            commandId: commandId("workspace.choose"),
          });
      if (receipt.status === "handled") setSnapshot(receipt.result);
      else setError(receipt.code);
    });
  }
  async function openThread(threadId: string) {
    await perform(async () => {
      const receipt = await window.helarc.openThread({
        commandId: commandId("thread.open"),
        threadId,
      });
      if (receipt.status === "handled") {
        setSnapshot(receipt.result.snapshot);
        if (receipt.result.ok) {
          setThreads(false);
          setNewThread(false);
        } else setError(receipt.result.error.message);
      } else setError(receipt.code);
    });
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!(runActive ? steering : draft).trim() || busy) return;
    await perform(async () => {
      if (runActive && snapshot.run) {
        const result = await window.helarc.steerRun({
          commandId: commandId("run.steer"),
          runId: snapshot.run.harnessRunId,
          expectedRunRevision: snapshot.run.host.runRevision,
          instruction: steering,
        });
        setSnapshot(result.snapshot);
        if (result.receipt.status === "rejected") setError(result.receipt.code);
        else if (
          result.receipt.kind === "run.steer" &&
          result.receipt.result.status === "rejected"
        )
          setError(result.receipt.result.code);
        else setSteering("");
      } else {
        const receipt = await window.helarc.startRun({
          commandId: commandId("run.start"),
          taskText: draft,
          target:
            snapshot.activeThread && !newThread
              ? { kind: "continue_thread", threadId: snapshot.activeThread.id }
              : { kind: "new_thread" },
        });
        if (receipt.status === "handled") {
          setSnapshot(receipt.result.snapshot);
          if (receipt.result.ok) {
            setDraft("");
            setNewThread(false);
            setSelected(null);
          } else setError(receipt.result.error.message);
        } else setError(receipt.code);
      }
    });
  }
  async function cancel() {
    const run = snapshot.run;
    if (!run) return;
    await perform(async () => {
      const result = await window.helarc.cancelRun({
        commandId: commandId("run.cancel"),
        runId: run.harnessRunId,
        reason: "Cancelled from Helarc desktop.",
      });
      setSnapshot(result.snapshot);
      if (result.receipt.status === "rejected") setError(result.receipt.code);
    });
  }
  async function resume(delegation: HelarcActiveDelegationSnapshot) {
    const run = snapshot.run,
      suspension = delegation.suspension;
    if (!run || !suspension) return;
    await perform(async () => {
      const result = await window.helarc.resumeDescendant({
        commandId: commandId("descendant.resume"),
        runId: run.harnessRunId,
        request: delegation.request,
        relation: delegation.relation,
        child: delegation.child,
        expectedRunRevision: suspension.runRevision,
        suspension: { id: suspension.id, revision: suspension.revision },
        reason: "Resume requested from Helarc desktop.",
      });
      setSnapshot(result.snapshot);
      if (result.receipt.status === "rejected") setError(result.receipt.code);
      else if (result.receipt.kind === "descendant.resume") {
        if (result.receipt.result.status === "rejected")
          setError(result.receipt.result.code);
        else if (result.receipt.result.resume.status === "rejected")
          setError(result.receipt.result.resume.code);
      }
    });
  }
  function inspect(run: ThreadRunSummary) {
    if (run.harnessRunId && snapshot.activeThread)
      setSelected({
        threadId: snapshot.activeThread.id,
        productRunId: run.productRunId,
        runId: run.harnessRunId,
      });
    setExecution(true);
  }
  const executionView = (
    <ExecutionPanel
      snapshot={snapshot}
      runs={runs}
      selected={selected}
      onSelect={setSelected}
      visible={execution && !settings}
      onClose={() => setExecution(false)}
      onResume={(delegation) => void resume(delegation)}
    />
  );
  const conversation = (
    <section className="wb-conversation" aria-label="Conversation">
      <Conversation snapshot={snapshot} runs={runs} onInspect={inspect} />
      <form className="wb-composer" onSubmit={submit}>
        <div className="wb-composer-heading">
          <label htmlFor="task-input">
            {runActive
              ? "Message active Run"
              : newThread
                ? "New thread"
                : "Message"}
          </label>
          {snapshot.run && (
            <span className={`wb-status ${snapshot.run.display.status}`}>
              {snapshot.run.display.status.replaceAll("_", " ")}
            </span>
          )}
        </div>
        <div className="wb-composer-row">
          <textarea
            ref={input}
            id="task-input"
            rows={3}
            value={runActive ? steering : draft}
            onChange={(event) =>
              runActive
                ? setSteering(event.target.value)
                : setDraft(event.target.value)
            }
            placeholder={runActive ? "Add guidance..." : "Describe a task..."}
            disabled={busy}
          />
          {runActive && (
            <button
              type="button"
              className="wb-icon danger"
              title="Cancel run"
              aria-label="Cancel run"
              disabled={busy || snapshot.run?.display.status === "cancelling"}
              onClick={() => void cancel()}
            >
              <CircleStop size={18} />
            </button>
          )}
          <button
            type="submit"
            className="wb-send"
            title={runActive ? "Send guidance" : "Start run"}
            aria-label={runActive ? "Send guidance" : "Start run"}
            disabled={
              busy ||
              !(runActive ? steering : draft).trim() ||
              !snapshot.workspace ||
              !snapshot.provider.configured
            }
          >
            <ArrowUp size={19} />
          </button>
        </div>
        {(error || snapshot.error) && (
          <p className="wb-warning" role="alert">
            {error ?? snapshot.error?.message}
          </p>
        )}
        {!snapshot.provider.configured && (
          <button
            type="button"
            className="wb-link"
            onClick={() => setSettings(true)}
          >
            Configure Provider
          </button>
        )}
      </form>
    </section>
  );
  return (
    <>
      <div className="wb-shell" hidden={settings}>
        <header className="wb-header">
          <span className="wb-brand">H</span>
          <button
            className="wb-icon"
            title="Threads"
            aria-label="Threads"
            onClick={() => setThreads(true)}
          >
            <History size={18} />
          </button>
          <div className="wb-title">
            <strong>
              {newThread
                ? "New thread"
                : (snapshot.activeThread?.title ?? "Helarc")}
            </strong>
            <button
              type="button"
              className="wb-workspace"
              title={snapshot.workspace?.path ?? "Choose workspace"}
              onClick={() => void chooseWorkspace()}
              disabled={busy || runActive}
            >
              <FolderOpen size={13} />
              {snapshot.workspace?.name ?? "No workspace selected"}
            </button>
          </div>
          <button
            type="button"
            className="wb-icon"
            title="New thread"
            aria-label="New thread"
            disabled={runActive}
            onClick={() => {
              setNewThread(true);
              input.current?.focus();
            }}
          >
            <Plus size={18} />
          </button>
          <button
            type="button"
            className={`wb-request-toggle ${attentionCount ? "has-requests" : ""}`}
            onClick={() => setRequests((value) => !value)}
          >
            Requests {attentionCount}
          </button>
          <button
            type="button"
            className="wb-icon"
            title="Execution"
            aria-label="Toggle execution"
            aria-pressed={execution}
            onClick={() => setExecution((value) => !value)}
          >
            <PanelRight size={18} />
          </button>
          <button
            type="button"
            className="wb-icon"
            title="Reset layout"
            aria-label="Reset layout"
            onClick={() => {
              setLayout(undefined);
              localStorage.removeItem("helarc.workbench.layout");
              setLayoutKey((value) => value + 1);
            }}
          >
            <RotateCcw size={15} />
          </button>
          <button
            type="button"
            className="wb-icon"
            title="Settings"
            aria-label="Open settings"
            onClick={() => setSettings(true)}
          >
            <Settings size={18} />
          </button>
        </header>
        <main className="wb-main">
          {wide ? (
            <Group
              key={layoutKey}
              defaultLayout={layout}
              onLayoutChanged={(value, meta) => {
                if (meta.isUserInteraction) {
                  setLayout(value);
                  localStorage.setItem(
                    "helarc.workbench.layout",
                    JSON.stringify(value),
                  );
                }
              }}
            >
              <Panel id="conversation" minSize="520px">
                {conversation}
              </Panel>
              {execution && (
                <>
                  <Separator
                    className="wb-separator"
                    aria-label="Resize execution panel"
                  />
                  <Panel
                    id="execution"
                    defaultSize="380px"
                    minSize="320px"
                    maxSize="50%"
                  >
                    {executionView}
                  </Panel>
                </>
              )}
            </Group>
          ) : (
            conversation
          )}
        </main>
        {!wide && execution && (
          <Overlay
            label="Execution panel"
            onClose={() => setExecution(false)}
            side="right"
          >
            {executionView}
          </Overlay>
        )}
        {threads && (
          <Overlay
            label="Threads"
            onClose={() => setThreads(false)}
            side="left"
          >
            <header className="wb-panel-header">
              <strong>Threads</strong>
              <button
                className="wb-icon"
                title="Close threads"
                aria-label="Close threads"
                onClick={() => setThreads(false)}
              >
                <X size={17} />
              </button>
            </header>
            <div className="wb-drawer-scroll">
              <select
                aria-label="Recent workspaces"
                value=""
                disabled={busy || runActive}
                onChange={(event) => void chooseWorkspace(event.target.value)}
              >
                <option value="">Recent workspaces</option>
                {snapshot.workspaceProfiles.map((profile) => (
                  <option key={profile.id} value={profile.id}>
                    {profile.displayName}
                  </option>
                ))}
              </select>
              {snapshot.threadSummaries.map((thread) => (
                <button
                  className="wb-thread"
                  type="button"
                  key={thread.id}
                  disabled={busy}
                  aria-pressed={thread.id === snapshot.activeThread?.id}
                  onClick={() => void openThread(thread.id)}
                >
                  <strong>{thread.title}</strong>
                  <small>
                    {thread.workspace.name} /{" "}
                    {thread.latestRun?.status ?? thread.status}
                  </small>
                </button>
              ))}
            </div>
          </Overlay>
        )}
        <Overlay
          active={requests}
          label="Requests"
          onClose={() => setRequests(false)}
          side="right"
        >
          <header className="wb-panel-header">
            <strong>Requests {attentionCount}</strong>
            <button
              className="wb-icon"
              title="Close requests"
              aria-label="Close requests"
              onClick={() => setRequests(false)}
            >
              <X size={17} />
            </button>
          </header>
          <div className="wb-drawer-scroll">
            {attentionCount === 0 ? (
              <p className="wb-muted">No pending requests</p>
            ) : (
              <AttentionPanel snapshot={snapshot} onSnapshot={setSnapshot} />
            )}
          </div>
        </Overlay>
      </div>
      {settings && (
        <SettingsPage
          snapshot={snapshot}
          onSaved={setSnapshot}
          onClose={() => {
            setSettings(false);
            input.current?.focus();
          }}
        />
      )}
    </>
  );
}
function Overlay({
  label,
  side,
  onClose,
  children,
  active = true,
}: {
  label: string;
  side: "left" | "right";
  onClose: () => void;
  children: React.ReactNode;
  active?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!active) return;
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    return () => previous?.focus();
  }, [active]);
  return (
    <div
      hidden={!active}
      className={`wb-overlay wb-overlay-${side}`}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="wb-drawer"
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        ref={ref}
        onKeyDown={(event) => {
          if (event.key === "Escape") onClose();
          if (event.key === "Tab") {
            const items = ref.current?.querySelectorAll<HTMLElement>(
              'button:not(:disabled), select:not(:disabled), textarea:not(:disabled), input:not(:disabled), [tabindex="0"]',
            );
            if (!items?.length) return;
            const first = items[0],
              last = items[items.length - 1];
            if (event.shiftKey && document.activeElement === first) {
              event.preventDefault();
              last?.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
              event.preventDefault();
              first?.focus();
            }
          }
        }}
      >
        {children}
      </div>
    </div>
  );
}
