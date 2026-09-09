import type { RunTrace, RunTraceObserver } from "@agent-anything/observability";
import type { InspectionJson } from "../records/index.js";
import type { InspectionRecorder } from "../recording/index.js";
import { inspectionLink } from "./ProviderInspectionAdapter.js";

export class RunTraceInspectionAdapter implements RunTraceObserver {
  constructor(private readonly recorder: InspectionRecorder) {}
  observe(trace: RunTrace): void {
    const run = this.recorder.ref("runtime", "run", trace.runId, trace.runId);
    const subject = this.recorder.ref("observability", "event", trace.traceId, trace.runId);
    this.recorder.offer({ subject, occurredAt: trace.completedAt ?? trace.startedAt,
      payload: { kind: "event", name: "run_trace." + trace.status, code: trace.issues[0]?.code ?? null, sequence: null },
      links: [inspectionLink("produces", run, subject)],
      contents: [{ name: "Native Run Trace", stage: "owner_projection", class: "agent", mediaType: "application/json", value: trace as unknown as InspectionJson }],
    });
  }
}
