import {createHash} from "node:crypto";
import type {InspectionRecorder} from "@agent-anything/inspection/recording";
import {inspectionLink} from "@agent-anything/inspection/adapters";

type Input = Parameters<InspectionRecorder["offer"]>[0];

/** Fan-out records must not replace the latest state/content of their source object. */
export function recordInspectionRelationships(recorder: Pick<InspectionRecorder,"ref"|"offer">, source: Input["subject"],
  occurredAt: Input["occurredAt"], links: NonNullable<Input["links"]>): void {
  for (const link of links) {
    const id = createHash("sha256").update(JSON.stringify({source, link})).digest("hex");
    const subject = recorder.ref("inspection", "event", `relationship:${id}`, source.runId);
    recorder.offer({subject, occurredAt, payload: {kind: "event", name: "recorded_relationship", sequence: null, code: null},
      links: [inspectionLink("includes", source, subject), link]});
  }
}
