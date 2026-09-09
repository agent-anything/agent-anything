import type { RuntimeEvent, RuntimeEventPublisher } from "@agent-anything/observability/events";
import type { InspectionJson, InspectionRecordInput, InspectionSubjectRef } from "../records/index.js";
import type { InspectionRecorder } from "../recording/index.js";
import { inspectionLink } from "./ProviderInspectionAdapter.js";

export class RuntimeEventInspectionAdapter implements RuntimeEventPublisher {
  constructor(private readonly recorder: InspectionRecorder) {}
  publish(event: RuntimeEvent): void {
    const r = this.recorder;
    const ref = (owner: string, kind: InspectionSubjectRef["kind"], id: string) => r.ref(owner, kind, id, event.runId);
    const subject = ref("runtime", "event", event.id);
    const run = ref("runtime", "run", event.runId);
    const links: NonNullable<InspectionRecordInput["links"]>[number][] = [inspectionLink("contains", run, subject)];
    const interval = (target: InspectionSubjectRef, activity: "controller" | "operation" | "wait", phase: "started" | "settled", status: string | null) => r.offer({
      id: `${event.id}:interval`, subject: target, occurredAt: event.occurredAt,
      payload: { kind: "interval", phase, activity, status, clock: r.manifest.producerInstanceId },
      links: [inspectionLink("trigger", subject, target), inspectionLink("contains", run, target)],
    });
    switch (event.name) {
      case "controller.started": interval(ref("runtime", "turn", event.payload.turnId), "controller", "started", null); break;
      case "controller.finished": interval(ref("runtime", "turn", event.payload.turnId), "controller", "settled", event.payload.status); break;
      case "controller.tool_exposure.resolved":
        links.push(inspectionLink("materializes", ref("runtime", "turn", event.payload.turnId), ref("runtime", "request", event.payload.controllerRequestId)));
        break;
      case "operation.started": {
        const operation = ref("operations", "operation", event.payload.invocationId);
        interval(operation, "operation", "started", null);
        if (event.payload.parentRunActionId) links.push(inspectionLink("materializes", ref("runtime", "action", event.payload.parentRunActionId), operation));
        if (event.payload.parentInvocationId) links.push(inspectionLink("contains", ref("operations", "operation", event.payload.parentInvocationId), operation));
        break;
      }
      case "operation.finished":
        interval(ref("operations", "operation", event.payload.invocationId), "operation", "settled", event.payload.status);
        break;
      case "interaction.opened": {
        const control = ref("interaction", "control", `${event.payload.requestId}:${event.payload.pendingVersion}`);
        interval(control, "wait", "started", event.payload.blockingScope);
        if (event.payload.parentRunActionId) links.push(inspectionLink("materializes", ref("runtime", "action", event.payload.parentRunActionId), control));
        break;
      }
      case "interaction.settled": interval(ref("interaction", "control", `${event.payload.requestId}:${event.payload.pendingVersion}`), "wait", "settled", event.payload.lifecycle); break;
      case "run.descendant.reserved":
      case "run.descendant.started":
      case "run.descendant.settled": {
        const child = r.ref("runtime", "run", event.payload.childRunId, event.payload.childRunId);
        links.push(inspectionLink("descendant", run, child), inspectionLink("materializes", ref("runtime", "action", event.payload.parentRunActionId), child));
        break;
      }
    }
    r.offer({ id: event.id, subject, occurredAt: event.occurredAt, ownerSequence: event.sequence,
      payload: { kind: "event", name: event.name, sequence: event.sequence, code: "code" in event.payload ? event.payload.code : null }, links,
      contents: [{ name: "Runtime Event", stage: "published", class: "agent", mediaType: "application/json", value: event as unknown as InspectionJson }],
    });
  }
}
