import {expect,it} from "vitest";
import {ActivityCheckpointError,ActivityPurposeRegistry} from "../activity/index.ts";
import {ProtocolObservationWork} from "./ProtocolObservationWork.ts";

function observation(observe){
  const input={id:"frozen",digest:"digest",bytes:1};
  const state={activity:{scope:{activityId:"activity",runId:"run"},composition:{digest:"composition"}},
    input,fence:{generation:1,epoch:1}};
  const registry=new ActivityPurposeRegistry();
  const work=new ProtocolObservationWork({generation:1,journal:{command:async request=>{
    expect(request).toEqual({kind:"state",activityId:"activity"});return state;
  }},now:()=>"2026-01-01T00:00:00Z",observe},registry);
  const handler=registry.resolve(work.purpose),path={intent:{id:"path",runId:"run",purpose:work.purpose}};
  const attempt={id:"original-attempt"},stage={attempt,request:{pathId:"path",stageKind:"observe",
    input:{kind:"protocol_observation_source",activityId:"activity",compositionDigest:"composition",input}}};
  return {execute:signal=>handler.execute(path,stage,attempt,signal),recover:signal=>handler.reconcile(path,stage,signal)};
}

it.each(["execute","recover"])("%s preserves a checkpoint failure concurrent with interruption",async mode=>{
  const controller=new AbortController(),error=new ActivityCheckpointError("write");
  const work=observation(async()=>{controller.abort();throw error;});
  await expect(work[mode](controller.signal)).rejects.toBe(error);
});

it("retains an explicit empty observation from the original owner",async()=>{
  const result=await observation(async()=>null).recover(AbortSignal.abort());
  expect(result).toMatchObject({attemptId:"original-attempt",outcome:"returned",completeness:"complete",
    value:{kind:"protocol_observation_result",activityId:"activity",observation:null}});
});
