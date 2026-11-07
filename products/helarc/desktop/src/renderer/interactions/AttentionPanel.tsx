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
import { currentInteractionRequests, requiresUserInput } from "./InteractionAttention.js";

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
  const requests = currentInteractionRequests(snapshot);
  const attentionCount = requests.filter(requiresUserInput).length;
  const submittedCount = requests.filter(request => request.phase === "submitted_for_resolution").length;
  const title = attentionCount ? "Needs your input" : submittedCount ? "Processing your response" : "Interaction unavailable";
  const identity = (r: HelarcPendingInteractionSnapshot) =>
    JSON.stringify([
      r.runId,
      r.request.protocol,
      r.request.id,
      r.request.requestVersion,
    ]);
  const selectedRequest =
    requests.find((r) => identity(r) === selected) ?? requests.find(requiresUserInput) ?? requests[0];
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
    <section className="wb-attention" aria-label={title}>
      <header className="wb-attention-heading">
        <h2 ref={heading} tabIndex={-1}>
          {title} <span>{attentionCount || submittedCount || requests.length}</span>
        </h2>
        <button className="wb-link" onClick={() => setCollapsed((v) => !v)}>
          {collapsed ? attentionCount ? "Review / answer" : "Show" : "Collapse"}
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
                {r.family === "approval" ? "Approval" : r.family === "clarification" ? "Question" : "Unavailable interaction"} {i + 1}:{" "}
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
    if (busy || !requiresUserInput(request)) return;
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
          {request.phase === "submitted_for_resolution" ? "Response submitted"
            : request.family === "approval" ? "Approval needed" : request.family === "clarification" ? "Question" : "Interaction unavailable"}
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
