import type {InspectionRecorder} from "@agent-anything/inspection/recording";

export type InspectionProjectionSink = Pick<InspectionRecorder, "ref" | "offer">;
export type InspectionProjectionRefs = Pick<InspectionRecorder,"ref">;

export function throughSequence<T extends {sequence:number}>(read:(after:number,limit:number)=>Promise<readonly T[]>,through:number) {
  return async(after:number,limit:number)=>{
    if(after>=through)return [];
    const page=await read(after,limit);
    if(page.length>limit||page.some((fact,i)=>!Number.isSafeInteger(fact.sequence)||fact.sequence<=(i?page[i-1]!.sequence:after)))
      throw new Error("inspection_replay_order_invalid");
    return page.filter(fact=>fact.sequence<=through);
  };
}

export function* identifiedRecords(prefix:string, records: Iterable<Parameters<InspectionRecorder["offer"]>[0]>) {
  let ordinal=0;
  for(const record of records){yield record.id?record:{...record,id:`${prefix}:${ordinal}`};ordinal++;}
}

/** Pull the next observation only after the previous one has been admitted. */
export async function replayInspectionRecords(recorder: Pick<InspectionRecorder,"offerWhenReady">,
  records: Iterable<Parameters<InspectionRecorder["offer"]>[0]>, signal?: AbortSignal): Promise<void> {
  for (const record of records) {
    if(signal?.aborted)throw new Error("inspection_replay_cancelled");
    if (!await recorder.offerWhenReady(record, {signal})) throw new Error("inspection_replay_record_rejected");
  }
}
