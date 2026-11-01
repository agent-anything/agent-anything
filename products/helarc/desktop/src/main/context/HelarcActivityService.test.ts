import {describe,it,expect,vi} from "vitest";
import {ActivityPurposeRegistry,type ActivityHandoffCommand,type ActivityPurposeHandler} from "@agent-anything/agent-runtime/activity";
import type {HelarcExecutionStore} from "../execution-storage/HelarcExecutionStore.js";
import {HelarcActivityService} from "./HelarcActivityService.js";

describe("application activity discovery",()=>{
  it("isolates unavailable original bindings but stops dispatch when durable discovery fails",async()=>{
    let unavailableStore=false;
    const read=vi.fn(async(command:ActivityHandoffCommand)=>{
      if(command.kind==="pending_scopes"){
        if(unavailableStore)throw new Error("shared_storage_unavailable");
        return [{runId:"bad"},{runId:"good"}];
      }
      if(command.kind==="review_scheduling")return {nextReviewAt:null};
      if(command.kind==="pending")return [];
      throw new Error(`Unexpected ${command.kind}`);
    });
    const record=vi.fn(),unsubscribe=vi.fn();
    const store={activityHandoffs:{command:read},activityJournal:{executor:{id:"host",generation:1}},onActivityChange:()=>unsubscribe} as unknown as HelarcExecutionStore;
    const service=new HelarcActivityService({store,purposes:new ActivityPurposeRegistry<ActivityPurposeHandler>(),purposeIds:[],rediscoveryMs:10,
      scopeAvailable:async id=>{if(id==="bad")throw new Error("original_binding_missing");return true;},diagnostics:{record,performance:()=>{}}});
    try {
      await vi.waitFor(()=>expect(read.mock.calls.some(([command])=>command.kind==="pending"&&command.runId==="good")).toBe(true));
      expect(()=>service.assertAvailable()).not.toThrow();
      expect(record.mock.calls.filter(([stage])=>stage==="activity_binding")).toHaveLength(1);
      unavailableStore=true;service.wake();
      await vi.waitFor(()=>expect(()=>service.assertAvailable()).toThrow("Activity Host is failed"));
      try {service.assertAvailable();} catch(error) {expect((error as Error).cause).toMatchObject({message:"shared_storage_unavailable"});}
    } finally {await service.close();}
    expect(unsubscribe).toHaveBeenCalledOnce();
  });
  it("stops foreground progression while allowing the shutdown settlement interval",async()=>{
    const store={activityHandoffs:{command:async(command:ActivityHandoffCommand)=>{
      if(command.kind==="pending_scopes")return [];
      if(command.kind==="review_scheduling")return {nextReviewAt:null};
      throw new Error(`Unexpected ${command.kind}`);
    }},activityJournal:{executor:{id:"host",generation:1}},onActivityChange:()=>()=>{}} as unknown as HelarcExecutionStore;
    const service=new HelarcActivityService({store,purposes:new ActivityPurposeRegistry<ActivityPurposeHandler>(),purposeIds:[]});
    const closing=service.close();
    expect(()=>service.assertAvailable()).toThrow("Activity Host is closing");
    expect(()=>service.assertAvailable("settlement")).not.toThrow();
    await closing;
    expect(()=>service.assertAvailable("settlement")).toThrow("Activity Host is closed");
  });
});
