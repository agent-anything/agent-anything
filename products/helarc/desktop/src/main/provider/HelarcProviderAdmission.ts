import type {Provider} from "@agent-anything/model-interaction";
import {ProviderRequestAdmission} from "@agent-anything/host/composition";
import {ExecutionFlowPath, createExecutionFlowDefinition, type ExecutionFlowContext} from "@agent-anything/observability/execution-flow";

export const HELARC_PROVIDER_ADMISSION = Object.freeze({revision: "provider-admission.v1", maximumActive: 4, maximumBackground: 1, maximumQueued: 64});
const sharedAdmission = new ProviderRequestAdmission(HELARC_PROVIDER_ADMISSION);
const FLOW = createExecutionFlowDefinition({owner: "host", id: "provider-request-admission", revision: "1", label: "Provider Request Admission",
  description: "Physical request queue and lease settlement; independent of model Call ordering.",
  steps: [{id: "queue", kind: "entry", label: "Await request capacity", checks: []},
    {id: "dispatch", kind: "call", label: "Dispatch admitted request", checks: []},
    {id: "settle", kind: "exit", label: "Settle request lease", checks: []}],
  transitions: [{id: "admit", from: "queue", to: "dispatch", label: "Capacity admitted"},
    {id: "finish", from: "dispatch", to: "settle", label: "Request returned"},
    {id: "cancel", from: "queue", to: "settle", label: "Queue interrupted"}], entryStepIds: ["queue"], exitStepIds: ["settle"]});

export function withHelarcProviderAdmission(provider: Provider, executionFlow?: ExecutionFlowContext,
  admission = sharedAdmission): Provider {
  return {descriptor: provider.descriptor, modelContext: provider.modelContext, requestBodyTransportLimit: provider.requestBodyTransportLimit,
    async send(request, context, delivery) {
      const background = request.metadata.contextPreparationPriority === "background";
      const runId = request.composition.workingView.recipientRunId;
      if (!runId) throw new TypeError("Admitted Run requests require a recipient identity.");
      const flow = new ExecutionFlowPath(FLOW, executionFlow ?? {}, runId,
        [{owner: "model-interaction", kind: "request", id: request.requestId, revision: null}]);
      const started = Date.now();
      flow.advance("queue", {requestBackground: background, policy: admission.policy.revision, ...admission.snapshot()});
      let lease: Awaited<ReturnType<ProviderRequestAdmission["acquire"]>> | null = null;
      try {
        lease = await admission.acquire({id: `${request.requestId}:${delivery?.invocationId ?? "buffered"}`, background, signal: context.signal});
        flow.advance("dispatch", {queueMs: Date.now() - started, ...admission.snapshot()});
        const result = await provider.send(request, context, delivery);
        const confirmation = result.kind === "cancellation_unconfirmed" ? "unconfirmed" : "confirmed";
        lease.settle(confirmation); lease = null;
        flow.advance("settle", {confirmation, outcome: result.kind, ...admission.snapshot()}); flow.close("returned");
        return result;
      } catch (error) {
        // A thrown transport call provides no settlement proof. Queued cancellation owns no lease.
        lease?.settle("unconfirmed");
        flow.advance("settle", {confirmation: lease ? "unconfirmed" : "not_dispatched", ...admission.snapshot()});
        flow.close(context.signal.aborted ? "cancelled" : "failed"); throw error;
      }
    }};
}
