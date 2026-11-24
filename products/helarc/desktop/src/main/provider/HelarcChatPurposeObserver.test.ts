import {afterEach,describe,expect,it,vi} from "vitest";
import Database from "better-sqlite3";
import {bindModelAgentComposition,OLLAMA_CHAT,DEEPSEEK_CHAT_COMPLETIONS} from "@agent-anything/model-interaction/protocol";
import {bindProtocolModelActivity,retainProtocolContent,type ProtocolExecutionState,type ProtocolExecutionJournal} from "@agent-anything/agent-runtime/model-access";
import {prepareHelarcOllamaStructured,prepareHelarcDeepSeekStructured,HELARC_NATIVE_STRUCTURED_INTERPRETER} from "@agent-anything/helarc/controller";
import {OLLAMA_CHAT_ADAPTER,DEEPSEEK_CHAT_ADAPTER} from "@agent-anything/provider-integrations/native";
import {ProtocolExecutionDatabase,PROTOCOL_EXECUTION_SCHEMA,PROTOCOL_RECONCILIATION_SCHEMA,PROTOCOL_ADMISSION_SCHEMA} from "../execution-storage/ProtocolExecutionDatabase.js";
import {PROTOCOL_EVIDENCE_SCHEMA} from "../execution-storage/ProtocolEvidenceDatabase.js";
import {SharedAcceptanceDatabase,SHARED_ACCEPTANCE_SCHEMA} from "../execution-storage/SharedAcceptanceDatabase.js";
import {defaultProviderDraft,type ProviderConfiguration} from "../../shared/ProviderConfiguration.js";
import type {ProviderConfigurationService} from "./ProviderConfigurationService.js";
import type {ProviderDependencyPin} from "./ProviderRegistryProtocol.js";
import type {HelarcExecutionStore} from "../execution-storage/HelarcExecutionStore.js";
import {HelarcChatPurposeObserver} from "./HelarcChatPurposeObserver.js";

const databases:Database.Database[]=[];
afterEach(()=>{vi.unstubAllGlobals();vi.restoreAllMocks();for(const db of databases.splice(0))db.close();});
const ref=(id:string)=>({id,revision:"1"});
async function fixture(protocol: "ollama.chat"|"deepseek.chat-completions"="ollama.chat"){
  const db=new Database(":memory:");databases.push(db);
  db.exec(PROTOCOL_EXECUTION_SCHEMA+PROTOCOL_RECONCILIATION_SCHEMA+PROTOCOL_ADMISSION_SCHEMA+PROTOCOL_EVIDENCE_SCHEMA+SHARED_ACCEPTANCE_SCHEMA);
  const storage=new ProtocolExecutionDatabase(db,()=>1),acceptance=new SharedAcceptanceDatabase(db,[storage.participant()]);
  const journal:ProtocolExecutionJournal={command:async command=>storage.command(command)};
  const store={protocolJournal:journal,sharedAcceptance:{accept:async value=>acceptance.accept(value),query:async id=>acceptance.query(id)}} as HelarcExecutionStore;
  const configuration:ProviderConfiguration={...defaultProviderDraft(protocol),id:"configuration",revision:"1",semanticRevision:"1",model:"controlled",connectionBindingId:"connection",
    credentialBackend:"safe-storage",credentialAvailability:"unchecked",availabilityObservedAt:null,targetAttribution:"provider_endpoint",archived:false,isDefault:false};
  const pins=new Map<string,ProviderDependencyPin>();
  const connect=vi.fn(async(_id:string,send:(configuration:ProviderConfiguration,key:string)=>Promise<unknown>)=>send(configuration,"synthetic-secret"));
  const providers={pin:async(pin:ProviderDependencyPin)=>{pins.set(pin.id,pin);},readPin:async(id:string)=>pins.get(id)??null,
    settlePin:async(id:string,_accepted:string,state:ProviderDependencyPin["state"])=>{pins.set(id,{...pins.get(id)!,state});},
    binding:async()=>({configuration}),withConnection:connect} as unknown as ProviderConfigurationService;
  const protocolRef=protocol==="ollama.chat"?OLLAMA_CHAT:DEEPSEEK_CHAT_COMPLETIONS,adapter=protocol==="ollama.chat"?OLLAMA_CHAT_ADAPTER:DEEPSEEK_CHAT_ADAPTER;
  const participant=(id:string)=>({implementation:ref(id),protocol:protocolRef});
  const composition=bindModelAgentComposition({agent:ref("agent"),protocol:protocolRef,
    configuration:{configuration:ref("configuration"),protocol:protocolRef,model:"controlled",connectionBinding:ref("connection")},adapter:{protocol:protocolRef,implementation:adapter},
    task:{purpose:ref("task"),input:participant("task-input"),interpreter:participant("task-interpreter")},
    auxiliary:[{purpose:ref("check"),input:participant("check-input"),interpreter:{implementation:HELARC_NATIVE_STRUCTURED_INTERPRETER,protocol:protocolRef}}]});
  const activity=bindProtocolModelActivity({composition,scope:{runId:"run",recipientId:"agent",activityId:"activity",purpose:ref("check"),compositionDigest:composition.digest},
    conditions:{input:ref("source"),authority:ref("authority"),resources:ref("resources"),control:ref("control")}});
  const source={activity,source:ref("source")},schema={type:"object",properties:{ok:{type:"boolean"}},required:["ok"],additionalProperties:false};
  const request=protocol==="ollama.chat"?prepareHelarcOllamaStructured(source,{messages:[{role:"user",content:"Return JSON"}],format:schema,stream:false}):
    prepareHelarcDeepSeekStructured(source,{messages:[{role:"user",content:"Return JSON"}],jsonSchema:schema,stream:false});
  const observer=new HelarcChatPurposeObserver(store,providers),prepared=await observer.prepare(activity,request,configuration);
  const content=await retainProtocolContent(journal,"prepared","activity",Buffer.from(JSON.stringify(prepared)));
  expect(acceptance.accept({id:"activity:prepare",scope:"run",actor:"execution-coordinator",
    parts:[{owner:"protocol_execution",kind:"prepare",proposal:{activity,input:content}}]}).outcome).toBe("accepted");
  expect(acceptance.accept({id:"claim",scope:"run",actor:adapter.id,parts:[{owner:"protocol_execution",kind:"claim",proposal:{activityId:"activity",expectedEpoch:0}}]}).outcome).toBe("accepted");
  const state=()=>storage.command({kind:"state",activityId:"activity"}) as ProtocolExecutionState;
  const record=(id:string)=>storage.command({kind:"record",activityId:"activity",ref:ref(id)});
  const response=()=>new Response(JSON.stringify(protocol==="ollama.chat"?{model:"controlled",created_at:new Date().toISOString(),message:{role:"assistant",content:'{"ok":true}'},done:true,done_reason:"stop"}:
    {id:"chat-1",object:"chat.completion",model:"controlled",choices:[{index:0,finish_reason:"stop",message:{role:"assistant",content:'{"ok":true}'}}]}),{status:200});
  return {store,providers,observer,prepared,configuration,state,record,response,connect,acceptance,adapter};
}
const signal=()=>new AbortController().signal;
describe("native Chat purpose observation custody",()=>{
  it.each(["ollama.chat","deepseek.chat-completions"] as const)("replays retained %s HTTP without a new POST or a key read",async protocol=>{
    const f=await fixture(protocol),fetch=vi.fn(async()=>f.response());vi.stubGlobal("fetch",fetch);
    const original=f.store.sharedAcceptance.accept.bind(f.store.sharedAcceptance);
    const accept=vi.spyOn(f.store.sharedAcceptance,"accept").mockImplementation(async value=>{
      if(value.parts.some(p=>p.owner==="protocol_execution"&&p.kind==="record"&&(p.proposal as {record:{ref:{id:string}}}).record.ref.id==="activity:response"))throw new Error("Injected parse-result persistence failure");
      return original(value);
    });
    await expect(f.observer.observe(f.state(),f.prepared,signal(),async()=>{})).rejects.toThrow("Activity progress");
    expect(f.record("activity:create:http-complete")).not.toBeNull();expect(f.record("activity:response")).toBeNull();
    accept.mockRestore();f.connect.mockImplementation(async()=>{throw new Error("Key is unavailable");});
    const resumed=new HelarcChatPurposeObserver(f.store,f.providers);
    expect((await resumed.observe(f.state(),f.prepared,signal(),async()=>{})).ref.id).toBe("activity:response");
    expect(fetch).toHaveBeenCalledOnce();expect(f.connect).toHaveBeenCalledOnce();await resumed.close();
  });
  it("does not repeat an unresolved POST and keeps cancellation uncertainty explicit",async()=>{
    const f=await fixture(),fetch=vi.fn(async()=>{throw new Error("connection lost");});vi.stubGlobal("fetch",fetch);
    await expect(f.observer.observe(f.state(),f.prepared,signal(),async()=>{})).rejects.toThrow("Activity progress");
    const resumed=new HelarcChatPurposeObserver(f.store,f.providers);
    await expect(resumed.observe(f.state(),f.prepared,signal(),async()=>{})).rejects.toMatchObject({cause:{message:"chat_original_creation_unresolved"}});
    expect(fetch).toHaveBeenCalledOnce();expect(f.connect).toHaveBeenCalledOnce();
    expect(f.acceptance.accept({id:"cancel",scope:"run",actor:"execution-coordinator",parts:[{owner:"protocol_execution",kind:"control",proposal:{activityId:"activity",expectedRevision:0,cancelled:true}}]}).outcome).toBe("accepted");
    await resumed.interrupt(f.state(),f.prepared,"cancel-disposition");expect(f.record("cancel-disposition")).not.toBeNull();
    const accept=vi.spyOn(f.store.sharedAcceptance,"accept");
    await resumed.interrupt({...f.state(),fence:{...f.state().fence,generation:2,epoch:2}},f.prepared,"cancel-disposition");
    expect(accept).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledOnce();await resumed.close();
  });
  it("does not record dispatch or contact the endpoint when current authority rejects",async()=>{
    const f=await fixture(),fetch=vi.fn();vi.stubGlobal("fetch",fetch);
    await expect(f.observer.observe(f.state(),f.prepared,signal(),async()=>{throw new Error("revoked");})).rejects.toMatchObject({cause:{message:"revoked"}});
    expect(f.record("activity:create:dispatch")).toBeNull();expect(fetch).not.toHaveBeenCalled();await f.observer.close();
  });
  it("rejects mutated prepared input before reading a credential",async()=>{
    const f=await fixture(),fetch=vi.fn();vi.stubGlobal("fetch",fetch);
    await expect(f.observer.observe(f.state(),{...f.prepared,wire:{...f.prepared.wire,body:"{}"}},signal(),async()=>{}))
      .rejects.toMatchObject({cause:{message:"chat_purpose_original_transport_changed"}});
    expect(f.connect).not.toHaveBeenCalled();expect(fetch).not.toHaveBeenCalled();await f.observer.close();
  });
});
