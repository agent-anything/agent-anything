import * as React from "react";
import { useEffect, useRef, useState } from "react";
import type {
  HelarcMainSnapshot,
  HelarcPendingInteractionSnapshot,
} from "../../shared/HelarcDesktopApi.js";
import {
  ApprovalPromptPanel,
  ClarificationPromptPanel,
  defaultGrantedPermissions,
} from "./InteractionPanels.js";

export function AttentionPanel({
  snapshot,
  onSnapshot,
  target,
  tasks,
}: {
  snapshot: HelarcMainSnapshot;
  onSnapshot: (snapshot: HelarcMainSnapshot) => void;
  target?: { runId: string; sequence: number } | null;
  tasks: readonly import("../../shared/HelarcWorkbench.js").TaskSummary[];
}) {
  const run = snapshot.run;
  const [selected, setSelected] = useState<string | null>(null),
    [collapsed, setCollapsed] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const requests =
    run && !run.display.terminal ? run.host.pendingInteractions : [];
  const identity = (r: HelarcPendingInteractionSnapshot) =>
    JSON.stringify([
      r.runId,
      r.request.protocol,
      r.request.id,
      r.request.requestVersion,
    ]);
  const selectedRequest =
    requests.find((r) => identity(r) === selected) ?? requests[0];
  useEffect(() => {
    if (!target) return;
    const request = requests.find((r) => r.runId === target.runId);
    if (request) {
      setSelected(identity(request));
      setCollapsed(false);
      heading.current?.focus();
    }
  }, [target?.sequence]);
  if (!run || !requests.length) return null;
  return (
    <section className="wb-attention" aria-label="Needs your input">
      <header className="wb-attention-heading">
        <h2 ref={heading} tabIndex={-1}>
          Needs your input <span>{requests.length}</span>
        </h2>
        <button className="wb-link" onClick={() => setCollapsed((v) => !v)}>
          {collapsed ? "Review / answer" : "Collapse"}
        </button>
      </header>
      <div hidden={collapsed} className="wb-attention-body">
        {requests.length > 1 && (
          <div className="wb-request-list">
            {requests.map((r, i) => (
              <button
                key={identity(r)}
                className="wb-link"
                aria-pressed={r === selectedRequest}
                onClick={() => setSelected(identity(r))}
              >
                {r.family === "approval" ? "Approval" : "Question"} {i + 1}:{" "}
                {r.runId === run.harnessRunId
                  ? "Main task"
                  : (tasks.find((t) => t.runId === r.runId)?.label ??
                    "Delegated task")}
              </button>
            ))}
          </div>
        )}
        {requests.map((request) => (
          <div key={identity(request)} hidden={request !== selectedRequest}>
            <RequestForm
              request={request}
              rootRunId={run.harnessRunId}
              onSnapshot={onSnapshot}
            />
          </div>
        ))}
      </div>
    </section>
  );
}

function RequestForm({
  request,
  rootRunId,
  onSnapshot,
}: {
  request: HelarcPendingInteractionSnapshot;
  rootRunId: string;
  onSnapshot: (snapshot: HelarcMainSnapshot) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit(payload: (id: string) => unknown) {
    if (busy || request.phase !== "pending") return;
    setBusy(true);
    setError(null);
    const id = crypto.randomUUID();
    try {
      const result = await window.helarc.submitInteraction({
        commandId: `interaction-${id}`,
        submissionId: id,
        runId: rootRunId,
        request: request.request,
        payload: payload(id),
      });
      onSnapshot(result.snapshot);
      if (result.receipt.status === "rejected") setError(result.receipt.code);
      else if (
        result.receipt.kind === "interaction.submit" &&
        result.receipt.result.status === "rejected"
      )
        setError(result.receipt.result.code);
    } catch {
      setError("Submission could not be delivered.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="wb-request">
      <header>
        <span>
          {request.family === "approval" ? "Approval needed" : "Question"}
        </span>

        {request.expiresAt && (
          <time>
            Expires {new Date(request.expiresAt).toLocaleTimeString()}
          </time>
        )}
      </header>
      {request.family === "approval" ? (
        <ApprovalPromptPanel
          approval={request}
          isBusy={busy}
          submissionError={error}
          onSubmit={(option) =>
            void submit((id) => ({
              submissionId: id,
              runId: request.presentation.runId,
              requestId: request.request.id,
              pendingVersion: request.request.requestVersion,
              optionId: option.id,
              grantedPermissions: defaultGrantedPermissions(
                request,
                option.kind,
              ),
              reason:
                option.kind === "decline" || option.kind === "cancel"
                  ? "Requested from Helarc desktop."
                  : null,
            }))
          }
        />
      ) : request.family === "clarification" ? (
        <ClarificationPromptPanel
          clarification={request}
          isBusy={busy}
          submissionError={error}
          onSubmit={(answers) => void submit(() => ({ answers }))}
        />
      ) : (
        <p>This request has no supported presentation.</p>
      )}
    </section>
  );
}
