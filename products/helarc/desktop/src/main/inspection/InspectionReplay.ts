import type {InspectionRecorder} from "@agent-anything/inspection/recording";

export type InspectionProjectionSink = Pick<InspectionRecorder, "ref" | "offer">;

/** Hold one source fact's projection, never the full history, while awaiting recorder admission. */
export async function replayInspectionProjection(recorder: InspectionRecorder,
  project: (sink: InspectionProjectionSink) => void, signal?: AbortSignal): Promise<void> {
  const records: Parameters<InspectionRecorder["offer"]>[0][] = [];
  project({ref: recorder.ref.bind(recorder), offer: record => {records.push(record); return true;}});
  for (const record of records) {
    if (!await recorder.offerWhenReady(record, {signal})) throw new Error("inspection_replay_record_rejected");
  }
}
