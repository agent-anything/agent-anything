import type { ActionExecutionObserver, ActionExecutionNotification } from "@agent-anything/action-execution/enforcement";
import type { InspectionJson } from "../records/index.js";
import type { InspectionRecorder } from "../recording/index.js";
import { inspectionLink } from "./ProviderInspectionAdapter.js";

export class ActionExecutionInspectionAdapter implements ActionExecutionObserver {
  constructor(private readonly recorder: InspectionRecorder) {}
  observe(value: ActionExecutionNotification): void {
    const r = this.recorder;
    const action = r.ref("action-execution", "action", value.actionId, value.runId);
    const run = r.ref("runtime", "run", value.runId, value.runId);
    if (value.kind === "prepared") {
      r.offer({ subject: action, occurredAt: value.occurredAt, payload: { kind: "event", name: "action.prepared", sequence: null, code: null },
        links: [inspectionLink("contains", run, action), ...(value.parentRunAction ? [inspectionLink("materializes", r.ref("runtime", "action", value.parentRunAction.id, value.runId), action)] : [])],
        contents: [{ name: "Prepared subject", stage: "prepared_subject", class: "execution", mediaType: "application/json", value: value.subject as unknown as InspectionJson }],
      });
    } else if (value.kind === "assessment") {
      r.offer({ subject: action, occurredAt: null, payload: { kind: "execution", phase: value.permissionStatus === "approval_required" ? "pending" : "started", executionKind: "assessment", status: value.permissionStatus ?? value.policyStatus, code: null, effectCertainty: null }, contents: [{ name: "Assessment disposition", stage: "assessed", class: "execution", mediaType: "application/json", value }] });
    } else if (value.kind === "settled") {
      r.offer({ subject: action, occurredAt: value.occurredAt, payload: { kind: "execution", phase: "settled", executionKind: "action", status: value.status, code: value.causeRef, effectCertainty: null }, contents: [{ name: "Action settlement", stage: "settled", class: "execution", mediaType: "application/json", value }] });
    } else {
      const attempt = r.ref("action-execution", "attempt", `${value.actionId}:${value.attemptId}`, value.runId);
      const started = value.kind === "attempt_started";
      const result = value.kind === "attempt_settled" ? value.result : null;
      const outcome = result?.status === "settled" ? result.outcome : null;
      r.offer({ subject: attempt, occurredAt: value.occurredAt,
        payload: { kind: "execution", phase: started ? "started" : "settled", executionKind: started ? "dispatch_claim" : "sandbox_result", status: started ? "claimed" : outcome?.status ?? result!.status, code: result?.status === "sandbox_unavailable" ? result.code : outcome?.status === "failed" ? outcome.failure.code : null, effectCertainty: result?.status === "sandbox_unavailable" ? result.effectState : outcome?.effectState ?? null },
        links: [inspectionLink("contains", action, attempt)],
        contents: [{ name: started ? "Dispatch claim" : "Sandbox result", stage: started ? "claimed" : "settled", class: "execution", mediaType: "application/json", value: value as unknown as InspectionJson }],
      });
      r.offer({ subject: attempt, occurredAt: value.occurredAt, payload: { kind: "interval", phase: started ? "started" : "settled", activity: "attempt", status: outcome?.status ?? result?.status ?? null, clock: r.manifest.producerInstanceId } });
    }
  }
}
