import type {InspectionRecorder} from "@agent-anything/inspection/recording";

export type InspectionProjectionSink = Pick<InspectionRecorder, "ref" | "offer">;
export type InspectionProjectionRefs = Pick<InspectionRecorder,"ref">;

/** Pull the next observation only after the previous one has been admitted. */
export async function replayInspectionRecords(recorder: Pick<InspectionRecorder,"offerWhenReady">,
  records: Iterable<Parameters<InspectionRecorder["offer"]>[0]>, signal?: AbortSignal): Promise<void> {
  for (const record of records) {
    if(signal?.aborted)throw new Error("inspection_replay_cancelled");
    if (!await recorder.offerWhenReady(record, {signal})) throw new Error("inspection_replay_record_rejected");
  }
}
