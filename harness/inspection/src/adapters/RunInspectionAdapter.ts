import { RUN_LIFECYCLE_DESCRIPTION, type RunObserver, type RunSnapshotObservation, type RunTransitionObservation } from "@agent-anything/agent-runtime/runner";
import type { RunTranscriptObserver, RunTranscriptRecord } from "@agent-anything/agent-runtime/transcript";
import type { InspectionJson } from "../records/index.js";
import type { InspectionRecorder } from "../recording/index.js";
import { inspectionLink, inspectionModelSource } from "./ProviderInspectionAdapter.js";
import type { RetainedInputPresentation } from "@agent-anything/agent-runtime/controller";

/** Reads published owner snapshots; never derives a replacement Run state. */
export class RunInspectionAdapter implements RunObserver {
  constructor(private readonly recorder: InspectionRecorder) {}
  transition(value: RunTransitionObservation): void {
    const subject = this.recorder.ref("runtime", "run", value.runId, value.runId);
    this.recorder.offer({ id: `${value.runId}:transition:${value.revision}`, subject, occurredAt: value.occurredAt,
      payload: { kind: "transition", from: value.previousStatus, to: value.status, revision: value.revision, transitionId: `${value.previousStatus}:${value.status}`, reasonCode: value.causes.length ? "run_items_committed" : "state_committed_without_run_item" },
      links: value.causes.map((cause) => inspectionLink("trigger", this.recorder.ref("runtime", "event", cause.id, value.runId), subject)),
      contents: [{ name: "Committed state transition", stage: "committed", class: "agent", mediaType: "application/json", value: value as unknown as InspectionJson }],
    });
  }
  observe(observation: RunSnapshotObservation): void {
    try {
      const { snapshot } = observation;
      const node = snapshot.runTree.nodes.find((entry) => entry.runId === snapshot.runId);
      const subject = this.recorder.ref("runtime", "run", snapshot.runId, snapshot.runId);
      if (snapshot.sequence === 0) this.recorder.offer({ id: `${snapshot.runId}:lifecycle`, subject, occurredAt: null, payload: { kind: "lifecycle", ...RUN_LIFECYCLE_DESCRIPTION } });
      this.recorder.offer({ id: `${snapshot.runId}:snapshot:${snapshot.sequence}`, subject, occurredAt: null, ownerSequence: snapshot.sequence,
        payload: { kind: "snapshot", status: snapshot.status, revision: snapshot.runRevision, agentId: observation.agent.id, taskId: observation.task.id, parentRunId: node?.parentRunId ?? null },
        contents: [{ name: "Run operation snapshot", class: "agent", stage: "published", mediaType: "application/json", value: snapshot as unknown as InspectionJson }],
        links: node?.parentRunId ? [{ kind: "descendant", from: this.recorder.ref("runtime", "run", node.parentRunId, node.parentRunId), to: subject, condition: null, operation: null, sourceLocation: null, targetLocation: null }] : [],
      });
      if (snapshot.sequence === 0) this.recorder.offer({ id: `${snapshot.runId}:interval:started`, subject, occurredAt: observation.startedAt, payload: { kind: "interval", phase: "started", activity: "run", status: null, clock: this.recorder.manifest.producerInstanceId }, links: node?.parentRunId ? [inspectionLink("descendant", this.recorder.ref("runtime", "run", node.parentRunId, node.parentRunId), subject)] : [] });
      if (snapshot.result) this.recorder.offer({ id: `${snapshot.runId}:interval:settled`, subject, occurredAt: snapshot.result.completedAt, payload: { kind: "interval", phase: "settled", activity: "run", status: snapshot.result.status, clock: this.recorder.manifest.producerInstanceId } });
    } catch { /* Optional observation cannot affect the source listener. */ }
  }
}

export class RunTranscriptInspectionAdapter implements RunTranscriptObserver {
  constructor(private readonly recorder: InspectionRecorder) {}
  observe(record: RunTranscriptRecord): void {
    const item = record.item;
    const subject = this.recorder.ref("runtime", "event", item.ref.id, record.runId);
    this.recorder.offer({ id: item.ref.id, subject, occurredAt: item.createdAt, ownerSequence: item.ref.sequence,
      payload: { kind: "event", name: item.payload.kind, sequence: item.ref.sequence, code: null },
      contents: [{ name: "RunItem", class: "agent", stage: "committed", mediaType: "application/json", value: item as unknown as InspectionJson }],
      links: [{ kind: "contains", from: this.recorder.ref("runtime", "run", record.runId, record.runId), to: subject, condition: null, operation: null, sourceLocation: null, targetLocation: null }],
    });
    const r = this.recorder;
    const payload = item.payload;
    const ref = (owner: string, kind: Parameters<InspectionRecorder["ref"]>[1], id: string, revision: string | null = null) => r.ref(owner, kind, id, record.runId, revision);
    if (payload.kind === "run_action") {
      const action = ref("runtime", "action", payload.action.ref.id);
      const provenance = payload.action.provenance;
      r.offer({ subject: action, occurredAt: item.createdAt, payload: { kind: "event", name: "run_action.materialized", sequence: payload.action.ref.sequence, code: null },
        links: [inspectionLink("trigger", subject, action), ...(provenance.kind === "controller" ? [inspectionLink("materializes", ref("runtime", "call", provenance.modelCallRef.id), action)] : [])],
        contents: [{ name: "Run Action", class: "agent", stage: "materialized", mediaType: "application/json", value: payload.action as unknown as InspectionJson }],
      });
    } else if (payload.kind === "controller_feedback") {
      const feedback = ref("agent-runtime", "contribution", `${payload.turn.id}:feedback`, String(payload.turn.sequence));
      r.offer({subject: feedback, occurredAt: item.createdAt,
        payload: {kind: "event", name: "controller_feedback.committed", sequence: item.ref.sequence, code: payload.feedback.code},
        links: [inspectionLink("produces", subject, feedback),
          inspectionLink("trigger", ref("runtime", "turn", payload.turn.id), feedback)],
        contents: [{name: "Controller feedback", class: "agent", stage: "committed", mediaType: "application/json",
          value: payload as unknown as InspectionJson}]});
    } else if (payload.kind === "state_transition" && payload.transition === "steering" && payload.steering.status === "applied") {
      const command = payload.steering.command;
      const steering = ref("agent-runtime", "contribution", `${record.runId}:steering:${command.commandId}`, String(command.acceptedRunRevision));
      r.offer({subject: steering, occurredAt: item.createdAt,
        payload: {kind: "event", name: "steering.applied", sequence: item.ref.sequence, code: null},
        links: [inspectionLink("produces", subject, steering)],
        contents: [{name: "Applied steering", class: "agent", stage: "applied", mediaType: "application/json",
          value: payload.steering as unknown as InspectionJson}]});
    } else if (payload.kind === "model_call_settlement") {
      const call = ref("runtime", "call", payload.result.modelCallRef.id);
      const presentation = ref("runtime", "contribution", `${call.id}:presentation`, "1");
      r.offer({subject: presentation, occurredAt: item.createdAt,
        payload: {kind: "event", name: `model_result.presentation.${payload.result.presentation.disposition}`,
          sequence: item.ref.sequence, code: payload.result.presentation.failureCode},
        links: [inspectionLink("produces", subject, presentation), inspectionLink("delivers", presentation, call),
          ...payload.result.sourceRefs.filter(source => source.kind === "operation_result").map(source =>
            inspectionLink("transforms", ref("operations", "contribution", source.id), presentation,
              {operation: `${payload.result.presentation.presenter.id}@${payload.result.presentation.presenter.revision}`})),
          ...payload.result.sourceRefs.filter(source => source.kind === "controller_feedback").map(source =>
            inspectionLink("delivers", ref(source.owner, "contribution", source.id, source.revision), presentation,
              {operation: "call_feedback_delivery"})),
          ...payload.result.sourceRefs.filter(source => ["execution", "effect", "support", "material"].includes(source.kind)).map(source =>
            inspectionLink("delivers", ref(source.owner, "contribution", `${source.kind}:${source.id}`, source.revision), presentation,
              {operation: "execution_reference_delivery"}))],
        contents: [{name: "Result presentation", class: "agent", stage: "presented", mediaType: "application/json",
          value: payload.result as unknown as InspectionJson}]});
      r.offer({ subject: call, occurredAt: item.createdAt, payload: { kind: "scheduling", position: payload.result.modelCallRef.contentBlockOrdinal, disposition: "settled", rule: "model_call_settlement", reason: null, groupId: null },
        links: [inspectionLink("settles", subject, call)], contents: [{ name: "Model Tool Result", class: "agent", stage: "settled", mediaType: "application/json", value: payload.result as unknown as InspectionJson }],
      });
    } else if (payload.kind === "observation") {
      const observation = payload.observation;
      const target = ref(observation.owner, "contribution", observation.id, "1");
      const links = [inspectionLink("produces", ref("runtime", "action", observation.runAction.id), target), inspectionLink("trigger", subject, target)];
      const resultRef = observation.lowerRefs.find((entry) => entry.owner === "agent-runtime" && entry.kind === "delegation_result");
      const transferred = (observation.payload.kind === "descendant_result_transfer" || observation.payload.kind === "descendant_run") && resultRef !== undefined;
      if (transferred) {
        links.push(inspectionLink("delivers", ref("agent-runtime", "contribution", resultRef.id, resultRef.revision), target, { operation: "descendant_result_delivery" }));
      }
      if (observation.payload.kind === "plan_update" && observation.payload.result.status !== "rejected") {
        const result = observation.payload.result;
        links.push(inspectionLink(result.status === "applied" ? "produces" : "binding", target,
          ref("runtime", "contribution", result.planId, String(result.version)), { operation: `plan_update.${result.status}` }));
      }
      r.offer({ subject: target, occurredAt: observation.createdAt,
        payload: { kind: "transfer", stage: transferred ? "delivered" : "produced", producerId: observation.runAction.id, consumerId: record.runId, operation: observation.payload.kind }, links,
        contents: [{ name: "Run Observation", class: "agent", stage: transferred ? "delivered" : "produced", mediaType: "application/json", value: observation as unknown as InspectionJson }],
      });
    } else if (payload.kind === "state_transition" && payload.transition === "plan") {
      const plan = ref("runtime", "contribution", payload.plan.id, String(payload.plan.version));
      r.offer({ subject: plan, occurredAt: item.createdAt,
        payload: { kind: "event", name: "plan.committed", sequence: payload.plan.version, code: null },
        links: [inspectionLink("produces", subject, plan),
          ...(payload.previousRevision === null ? [] : [inspectionLink("transforms",
            ref("runtime", "contribution", payload.plan.id, String(payload.previousRevision)), plan, { operation: "plan_transition" })])],
        contents: [{ name: "Committed Plan", class: "agent", stage: "committed", mediaType: "application/json", value: payload.plan as unknown as InspectionJson }],
      });
    } else if (payload.kind === "input_notification") {
      const notification = payload.notification;
      r.offer({id: `${item.ref.id}:source`, subject: ref(notification.source.owner, "contribution", notification.source.id, notification.source.revision),
        occurredAt: notification.occurredAt, payload: {kind: "event", name: "addressed_input.recorded", sequence: notification.sequence, code: null},
        contents: [{name: "Addressed public fact", class: "agent", stage: "admitted", mediaType: "application/json", value: notification as unknown as InspectionJson}]});
      r.offer({subject, occurredAt: item.createdAt, payload: {kind: "event", name: "input_notification.admitted", sequence: item.ref.sequence, code: null},
        links: [inspectionLink("delivers", ref(notification.source.owner, "contribution", notification.source.id, notification.source.revision), subject)],
      });
    } else if (payload.kind === "input_delivery_closed") {
      r.offer({subject, occurredAt: item.createdAt,
        payload: {kind: "event", name: "input_delivery.closed_without_acceptance", sequence: item.ref.sequence, code: payload.reason},
        links: payload.entries.map(entry => inspectionLink("includes",
          ref(entry.source.owner, "contribution", entry.source.id, entry.source.revision), subject)),
        contents: [{name: "Unaccepted input at Run closure", class: "agent", stage: "closed", mediaType: "application/json",
          value: payload as unknown as InspectionJson}]});
    } else if (payload.kind === "input_delivery") {
      const batch = ref("agent-runtime", "contribution", payload.batch.id, payload.batch.revision);
      const via = payload.receipt.via;
      r.offer({subject: batch, occurredAt: item.createdAt,
        payload: {kind: "event", name: "input_delivery.accepted", sequence: item.ref.sequence, code: null},
        links: [inspectionLink("trigger", subject, batch),
          inspectionLink("delivers", batch, ref("runtime", "turn", payload.turn.id), {operation: `${via.kind}_input_acceptance`}),
          ...(via.kind === "provider" ? [inspectionLink("includes", batch,
            ref("model-interaction", "request", via.requestId), {operation: "accepted_input_delivery"})] : [])],
        contents: [{name: "Accepted input delivery", class: "agent", stage: "accepted", mediaType: "application/json",
          value: payload as unknown as InspectionJson}]});
      if (via.kind === "provider") this.presentations(via.presentations, via.requestId, payload.turn.id, record);
    } else if (payload.kind === "controller_turn") {
      const turn = ref("runtime", "turn", payload.turn.id);
      r.offer({ subject: turn, occurredAt: item.createdAt, payload: { kind: "event", name: "controller_turn.committed", sequence: null, code: null },
        links: [inspectionLink("trigger", subject, turn), ...payload.toolExposure.exposedTools.map((tool) => inspectionLink("binding", r.ref("tools", "definition", `${tool.tool.namespace}.${tool.tool.name}`, null, tool.revision), turn))],
        contents: [{ name: "Controller turn and exposure", class: "agent", stage: "committed", mediaType: "application/json", value: payload as unknown as InspectionJson }],
      });
      if (payload.openingReceipt) this.presentations(payload.openingReceipt.presentations, payload.openingReceipt.requestId, payload.turn.id, record);
      for (const model of payload.modelItems) {
        if (model.kind !== "assistant_text" && model.kind !== "model_tool_call") continue;
        const modelRef = model.kind === "model_tool_call" ? ref("runtime", "call", model.call.modelCallRef.id)
          : ref("runtime", "contribution", model.id);
        r.offer({subject: modelRef, occurredAt: item.createdAt,
          payload: {kind: "event", name: `controller.${model.kind}.committed`, sequence: null, code: null},
          links: [inspectionLink("contains", turn, modelRef)],
          contents: [{name: "Committed model item", class: "agent", stage: "committed", mediaType: "application/json", value: model as unknown as InspectionJson}]});
      }
    }
  }

  private presentations(presentations: readonly RetainedInputPresentation[], requestId: string, turnId: string, record: RunTranscriptRecord): void {
    const r = this.recorder;
    for (const [position, presentation] of presentations.entries()) {
      const {section, digest} = presentation;
      const provenance = section.provenance!;
      const subject = r.ref("agent-runtime", "contribution", `presentation:${section.id}`, record.runId, digest);
      r.offer({id: `${record.item.ref.id}:presentation:${position}`, subject, occurredAt: record.item.createdAt,
        payload: {kind: "conversation", stage: "accepted", purpose: provenance.purpose, author: provenance.author,
          role: section.role, recipientRunId: record.runId, originRunId: provenance.originRunId ?? null, requestId, attemptId: null, position,
          presenter: `${provenance.presenter.id}@${provenance.presenter.revision}`, digest,
          delivery: provenance.purpose === "imported_history" ? "import" : "new", sourceCount: provenance.sources.length},
        links: [inspectionLink("settles", r.ref("runtime", "event", record.item.ref.id, record.runId), subject),
          inspectionLink("delivers", subject, r.ref("runtime", "turn", turnId, record.runId), {operation: "accepted_conversation_input"}),
          inspectionLink("includes", subject, r.ref("model-interaction", "request", requestId, record.runId)),
          ...provenance.sources.map(source => inspectionLink("transforms", inspectionModelSource(r, source, record.runId), subject))],
        contents: [{name: "Accepted presentation", class: "agent", stage: "accepted", mediaType: "application/json",
          value: presentation as unknown as InspectionJson}]});
    }
  }
}
