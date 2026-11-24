import {describe,it,expect,vi} from "vitest";
import {prepareResponses,ResponsesSession,type ResponsesSessionStore,type ResponsesSessionState} from "@agent-anything/provider-integrations/native";
import {defaultProviderDraft,type ProviderConfiguration} from "../../shared/ProviderConfiguration.js";
import type {ProviderConfigurationService} from "./ProviderConfigurationService.js";
import type {ProviderDependencyPin} from "./ProviderRegistryProtocol.js";
import {HelarcResponsesTransport,helarcResponsesSessionBinding} from "./HelarcResponsesTransport.js";

function configuration(socket=false):ProviderConfiguration {
  const draft=defaultProviderDraft("openai.responses");
  if(draft.native.protocol!=="openai.responses")throw new Error("Invalid fixture");
  return {...draft,model:"fixture",id:"configuration",revision:"1",semanticRevision:"1",connectionBindingId:"original-connection",
    credentialBackend:"windows-reference",credentialAvailability:"unchecked",availabilityObservedAt:null,
    targetAttribution:"provider_endpoint",isDefault:false,archived:false,
    native:{...draft.native,...(socket?{transport:"websocket",continuity:"connection-memory",allowConnectionMemory:true}: {})}};
}
function fixture(socket=false){
  let current=configuration(socket),pin:ProviderDependencyPin|null={id:"pin",bindingId:"original-connection",acceptanceId:"accepted",
    owner:"task",purpose:"original-request",state:"confirmed"};
  const ids:string[]=[];
  const service:Pick<ProviderConfigurationService,"readPin"|"withConnection">={
    readPin:async()=>pin,
    withConnection:async<T>(id:string,send:(c:ProviderConfiguration,key:string)=>Promise<T>)=>{ids.push(id);return send(current,"synthetic-key");},
  };
  const transport=new HelarcResponsesTransport(service,{kind:"connection",bindingId:"original-connection",pinId:"pin",acceptanceId:"accepted"});
  return {transport,ids,current:()=>current,change:(next:ProviderConfiguration)=>{current=next;},release:()=>{pin=null;}};
}
async function session(configuration:ProviderConfiguration,incarnation:string|null){
  if(configuration.native.protocol!=="openai.responses")throw new Error("Invalid fixture");
  const prepared=prepareResponses({model:configuration.model,input:[{role:"user",content:"synthetic"}],purpose:{id:"task",revision:"1"},
    transport:configuration.native.transport,stream:configuration.native.stream,store:configuration.native.store});
  const binding=helarcResponsesSessionBinding({configuration,prepared,id:"session",scopeId:"scope",connectionIncarnation:incarnation,
    createdAt:Date.now(),maximumBytes:100000,maximumFrameBytes:10000,maximumEvents:1000});
  let state:ResponsesSessionState|null=null;
  const store:ResponsesSessionStore={load:async()=>state,commit:async(_,next)=>{state=next;},async *segments(){}};
  return ResponsesSession.open(binding,store);
}

describe("Responses original connection custody",()=>{
  it("passes the retained configuration and key only to the trusted native sender",async()=>{
    const f=fixture(),s=await session(f.current(),null),authorize=vi.fn(async()=>{});
    const call=vi.spyOn(s,"step").mockImplementation(async env=>{
      expect(env.baseUrl).toBe(f.current().baseUrl);expect(env.headers.authorization).toBe("Bearer synthetic-key");
      expect(env.authorize).toBe(authorize);expect(env.target).toBe(s.binding.target);return s.snapshot();
    });
    await f.transport.step(s,new AbortController().signal,authorize);
    expect(f.ids).toEqual(["original-connection"]);expect(call).toHaveBeenCalledOnce();
    expect(JSON.stringify(s.snapshot())).not.toContain("synthetic-key");
  });
  it("rejects a missing accepted dependency before resolving credentials",async()=>{
    const f=fixture(),s=await session(f.current(),null);f.release();
    await expect(f.transport.step(s,new AbortController().signal,async()=>{})).rejects.toThrow("provider_connection_acceptance_mismatch");
    expect(f.ids).toEqual([]);
  });
  it("does not replace an original target with a changed configuration",async()=>{
    const f=fixture(),s=await session(f.current(),null);f.change({...f.current(),revision:"2",model:"other"});
    const call=vi.spyOn(s,"step");
    await expect(f.transport.step(s,new AbortController().signal,async()=>{})).rejects.toThrow("responses_original_target_changed");
    expect(call).not.toHaveBeenCalled();
  });
  it("does not label a new physical socket as the lost connection-memory incarnation",async()=>{
    const f=fixture(true),s=await session(f.current(),"lost-incarnation");
    const call=vi.spyOn(s,"step");
    await expect(f.transport.step(s,new AbortController().signal,async()=>{})).rejects.toThrow("responses_connection_incarnation_lost");
    expect(call).not.toHaveBeenCalled();await f.transport.close();
  });
});
