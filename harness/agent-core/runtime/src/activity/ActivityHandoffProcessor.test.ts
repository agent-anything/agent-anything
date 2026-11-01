import {describe,expect,it,vi} from "vitest";
import {ActivityHandoffProcessor,type ActivityPurposeHandler} from "./ActivityHandoffProcessor.js";
import type {ActivityHandoffPort,ActivityPathState,ActivityStageState} from "./ActivityHandoff.js";

describe("ActivityHandoffProcessor control races",()=>{
  it.each(["activity_dependency_waiting","activity_slot_waiting","activity_schedule_turn_waiting",
    "activity_schedule_not_ready","activity_authorization_restricted","activity_schedule_corrupt"])("preserves dispatch outcome %s",async code=>{
    const path={intent:{id:"path",runId:"run",purpose:{contract:{ref:{id:"purpose"}}},deadlineAt:"2030-01-01T00:00:00Z"},controlRevision:0,cancelled:false} as ActivityPathState;
    const stage={request:{id:"stage",pathId:"path",input:{}},status:"admitted",attempt:null,result:null} as ActivityStageState;
    const failure=Object.assign(new Error(code),{code});
    const command=vi.fn(async(value:Parameters<ActivityHandoffPort["command"]>[0])=>{
      if(value.kind==="review_scheduling")return null;
      if(value.kind==="pending")return [{sequence:1,runId:"run",pathId:"path",requestId:"stage",kind:"execution"}];
      if(value.kind==="read_stage")return stage;
      if(value.kind==="read_path")return path;
      if(value.kind==="dispatch")throw failure;
      throw new Error(`Unexpected ${value.kind}`);
    });
    const handler={authorize:vi.fn(async()=>({kind:"allowed"})),execute:vi.fn()} as unknown as ActivityPurposeHandler;
    const processor=new ActivityHandoffProcessor({command},{resolve:()=>handler},{hostSession:"host",worker:"worker",generation:1},()=>"2026-11-01T00:00:00Z");
    expect(await processor.scan("run",new AbortController().signal)).toEqual(code==="activity_schedule_corrupt"?
      {progressed:[],pending:[],failures:[{requestId:"stage",error:failure}]}:
      {progressed:[],pending:[{requestId:"stage",reason:code}],failures:[]});
    expect(handler.execute).not.toHaveBeenCalled();
    expect(command.mock.calls.filter(([value])=>value.kind==="dispatch")).toHaveLength(1);
  });
  it.each([undefined,null,true,{}, {kind:"unexpected"}, {kind:"denied"}])("never treats missing or malformed authorization %j as permission",async authorization=>{
    const path={intent:{id:"path",runId:"run",purpose:{contract:{ref:{id:"purpose"}}},deadlineAt:"2030-01-01T00:00:00Z"},controlRevision:0,cancelled:false} as ActivityPathState;
    let stage={request:{id:"stage",pathId:"path"},status:"admitted",attempt:null,result:null} as ActivityStageState;
    const command=vi.fn(async (value:Parameters<ActivityHandoffPort["command"]>[0])=>{
      if(value.kind==="review_scheduling")return null;
      if(value.kind==="pending")return [{sequence:1,runId:"run",pathId:"path",requestId:"stage",kind:"execution"}];
      if(value.kind==="read_stage")return stage;
      if(value.kind==="read_path")return path;
      if(value.kind==="record_authorization_restriction")return stage={...stage,authorizationRestrictions:{execution:value.refusal!}};
      throw new Error(`Unexpected ${value.kind}`);
    });
    const handler={authorize:vi.fn(async()=>authorization),execute:vi.fn(),reconcile:vi.fn()} as unknown as ActivityPurposeHandler;
    const processor=new ActivityHandoffProcessor({command},{resolve:()=>handler},{hostSession:"host",worker:"worker",generation:1},()=>"2026-10-31T00:00:00Z");
    const result=await processor.scan("run",new AbortController().signal);
    expect(result.failures).toHaveLength(1);expect(result.pending).toEqual([{requestId:"stage",reason:"authorization_not_established"}]);
    expect(stage.authorizationRestrictions?.execution).toMatchObject({kind:"temporary",code:"authorization_not_established"});
    expect(command.mock.calls.some(([c])=>c.kind==="dispatch")).toBe(false);expect(handler.execute).not.toHaveBeenCalled();
  });
  it.each([
    ["admission","admitted"],["execution","dispatched"],["reconciliation","raw_result"],
    ["reconciliation","accepted"],["interpretation","settled"],["settlement","settled"],
  ] as const)("does not act on stale %s discovery after %s",async(kind,status)=>{
    const command=vi.fn(async(value:{kind:string})=>value.kind==="pending"?[{sequence:1,runId:"run",pathId:"path",requestId:"stage",kind}]:
      value.kind==="read_stage"?{request:{id:"stage"},status}:value.kind==="read_path"?{intent:{id:"path",runId:"run"},cancelled:false}:null);
    const resolve=vi.fn();
    const processor=new ActivityHandoffProcessor({command},{resolve},{hostSession:"host",worker:"worker",generation:1},()=>"2026-10-31T00:00:00Z");
    expect(await processor.scan("run",new AbortController().signal)).toEqual({progressed:[],pending:[{requestId:"stage",reason:"handoff_already_progressed"}],failures:[]});
    expect(resolve).not.toHaveBeenCalled();expect(command.mock.calls.map(c=>c[0].kind)).toEqual(["review_scheduling","pending","read_stage","read_path"]);
  });
  it("does not reconcile a local execution that completes between stage and path reads",async()=>{
    const path={intent:{id:"path",runId:"run",purpose:{contract:{ref:{id:"purpose"}}}},controlRevision:0,cancelled:false} as ActivityPathState;
    let stage={request:{id:"stage",pathId:"path",input:{}},status:"admitted",attempt:null,result:null} as unknown as ActivityStageState;
    let release!:()=>void,finishDuringRead=false;
    const executing=new Promise<void>(resolve=>{release=resolve;});
    const handler={authorize:vi.fn(async()=>({kind:"allowed"})),execute:vi.fn(async(_path,_stage,attempt)=>{await executing;return {id:"raw",attemptId:attempt.id};}),reconcile:vi.fn()} as unknown as ActivityPurposeHandler;
    const port:ActivityHandoffPort={command:vi.fn(async command=>{
      if(command.kind==="pending")return [{sequence:1,runId:"run",pathId:"path",requestId:"stage",kind:stage.status==="admitted"?"execution":"reconciliation"}];
      if(command.kind==="read_stage")return stage;
      if(command.kind==="read_path") {if(finishDuringRead){release();await processor.settled();}return path;}
      if(command.kind==="dispatch"){stage={...stage,status:"dispatched",attempt:command.attempt};return {granted:true,stage};}
      if(command.kind==="save_raw"){stage={...stage,status:"raw_result",result:command.result};return stage;}
      if(command.kind==="review_scheduling")return null;
      throw new Error(`Unexpected ${command.kind}`);
    })};
    const processor=new ActivityHandoffProcessor(port,{resolve:()=>handler},{hostSession:"host",worker:"worker",generation:1},()=>"2026-10-31T00:00:00Z");
    await processor.scan("run",new AbortController().signal);finishDuringRead=true;
    const result=await processor.scan("run",new AbortController().signal);
    expect(result.failures).toEqual([]);expect(handler.execute).toHaveBeenCalledTimes(1);expect(handler.reconcile).not.toHaveBeenCalled();
    expect(stage.status).toBe("raw_result");
  });
  it.each(["cancelled","control_conflict","unchanged","different_path","unrelated_error"])("rechecks original control after %s",async situation=>{
    const path={intent:{id:"path",runId:"run",purpose:{contract:{ref:{id:"purpose"}}}},controlRevision:0,cancelled:false} as ActivityPathState;
    const stage={request:{id:"stage",pathId:"path"},status:"raw_result",processing:null} as ActivityStageState;
    let changed=false;
    const failure={code:situation==="control_conflict"?"activity_control_conflict":situation==="unrelated_error"?"binding_invalid":"activity_cancelled"};
    const port:ActivityHandoffPort={command:vi.fn(async command=>{
      if(command.kind==="review_scheduling")return null;
      if(command.kind==="pending")return [{sequence:1,runId:"run",pathId:"path",requestId:"stage",kind:"interpretation"}];
      if(command.kind==="read_stage")return stage;
      if(command.kind==="read_path")return changed&&situation!=="unchanged"?{...path,intent:situation==="different_path"?{...path.intent,runId:"other"}:path.intent,controlRevision:1,cancelled:true}:path;
      if(command.kind==="claim_processing"){changed=true;throw failure;}
      throw new Error(`Unexpected ${command.kind}`);
    })};
    const handler={authorize:vi.fn(async()=>({kind:"allowed"})),execute:vi.fn(),interpret:vi.fn(),reconcile:vi.fn()} as unknown as ActivityPurposeHandler;
    const processor=new ActivityHandoffProcessor(port,{resolve:()=>handler},{hostSession:"host",worker:"worker",generation:1},()=>"2026-10-30T00:00:00Z");
    const result=await processor.scan("run",new AbortController().signal);
    if(situation==="cancelled"||situation==="control_conflict")expect(result).toEqual({progressed:[],pending:[{requestId:"stage",reason:"control_changed"}],failures:[]});
    else expect(result.failures).toEqual([{requestId:"stage",error:failure}]);
    expect(handler.execute).not.toHaveBeenCalled();expect(handler.interpret).not.toHaveBeenCalled();
  });
});
