import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
import type {ActivityHandoffCommand} from "@agent-anything/agent-runtime/activity";
import type {ExecutionErrorDetails} from "../diagnostics/ExecutionErrorDetails.js";
import type {ExecutionStoreReply,ExecutionStoreRequest,ExecutionStoreWireCommand} from "./ExecutionStoreProtocol.js";
import type {ExecutionContentRoot} from "./ExecutionContent.js";
import {packExecutionContent} from "./ExecutionContent.js";
import {HelarcExecutionStore} from "./HelarcExecutionStore.js";

const wire=vi.hoisted(()=>({commands:[] as ExecutionStoreWireCommand[],rejectAt:"activity_handoff",
  rejection:null as {code:string;error:ExecutionErrorDetails}|null,responseRoot:null as ExecutionContentRoot|null,
  blocks:new Map<string,{id:string;text:string}>()}));
vi.mock("node:worker_threads",async importOriginal=>{
  const actual=await importOriginal<typeof import("node:worker_threads")>();
  const {EventEmitter}=await import("node:events");
  class Worker extends EventEmitter {
    readonly threadId=1;
    constructor() {super();queueMicrotask(()=>this.reply({kind:"ready",generation:1}));}
    private reply(value:ExecutionStoreReply) {this.emit("message",value);}
    postMessage(request:ExecutionStoreRequest) {
      wire.commands.push(request.command);
      queueMicrotask(()=>{
        const kind=request.command.kind;
        if(kind===wire.rejectAt&&wire.rejection) {
          this.reply({kind:"rejected",id:request.id,...wire.rejection});return;
        }
        if(kind==="close") {
          this.reply({kind:"result",id:request.id,value:null});queueMicrotask(()=>this.emit("exit",0));return;
        }
        if(kind==="stage_content") {this.reply({kind:"content_staged",id:request.id});return;}
        if(kind==="activity_handoff"&&wire.responseRoot) {
          this.reply({kind:"content_result",id:request.id,root:wire.responseRoot});return;
        }
        if(request.command.kind==="read_content") {
          this.reply({kind:"content_blocks",id:request.id,blocks:request.command.ids.map(id=>wire.blocks.get(id)!)});return;
        }
        if(kind==="list_product_runs") {this.reply({kind:"result",id:request.id,value:[]});return;}
        throw new Error(`Unexpected fixture wire command ${kind}`);
      });
    }
    async terminate() {this.emit("exit",0);return 0;}
  }
  return {...actual,Worker};
});

const stores:HelarcExecutionStore[]=[];
beforeEach(()=>{wire.commands=[];wire.rejectAt="activity_handoff";wire.rejection=null;wire.responseRoot=null;wire.blocks.clear();});
afterEach(async()=>{for(const store of stores.splice(0))await store.close();});
async function open(record=vi.fn()) {
  const store=await HelarcExecutionStore.open("unused-mocked-worker-directory",undefined,undefined,undefined,{record});
  stores.push(store);return {store,record};
}
function dispatch(worker="worker"):ActivityHandoffCommand {
  return {kind:"dispatch",expectedControlRevision:0,attempt:{id:"attempt",requestId:"stage",inputDigest:"original-input",
    startedAt:"2026-11-01T00:00:00Z",executor:{hostSession:"host",worker,generation:1}}};
}
function reject(code:string) {
  wire.rejection={code,error:{name:"ActivityError",message:"Original dispatch decision",stack:"original-worker-stack",fields:{code},
    cause:{name:"Error",message:"Original basis",stack:null,fields:{},cause:null}}};
  return {code,cause:{name:"ActivityError",message:"Original dispatch decision",stack:"original-worker-stack",code,
    cause:{message:"Original basis"}}};
}

describe("execution Store dispatch-wait diagnostics",()=>{
  it("reuses only verified transport bytes after a fresh authoritative response",async()=>{
    const {store}=await open();
    const value={activityValue:{retained:"large-content".repeat(10000)}};
    const packed=packExecutionContent(value);wire.responseRoot={format:1,root:packed.root};
    for(const block of packed.blocks)wire.blocks.set(block.id,block);
    await expect(store.activityHandoffs.command({kind:"read_path",pathId:"path"})).resolves.toEqual(value.activityValue);
    const reads=wire.commands.filter(c=>c.kind==="read_content").length;
    expect(reads).toBeGreaterThan(0);
    await expect(store.activityHandoffs.command({kind:"read_path",pathId:"path"})).resolves.toEqual(value.activityValue);
    expect(wire.commands.filter(c=>c.kind==="read_content")).toHaveLength(reads);
    expect(wire.commands.filter(c=>c.kind==="activity_handoff")).toHaveLength(2);
    const expected=reject("execution_owner_stale");
    await expect(store.activityHandoffs.command({kind:"read_path",pathId:"path"})).rejects.toMatchObject(expected);
    wire.rejection=null;
    const changed=packExecutionContent({activityValue:{...value.activityValue,revision:2}});
    wire.responseRoot={format:1,root:changed.root};for(const block of changed.blocks)wire.blocks.set(block.id,block);
    await expect(store.activityHandoffs.command({kind:"read_path",pathId:"path"})).resolves.toEqual({...value.activityValue,revision:2});
    expect(wire.commands.filter(c=>c.kind==="read_content").length).toBeGreaterThan(reads);
  });
  it.each(["activity_dependency_waiting","activity_slot_waiting","activity_schedule_turn_waiting",
    "activity_schedule_not_ready","activity_authorization_restricted"])("returns %s unchanged without a storage failure",async code=>{
    const {store,record}=await open(),expected=reject(code);
    await expect(store.activityHandoffs.command(dispatch())).rejects.toMatchObject(expected);
    expect(record).not.toHaveBeenCalled();
    await expect(store.listProductRuns()).resolves.toEqual([]);
    expect(wire.commands.filter(command=>command.kind==="activity_handoff")).toHaveLength(1);
  });
  it("keeps the original dispatch classification when the command is transferred as content",async()=>{
    const {store,record}=await open(),expected=reject("activity_schedule_not_ready");wire.rejectAt="invoke_content";
    await expect(store.activityHandoffs.command(dispatch("worker".repeat(20000)))).rejects.toMatchObject(expected);
    expect(wire.commands.some(command=>command.kind==="stage_content")).toBe(true);
    expect(wire.commands.filter(command=>command.kind==="invoke_content")).toHaveLength(1);
    expect(record).not.toHaveBeenCalled();await expect(store.listProductRuns()).resolves.toEqual([]);
  });
  it.each(["admit","claim_processing","settle"] as const)("does not suppress the same code from %s",async kind=>{
    const {store,record}=await open(),expected=reject("activity_authorization_restricted");
    const command:ActivityHandoffCommand=kind==="admit"?{kind,requestId:"stage",expectedControlRevision:0}:
      kind==="claim_processing"?{kind,expectedControlRevision:0,claim:{id:"claim",requestId:"stage",previousClaimId:null,
        executor:{hostSession:"host",worker:"worker",generation:1}}}:
        {kind,expectedControlRevision:0,executor:{hostSession:"host",worker:"worker",generation:1},
          receipt:{id:"settlement",requestId:"stage",resultId:"raw",owner:"owner",disposition:{kind:"retained"}}};
    const error=await store.activityHandoffs.command(command).then(()=>null,error=>error);
    expect(error).toMatchObject(expected);
    expect(record).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledWith("storage_worker_rejected",expect.objectContaining({command:"activity_handoff"}),error);
  });
  it("does not suppress a wait-shaped code from a non-activity storage command",async()=>{
    const {store,record}=await open(),expected=reject("activity_schedule_not_ready");wire.rejectAt="read_owner_latest";
    const error=await store.readLatestRun("run").then(()=>null,error=>error);
    expect(error).toMatchObject(expected);
    expect(record).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledWith("storage_worker_rejected",expect.objectContaining({command:"read_owner_latest"}),error);
  });
  it.each(["activity_schedule_corrupt","activity_schedule_not_ready:changed","execution_owner_stale"])("retains failure diagnostics for %s",async code=>{
    const {store,record}=await open(),expected=reject(code);
    const error=await store.activityHandoffs.command(dispatch()).then(()=>null,error=>error);
    expect(error).toMatchObject(expected);
    expect(record).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledWith("storage_worker_rejected",expect.objectContaining({command:"activity_handoff"}),error);
  });
  it.each(["stage_content","read_content"])("does not treat %s transfer failure as a dispatch decision",async kind=>{
    const {store,record}=await open(),expected=reject("activity_schedule_not_ready");wire.rejectAt=kind;
    if(kind==="read_content")wire.responseRoot={format:1,root:packExecutionContent({activityValue:null}).root};
    const error=await store.activityHandoffs.command(dispatch(kind==="stage_content"?"worker".repeat(20000):"worker")).then(()=>null,error=>error);
    expect(error).toMatchObject(expected);
    expect(wire.commands.some(command=>command.kind===kind)).toBe(true);
    expect(record).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledWith("storage_worker_rejected",expect.objectContaining({transferOperation:kind}),error);
  });
  it("preserves the rejection even when the diagnostic sink itself throws",async()=>{
    const record=vi.fn(()=>{throw new Error("observer unavailable");}),{store}=await open(record),expected=reject("activity_schedule_corrupt");
    await expect(store.activityHandoffs.command(dispatch())).rejects.toMatchObject(expected);
    expect(record).toHaveBeenCalledTimes(1);await expect(store.listProductRuns()).resolves.toEqual([]);
  });
});
