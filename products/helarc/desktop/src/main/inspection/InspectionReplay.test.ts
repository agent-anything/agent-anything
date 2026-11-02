import {expect,it} from "vitest";
import type {InspectionRecordInput} from "@agent-anything/inspection/records";
import {replayInspectionRecords} from "./InspectionReplay.js";

it("pulls one wide projection record at a time and closes the source after admission failure",async()=>{
  let pulled=0,closed=false,release!:(value:boolean)=>void;
  function* records():Generator<InspectionRecordInput>{try{for(let i=0;i<10000;i++){pulled++;yield {} as InspectionRecordInput;}}finally{closed=true;}}
  const replay=replayInspectionRecords({offerWhenReady:()=>new Promise(resolve=>{release=resolve;})},records());
  expect(pulled).toBe(1);expect(closed).toBe(false);
  release(true);await Promise.resolve();expect(pulled).toBe(2);
  release(false);await expect(replay).rejects.toThrow("inspection_replay_record_rejected");
  expect(closed).toBe(true);expect(pulled).toBe(2);
});
it("preserves cancellation rather than replaying another observation",async()=>{
  const controller=new AbortController();let accepted=0;
  await expect(replayInspectionRecords({offerWhenReady:async()=>{accepted++;controller.abort();return true;}},[{} as InspectionRecordInput,{} as InspectionRecordInput],controller.signal))
    .rejects.toThrow("inspection_replay_cancelled");
  expect(accepted).toBe(1);
});
