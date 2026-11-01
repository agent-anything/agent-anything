import {describe,it,expect} from "vitest";
import {ActivityPurposeRegistry,type ActivityPurposeHandler} from "@agent-anything/agent-runtime/activity";
import {HelarcActivityBindings} from "./HelarcActivityBindings.js";

describe("original tree activity bindings",()=>{
  it("does not enable pending child work before validated root activation",async()=>{
    const scopes=new HelarcActivityBindings(async id=>id==="child"?"root":null);
    const registry=new ActivityPurposeRegistry<ActivityPurposeHandler>();
    const handler={} as ActivityPurposeHandler;
    const binding=registry.register({ref:{id:"model",revision:"1"},inputOwner:"input",executionOwner:"model",interpretationOwner:"task",
      acceptanceOwner:"task",recoveryOwner:"task",stageKinds:["model"],capabilities:[],continuationKinds:[]},handler);
    expect(await scopes.available("child")).toBe(false);
    await expect(scopes.resolve(binding,{runId:"child",pathId:"original"})).rejects.toThrow("unavailable");
    scopes.bind("root",{originalBindingId:"validated-original",purposes:registry});
    expect(await scopes.available("child")).toBe(true);
    expect(await scopes.resolve(binding,{runId:"child",pathId:"original"})).toBe(handler);
    expect(await scopes.available("unrelated")).toBe(false);
    await expect(scopes.resolve({...binding,digest:"changed"},{runId:"child",pathId:"original"})).rejects.toThrow();
    expect(()=>scopes.bind("root",{originalBindingId:"changed-settings",purposes:registry})).toThrow("already_resolved");
  });
});
