import {createHash} from "node:crypto";
import type {InspectionRecorder} from "@agent-anything/inspection/recording";
import {inspectionLink} from "@agent-anything/inspection/adapters";
import type {InspectionEvidenceBasis} from "@agent-anything/inspection/records";

type Input = Parameters<InspectionRecorder["offer"]>[0];

/** Fan-out records must not replace the latest state/content of their source object. */
export function recordInspectionRelationships(recorder: Pick<InspectionRecorder,"ref"|"offer">, source: Input["subject"],
  occurredAt: Input["occurredAt"], links: NonNullable<Input["links"]>, evidence?:InspectionEvidenceBasis): void {
  for(const record of inspectionRelationshipRecords(recorder,source,occurredAt,links,evidence))recorder.offer(record);
}
export function* inspectionRelationshipRecords(recorder:Pick<InspectionRecorder,"ref">,source:Input["subject"],
  occurredAt:Input["occurredAt"],links:NonNullable<Input["links"]>,evidence?:InspectionEvidenceBasis):Generator<Input> {
  for (const [ordinal,link] of links.entries()) {
    const id = createHash("sha256").update(JSON.stringify({source, link})).digest("hex");
    const subject = recorder.ref("inspection", "event", `relationship:${id}`, source.runId);
    yield {subject, occurredAt, payload:evidence?{kind:"process_relationship",version:"1",evidence,ordinal,total:links.length}:
      {kind: "event", name: "recorded_relationship", sequence: null, code: null},
      links: evidence?[link]:[inspectionLink("includes", source, subject), link]};
  }
}
