import type { RunTranscriptObserver, RunTranscriptRecord } from "@agent-anything/agent-runtime/transcript";
import type { InspectionRecorder } from "@agent-anything/inspection/recording";
import { inspectionLink } from "@agent-anything/inspection/adapters";
import type { InspectionJson, InspectionLink } from "@agent-anything/inspection/records";
import type { HelarcAgentOutput } from "@agent-anything/helarc/controller";

export class FinalReplyInspectionAdapter implements RunTranscriptObserver {
  constructor(private readonly recorder: InspectionRecorder) {}
  observe(record: RunTranscriptRecord): void {
    const payload = record.item.payload;
    if (payload.kind !== "terminal_transition" || payload.settlement.status !== "completed") return;
    const output = payload.settlement.output as HelarcAgentOutput | null;
    if (output?.kind !== "complete" || !output.finalReply) return;
    const r = this.recorder;
    const reply = output.finalReply;
    const selection = r.ref("helarc", "contribution", `${reply.ending.call.id}:final-reply`, record.runId, reply.protocolRevision);
    r.offer({subject: selection, occurredAt: record.item.createdAt,
      payload: {kind: "event", name: "final_reply.selection_retained", sequence: record.item.ref.sequence, code: reply.disposition},
      contents: [{name: "Accepted reply selection", class: "agent", stage: "retained", mediaType: "application/json",
        value: {source: output.source, finalReply: reply} as unknown as InspectionJson}],
    });
    const subject = r.ref("helarc", "contribution", `${record.runId}:final-output`, record.runId);
    const relation = (from: InspectionLink["from"], operation: string) => inspectionLink("produces", from, subject, {operation});
    r.offer({subject, occurredAt: record.item.createdAt,
      payload: {kind: "event", name: "final_reply.committed", sequence: record.item.ref.sequence, code: reply.disposition},
      links: [
        relation(r.ref("runtime", "event", record.item.ref.id, record.runId), "normal_completion"),
        relation(r.ref("runtime", "call", reply.ending.call.id, record.runId), "ending_proposal"),
        relation(selection, "accepted_reply_selection"),
        ...(output.source.kind === "model_text" ? output.source.modelItemIds.map(id =>
          relation(r.ref("runtime", "contribution", id, record.runId), "adopted_text:double_newline")) : []),
      ],
      contents: [{name: "Committed final reply", class: "agent", stage: "committed", mediaType: "application/json", value: output as unknown as InspectionJson}],
    });
  }
}
