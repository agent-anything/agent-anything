import {describe,it,expect,vi} from "vitest";
import {driveNativeFollowUpPages,type NativeFollowUpPage} from "./HelarcNativeFollowUpScheduling.js";

describe("independent native follow-up scheduling",()=>{
  it("does not await an unrelated remote responsibility before advancing local custody",async()=>{
    const abort=new AbortController();let release!:()=>void,entered!:()=>void;
    const remote=new Promise<void>(resolve=>{release=resolve;}),started=new Promise<void>(resolve=>{entered=resolve;});
    const remoteWork=driveNativeFollowUpPages({owner:"remote",signal:abort.signal,page:async()=>{
      entered();await remote;return {examined:1,more:false};
    }});
    await started;
    const local=vi.fn(async():Promise<NativeFollowUpPage>=>{abort.abort();return {examined:1,more:false};});
    const localWork=driveNativeFollowUpPages({owner:"input",signal:abort.signal,page:local});
    try{
      await localWork;
      expect(local).toHaveBeenCalledTimes(1);
    }finally{abort.abort();release();await remoteWork;}
  });

  it("attributes a blocked discovery without terminating another owner's schedule",async()=>{
    const abort=new AbortController(),record=vi.fn(),performance=vi.fn();
    let failed!:()=>void;const failure=new Promise<void>(resolve=>{failed=resolve;});
    const bad=driveNativeFollowUpPages({owner:"connection_custody",signal:abort.signal,
      diagnostics:{record:(...args)=>{record(...args);failed();},performance},
      page:async()=>{throw new Error("original_connection_unavailable");}});
    try{
      await failure;
      await driveNativeFollowUpPages({owner:"recipient_delivery",signal:abort.signal,page:async()=>{
        abort.abort();return {examined:1,more:false};
      }});
      expect(record).toHaveBeenCalledWith("native_follow_up_page_blocked",{responsibility:"connection_custody"},expect.any(Error));
      expect(performance).toHaveBeenCalledWith(expect.objectContaining({kind:"finished",outcome:"failed",
        context:expect.objectContaining({responsibility:"connection_custody"})}));
    }finally{abort.abort();await bad;}
  });

  it("awaits in-progress work on shutdown without turning shutdown into a discharge",async()=>{
    const abort=new AbortController();let release!:()=>void,closed=false;
    const blocked=new Promise<NativeFollowUpPage>(resolve=>{release=()=>resolve({examined:1,more:false});});
    const page=vi.fn(()=>blocked),work=driveNativeFollowUpPages({owner:"delivery",signal:abort.signal,page}).then(()=>{closed=true;});
    try{
      abort.abort();await Promise.resolve();
      expect(closed).toBe(false);
      release();await work;
      expect(page).toHaveBeenCalledTimes(1);
    }finally{abort.abort();release();await work;}
  });

  it("rejects an unbounded owner page and leaves its original pending responsibility intact",async()=>{
    const abort=new AbortController(),record=vi.fn();
    const page=vi.fn(async()=>({examined:17,more:true}));
    await driveNativeFollowUpPages({owner:"input_use",signal:abort.signal,page,
      diagnostics:{record:(...args)=>{record(...args);abort.abort();}}});
    expect(record).toHaveBeenCalledWith("native_follow_up_page_blocked",{responsibility:"input_use"},
      expect.objectContaining({message:"native_follow_up_page_bound_invalid"}));
    expect(page).toHaveBeenCalledTimes(1);
  });
});
