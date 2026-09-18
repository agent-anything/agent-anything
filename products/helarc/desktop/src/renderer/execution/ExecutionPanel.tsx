import * as React from "react";
import { useState } from "react";
import { RefreshCw, Play, Terminal, ListTree, X } from "lucide-react";
import type {
  HelarcActiveDelegationSnapshot,
  HelarcMainSnapshot,
} from "../../shared/HelarcDesktopApi.js";
import type {
  HelarcPresentationValue,
  ThreadRunSummary,
  WorkbenchScope,
} from "../../shared/HelarcWorkbench.js";
import { useWorkbench } from "../workbench/useWorkbench.js";
import { CommandOutput } from "./CommandOutput.js";
import {
  CopyButton,
  MarkdownContent,
} from "../conversation/MarkdownContent.js";
import { AssistantBlock } from "../conversation/Conversation.js";

export function ExecutionPanel({
  snapshot,
  runs,
  selected,
  onSelect,
  visible,
  onClose,
  onResume,
}: {
  snapshot: HelarcMainSnapshot;
  runs: readonly ThreadRunSummary[];
  selected: WorkbenchScope | null;
  onSelect: (scope: WorkbenchScope) => void;
  visible: boolean;
  onClose: () => void;
  onResume: (delegation: HelarcActiveDelegationSnapshot) => void;
}) {
  const [tab, setTab] = useState<"overview" | "commands" | "activity">(
    "overview",
  );
  const [descendants, setDescendants] = useState(false);
  const [diagnostics, setDiagnostics] = useState(false);
  const [commandId, setCommandId] = useState<string | null>(null);
  const revision =
    snapshot.run && snapshot.run.productRunId === selected?.productRunId
      ? snapshot.run.product.presentationRevision +
        snapshot.run.host.runRevision
      : 0;
  const { page, error, busy, loadMore, refresh } = useWorkbench(
    selected,
    revision,
    descendants,
    visible,
  );
  const node = page?.run.host.runTree.nodes.find(
    (item) => item.runId === selected?.runId,
  );
  const root = selected?.runId === page?.run.harnessRunId;
  const objective = page?.labels.find(
    (item) => item.runId === selected?.runId,
  )?.objective;
  const delegation = page?.live
    ? snapshot.run?.host.activeDelegations.find(
        (item) => item.child.id === selected?.runId,
      )
    : null;
  return (
    <aside className="wb-execution" aria-label="Execution">
      <header className="wb-panel-header">
        <strong>Execution</strong>
        <button
          className="wb-icon"
          title="Refresh execution"
          aria-label="Refresh execution"
          onClick={refresh}
          type="button"
          disabled={busy}
        >
          <RefreshCw size={15} />
        </button>
        <button
          className="wb-icon"
          title="Close execution"
          aria-label="Close execution"
          onClick={onClose}
          type="button"
        >
          <X size={16} />
        </button>
      </header>
      <div className="wb-execution-scope">
        <select
          aria-label="Inspected run"
          value={selected?.productRunId ?? ""}
          onChange={(event) => {
            const run = runs.find(
              (item) => item.productRunId === event.target.value,
            );
            if (run?.harnessRunId && snapshot.activeThread) {
              onSelect({
                threadId: snapshot.activeThread.id,
                productRunId: run.productRunId,
                runId: run.harnessRunId,
              });
              setCommandId(null);
            }
          }}
        >
          <option value="" disabled>
            Select a Run
          </option>
          {runs
            .filter((run) => run.harnessRunId)
            .map((run) => (
              <option key={run.productRunId} value={run.productRunId}>
                {new Date(run.startedAt).toLocaleTimeString([], {
                  hour: "2-digit",
                  minute: "2-digit",
                })}{" "}
                / {run.objective.slice(0, 70)} / {run.status}
              </option>
            ))}
        </select>
      </div>
      {page && (
        <div className="wb-scope-status">
          <strong>
            {page.labels.find((item) => item.runId === selected?.runId)
              ?.label ?? (root ? "Root" : "Delegated work")}
          </strong>
          <span className={`wb-status ${node?.status}`}>
            {page.live || page.run.display.terminal
              ? (node?.status ?? page.run.display.status)
              : "Inactive / last observed " +
                (node?.status ?? page.run.display.status)}
          </span>
        </div>
      )}
      {page && page.run.host.runTree.nodes.length > 1 && (
        <details className="wb-tree">
          <summary>
            <ListTree size={15} />
            Run hierarchy <span>{page.run.host.runTree.nodes.length}</span>
          </summary>
          <div>
            {page.run.host.runTree.nodes.map((item) => (
              <button
                key={item.runId}
                type="button"
                aria-pressed={selected?.runId === item.runId}
                className="wb-tree-row"
                style={{ paddingLeft: 10 + Math.min(item.depth, 6) * 14 }}
                title={item.runId}
                onClick={() => {
                  onSelect({ ...selected!, runId: item.runId });
                  setCommandId(null);
                }}
              >
                <span>
                  {page.labels.find((label) => label.runId === item.runId)
                    ?.label ?? (item.depth ? "Delegated work" : "Root")}
                </span>
                <small>{item.status}</small>
                <small>
                  {snapshot.run?.host.pendingInteractions.filter(
                    (request) => request.runId === item.runId,
                  ).length || ""}
                </small>
              </button>
            ))}
          </div>
        </details>
      )}
      <nav className="wb-tabs" aria-label="Execution views">
        {(["overview", "commands", "activity"] as const).map((value) => (
          <button
            key={value}
            type="button"
            aria-pressed={tab === value}
            onClick={() => setTab(value)}
          >
            {value[0]!.toUpperCase() + value.slice(1)}
          </button>
        ))}
      </nav>
      <div className="wb-execution-scroll">
        {error && (
          <p className="wb-warning">Execution details unavailable: {error}</p>
        )}
        {!selected && <p className="wb-muted">No Run selected</p>}
        {page && selected && (
          <>
            {tab !== "overview" && (
              <label className="wb-descendants">
                <input
                  type="checkbox"
                  checked={descendants}
                  onChange={(event) => setDescendants(event.target.checked)}
                />
                Include descendants
              </label>
            )}
            {tab === "overview" && (
              <>
                <section className="wb-section">
                  <h3>Objective</h3>
                  <p>{objective ?? "Not recorded"}</p>
                </section>
                {page.plans[selected.runId] && (
                  <section className="wb-section">
                    <h3>Plan</h3>
                    <PlanView value={page.plans[selected.runId]!} />
                  </section>
                )}
                {delegation?.suspension && (
                  <section className="wb-section">
                    <p>{delegation.suspension.reason}</p>
                    {delegation.admittedControls.includes("resume") && (
                      <button
                        type="button"
                        className="secondary-button"
                        onClick={() => onResume(delegation)}
                      >
                        <Play size={14} />
                        Resume
                      </button>
                    )}
                  </section>
                )}
                {root && page.run.product.result && (
                  <section className="wb-section">
                    <h3>Outcome</h3>
                    <MarkdownContent
                      text={
                        page.run.product.result.output.agentSummary ??
                        page.run.display.status
                      }
                    />
                    {page.run.product.result.output.safeErrors.map(
                      (item, index) => (
                        <p className="wb-warning" key={`${item.code}:${index}`}>
                          <code>{item.code}</code> {item.message}
                        </p>
                      ),
                    )}
                  </section>
                )}
                {!root && (
                  <section className="wb-section">
                    <h3>Recorded responses</h3>
                    {page.records
                      .filter(
                        (item) =>
                          item.runId === selected.runId &&
                          item.content.kind === "assistant_text",
                      )
                      .map((item) => (
                        <AssistantBlock
                          key={item.id}
                          record={item}
                          scope={selected}
                        />
                      ))}
                    {node?.terminal && <p>{node.terminal.code}</p>}
                    {page.nextCursor && (
                      <button
                        className="wb-link"
                        disabled={busy}
                        type="button"
                        onClick={() => void loadMore()}
                      >
                        Load more responses
                      </button>
                    )}
                  </section>
                )}
                <section className="wb-section">
                  <h3>Artifacts</h3>
                  {snapshot.activeThread?.artifacts
                    .filter(
                      (item) => item.runId === selected.productRunId && root,
                    )
                    .map((item) => (
                      <details key={item.id}>
                        <summary>{item.title}</summary>
                        <p>{item.summary ?? "No summary recorded"}</p>
                        <small>{item.kind}</small>
                      </details>
                    ))}
                  {!root && (
                    <p className="wb-muted">
                      No separately retained Child artifacts in this view.
                    </p>
                  )}
                </section>
                <details className="wb-secondary">
                  <summary>Details</summary>
                  <dl>
                    <dt>Run</dt>
                    <dd>{selected.runId}</dd>
                    <dt>Recorded</dt>
                    <dd>{page.recordedAt}</dd>
                    <dt>Model use</dt>
                    <dd>{page.run.product.qualification.status}</dd>
                    <dt>Model continuity</dt>
                    <dd>
                      {page.run.product.continuation?.kind ?? "Not recorded"}
                    </dd>
                    <dt>Revision</dt>
                    <dd>{page.revision}</dd>
                    <dt>Execution</dt>
                    <dd>
                      {page.run.product.result?.output.enforcement.status ??
                        "In progress"}
                    </dd>
                  </dl>
                </details>
              </>
            )}
            {tab === "commands" && (
              <>
                {page.commands.length === 0 && (
                  <p className="wb-muted">No launched commands recorded.</p>
                )}
                {page.commands.map((command) => (
                  <section
                    className="wb-command"
                    key={`${command.runId}:${command.executionId}`}
                  >
                    <button
                      className="wb-command-heading"
                      type="button"
                      aria-expanded={commandId === command.executionId}
                      onClick={() =>
                        setCommandId((current) =>
                          current === command.executionId
                            ? null
                            : command.executionId,
                        )
                      }
                    >
                      <Terminal size={15} />
                      <strong>{command.shell ?? "Shell"}</strong>
                      <span>{command.outcome ?? command.phase}</span>
                    </button>
                    <pre className="wb-command-text">
                      {command.command ?? "Command text not recorded"}
                    </pre>
                    <div className="wb-command-meta">
                      <span>
                        {page.labels.find(
                          (label) => label.runId === command.runId,
                        )?.label ?? "Run"}
                      </span>
                      <span>{command.cwd ?? "cwd not recorded"}</span>
                      <span>
                        {command.startedAt
                          ? new Date(command.startedAt).toLocaleTimeString()
                          : ""}
                        {command.completedAt
                          ? ` - ${new Date(command.completedAt).toLocaleTimeString()}`
                          : ""}
                      </span>
                      {command.exitCode != null && (
                        <span>Exit {command.exitCode}</span>
                      )}
                    </div>
                    {commandId === command.executionId && (
                      <CommandOutput
                        key={`${command.runId}:${command.executionId}`}
                        scope={{ ...selected, runId: command.runId }}
                        executionId={command.executionId}
                        active={visible}
                      />
                    )}
                  </section>
                ))}
              </>
            )}
            {tab === "commands" && page.nextCursor && (
              <button
                className="wb-link"
                disabled={busy}
                type="button"
                onClick={() => void loadMore()}
              >
                Load more execution details
              </button>
            )}
            {tab === "activity" && (
              <>
                <label className="wb-descendants">
                  <input
                    type="checkbox"
                    checked={diagnostics}
                    onChange={(event) => setDiagnostics(event.target.checked)}
                  />
                  Diagnostic events
                </label>
                {diagnostics
                  ? page.activity.map((item) => (
                      <details className="wb-activity" key={item.id}>
                        <summary>
                          {item.title}
                          <time>
                            {new Date(item.timestamp).toLocaleTimeString()}
                          </time>
                        </summary>
                        <p>{item.detail}</p>
                        <pre>
                          {JSON.stringify(
                            { source: item.source, metadata: item.metadata },
                            null,
                            2,
                          )}
                        </pre>
                      </details>
                    ))
                  : page.records.map((item) => (
                      <details className="wb-activity" key={item.id}>
                        <summary>
                          {item.content.kind === "tool_call"
                            ? `${item.content.name}: ${item.content.settlement ?? "requested"}`
                            : item.content.kind === "assistant_text"
                              ? "Assistant response"
                              : item.content.kind === "plan_update"
                                ? "Plan updated"
                                : item.content.title}
                          <time>
                            {new Date(item.observedAt).toLocaleTimeString()}
                          </time>
                        </summary>
                        <small>
                          {page.labels.find(
                            (label) => label.runId === item.runId,
                          )?.label ?? item.runId}
                        </small>
                        <CopyButton text={JSON.stringify(item, null, 2)} />
                        <pre>{JSON.stringify(item.content, null, 2)}</pre>
                        <small>Source: {item.source.id}</small>
                      </details>
                    ))}
                {page.nextCursor && (
                  <button
                    className="wb-link"
                    type="button"
                    disabled={busy}
                    onClick={() => void loadMore()}
                  >
                    Load more activity
                  </button>
                )}
                {page.omittedRecords > 0 && (
                  <p className="wb-muted">
                    {page.omittedRecords} earlier display records omitted.
                  </p>
                )}
              </>
            )}
          </>
        )}
      </div>
    </aside>
  );
}
function PlanView({ value }: { value: HelarcPresentationValue }) {
  const plan = value as {
    steps?: readonly {
      description?: string;
      title?: string;
      status?: string;
    }[];
  } | null;
  return plan?.steps ? (
    <ol className="wb-plan">
      {plan.steps.map((step, index) => (
        <li key={index}>
          <span>{step.description ?? step.title ?? "Step"}</span>
          <small>{step.status}</small>
        </li>
      ))}
    </ol>
  ) : (
    <pre>{JSON.stringify(value, null, 2)}</pre>
  );
}
