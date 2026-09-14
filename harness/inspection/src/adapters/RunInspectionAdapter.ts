import { RUN_LIFECYCLE_DESCRIPTION, type RunObserver, type RunSnapshotObservation, type RunTransitionObservation } from "@agent-anything/agent-runtime/runner";
import type { RunTranscriptObserver, RunTranscriptRecord } from "@agent-anything/agent-runtime/transcript";
import type { InspectionJson } from "../records/index.js";
import type { InspectionRecorder } from "../recording/index.js";
import { inspectionLink } from "./ProviderInspectionAdapter.js";

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
    } else if (payload.kind === "model_call_settlement") {
      const call = ref("runtime", "call", payload.result.modelCallRef.id);
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
      r.offer({ subject: target, occurredAt: observation.createdAt,
        payload: { kind: "transfer", stage: transferred ? "delivered" : "produced", producerId: observation.runAction.id, consumerId: record.runId, operation: observation.payload.kind }, links,
        contents: [{ name: "Run Observation", class: "agent", stage: transferred ? "delivered" : "produced", mediaType: "application/json", value: observation as unknown as InspectionJson }],
      });
    } else if (payload.kind === "controller_turn") {
      const turn = ref("runtime", "turn", payload.turn.id);
      r.offer({ subject: turn, occurredAt: item.createdAt, payload: { kind: "event", name: "controller_turn.committed", sequence: null, code: null },
        links: [inspectionLink("trigger", subject, turn), ...payload.toolExposure.exposedTools.map((tool) => inspectionLink("binding", r.ref("tools", "definition", `${tool.tool.namespace}.${tool.tool.name}`, null, tool.revision), turn))],
        contents: [{ name: "Controller turn and exposure", class: "agent", stage: "committed", mediaType: "application/json", value: payload as unknown as InspectionJson }],
      });
    }
  }
}
