import {describe,it,expect,vi} from "vitest";
import {ActivityReconsiderationProcessor} from "./ActivityReconsiderationProcessor.js";
import {ActivityHandoffPump} from "./ActivityHandoffPump.js";
import type {ActivityHandoffProcessor} from "./ActivityHandoffProcessor.js";
import type {ActivityHandoffPort} from "./ActivityHandoff.js";
import type {ActivityReconsiderationSnapshot} from "./ActivityReconsideration.js";
import type {SharedAcceptancePort} from "./SharedAcceptance.js";

function fixture() {
  const controller=new AbortController();
  const snapshot={state:{subscription:{id:"need:supply",runId:"run",owner:"owner"},revision:0,closed:false},through:1,
    facts:[{id:"original",sequence:1}],more:false} as ActivityReconsiderationSnapshot;
  const activities:ActivityHandoffPort={command:vi.fn(async command=>command.kind==="pending_reconsiderations"?[snapshot.state]:
    command.kind==="read_reconsideration"?snapshot:command.kind==="review_scheduling"?{observedAt:"now",due:[],nextReviewAt:null}:null)};
  const accept=vi.fn<SharedAcceptancePort["accept"]>(async proposal=>({id:proposal.id,scope:"run",digest:"accepted",sequence:1,outcome:"accepted",rejection:null}));
  const handler={prepare:vi.fn(async()=>({decision:{owner:"owner",kind:"exit",id:"need",revision:"1"},participants:[],close:false}))};
  const processor=new ActivityReconsiderationProcessor(activities,{accept,query:async()=>null},()=>handler);
  return {controller,activities,handler,accept,processor};
}
describe("reconsideration host interruption",()=>{
  it("leaves the original fact unconsumed when its host interrupts professional calculation",async()=>{
    const f=fixture();f.handler.prepare.mockImplementationOnce(async()=>{f.controller.abort(new Error("host_closed"));f.controller.signal.throwIfAborted();throw new Error("unreachable");});
    expect(await f.processor.scan("run",f.controller.signal)).toEqual({accepted:[],rejected:[],failures:[]});
    expect(f.accept).not.toHaveBeenCalled();
    expect(await f.processor.scan("run",new AbortController().signal)).toMatchObject({accepted:["need:supply"],failures:[]});
    expect(f.accept).toHaveBeenCalledOnce();
    expect(f.accept.mock.calls[0]![0].parts.at(-1)?.proposal).toMatchObject({factIds:["original"],expectedRevision:0,close:false});
  });
  it("retains an accepted result even when the host stops before acknowledgement is handled",async()=>{
    const f=fixture();f.accept.mockImplementationOnce(async proposal=>{
      f.controller.abort(new Error("host_closed"));return {id:proposal.id,scope:"run",digest:"accepted",sequence:1,outcome:"accepted",rejection:null};
    });
    expect(await f.processor.scan("run",f.controller.signal)).toEqual({accepted:["need:supply"],rejected:[],failures:[]});
  });
  it("does not hide an unrelated professional error during shutdown",async()=>{
    const f=fixture(),error=new Error("original_binding_corrupt");
    f.handler.prepare.mockImplementationOnce(async()=>{f.controller.abort(new Error("host_closed"));throw error;});
    expect(await f.processor.scan("run",f.controller.signal)).toMatchObject({failures:[{error}]});expect(f.accept).not.toHaveBeenCalled();
  });
  it.each([false,true])("distinguishes a scope interruption from an unrelated execution failure (%s)",unrelated=>{
    const f=fixture(),reason=new Error("host_closed"),error=unrelated?new Error("storage_failed"):reason;
    const processor={scan:async()=>{f.controller.abort(reason);throw error;}} as unknown as ActivityHandoffProcessor;
    const pump=new ActivityHandoffPump(f.activities,processor);
    return expect(pump.cycle([{runId:"run",signal:f.controller.signal}])).resolves.toMatchObject({failures:unrelated?[{runId:"run",error}]:[]});
  });
});
