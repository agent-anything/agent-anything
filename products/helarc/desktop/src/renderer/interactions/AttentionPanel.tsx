import * as React from "react";
import { useState } from "react";
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
}: {
  snapshot: HelarcMainSnapshot;
  onSnapshot: (snapshot: HelarcMainSnapshot) => void;
}) {
  const run = snapshot.run;
  if (!run || run.display.terminal) return null;
  return (
    <div className="wb-attention" aria-label="Pending requests">
      {run.host.pendingInteractions.map((request) => (
        <RequestForm
          key={`${request.runId}:${request.request.id}:${request.request.requestVersion}`}
          request={request}
          rootRunId={run.harnessRunId}
          onSnapshot={onSnapshot}
        />
      ))}
    </div>
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
        <span>{request.runId === rootRunId ? "Root" : "Child"} request</span>
        <small title={request.runId}>{request.request.id}</small>
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
