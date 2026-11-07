import {describe,expect,it,vi} from "vitest";
import {ActivityObservationCursor} from "./ActivityObservation.js";
import {ActivityChangeWait} from "./ActivityChangeWait.js";
import type {ActivityHandoffPort} from "./ActivityHandoff.js";

describe("activity observation",()=>{
  it("discovers missed notifications with bounded metadata and forgets its cursor on recovery",async()=>{
    let revision=1;
    const command=vi.fn(async()=>[{pathId:"p",runId:"child",changeRevision:revision,controlRevision:0,progressRevision:0,cancelled:false}]);
    const port={command} as ActivityHandoffPort,cursor=new ActivityObservationCursor(port,["p"]);
    expect(await cursor.changed()).toBe(true);expect(await cursor.changed()).toBe(false);
    revision++;expect(await cursor.changed()).toBe(true);
    expect(await new ActivityObservationCursor(port,["p"]).changed()).toBe(true);
    expect(command.mock.calls).toHaveLength(4);
  });
  it("subscribes to explicit paths and does not lose a hint between reading and waiting",async()=>{
    let notify=()=>{};const unsubscribe=vi.fn(),subscribe=vi.fn((listener:()=>void,_interest?:import("./ActivityObservation.js").ActivityChangeInterest)=>{notify=listener;return unsubscribe;});
    const wait=new ActivityChangeWait({subscribe},null,{pathIds:["p"]}),version=wait.version;
    expect(subscribe.mock.calls[0]?.[1]).toEqual({pathIds:["p"]});
    notify();await wait.wait(version,60000);wait.close();expect(unsubscribe).toHaveBeenCalledOnce();
  });
  it("rejects wrong scopes and malformed observations rather than retaining an unknown result",async()=>{
    expect(()=>new ActivityObservationCursor({command:vi.fn()},[])).toThrow();
    const cursor=new ActivityObservationCursor({command:vi.fn(async()=>null)},["p"]);
    await expect(cursor.changed()).rejects.toThrow("activity_observation_invalid");
  });
});
