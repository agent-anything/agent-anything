import {ActivityCheckpointError} from "@agent-anything/agent-runtime/activity";
import {readProtocolContent,retainProtocolContent,type ProtocolExecutionState,type ProtocolModelActivity,
  type ProtocolJournalRecord} from "@agent-anything/agent-runtime/model-access";
import {modelInputValueDigest as digest} from "@agent-anything/model-interaction/input";
import {dispatchDeepSeekChat,dispatchOllamaChat,readDeepSeekObservation,readOllamaChatObservation,deepSeekInputCapacityRefused,ollamaInputCapacityRefused,
  type NativeHttpObservation} from "@agent-anything/provider-integrations/native";
import type {HelarcNativeRunTask,HelarcNativeStructuredRequest} from "@agent-anything/helarc/controller";
import type {HelarcNativePreviewObserver} from "@agent-anything/helarc/run";
import type {HelarcExecutionStore} from "../execution-storage/HelarcExecutionStore.js";
import type {ProviderConfiguration} from "../../shared/ProviderConfiguration.js";
import type {ProviderConfigurationService} from "./ProviderConfigurationService.js";
import {ProviderConnectionRetention,type RetainedConnection} from "./ProviderConnectionRetention.js";
import {releaseHelarcNativeRetention,readHelarcNativeDischarge,settleHelarcNativeInputUse,type HelarcNativeDeliveryResolution} from "./HelarcNativeRetention.js";
import {hasHelarcNativeUsage,recordHelarcNativeUsage,registerHelarcNativeUsage} from "./HelarcNativeUsage.js";

type Protocol="ollama.chat"|"deepseek.chat-completions";
type Request=HelarcNativeRunTask|HelarcNativeStructuredRequest;
interface ChatTransportBinding {
  readonly protocol:Protocol;
  readonly connection:RetainedConnection;
  readonly deadlineAt:number;
  readonly maximumBytes:number;
  readonly endpoint?:string;
}
type BoundRequest=Request&{readonly chatTransport:ChatTransportBinding};

/** Custody for original non-resumable chat POSTs; it does not select a task or retry an unknown creation. */
export class HelarcChatPurposeObserver {
  private readonly retention:ProviderConnectionRetention;
  private readonly observing=new Set<string>();
  constructor(private readonly store:HelarcExecutionStore,private readonly providers:ProviderConfigurationService){
    this.retention=new ProviderConnectionRetention(providers,{read:async pin=>{
      const accepted=await store.sharedAcceptance.query(pin.acceptanceId);
      return accepted?.outcome==="accepted"?"accepted":"unknown";
    }});
  }
  async prepare<T extends Request>(activity:ProtocolModelActivity,request:T,configuration:ProviderConfiguration):Promise<T&{readonly chatTransport:ChatTransportBinding}>{
    const c=activity.composition.composition.configuration,id=activity.scope.activityId;
    if(configuration.protocol!=="ollama.chat"&&configuration.protocol!=="deepseek.chat-completions")throw new TypeError("chat_protocol_required");
    if(configuration.protocol!==c.protocol.id||c.configuration.id!==configuration.id||c.configuration.revision!==configuration.revision||
      c.connectionBinding.id!==configuration.connectionBindingId||c.model!==configuration.model)throw new TypeError("chat_purpose_configuration_changed");
    const pin={id:`${id}:connection`,bindingId:configuration.connectionBindingId,acceptanceId:`${id}:prepare`,
      owner:activity.composition.composition.adapter.implementation.id,purpose:activity.scope.purpose.id,state:"provisional" as const};
    await this.store.protocolJournal.command({kind:"reserve_admission",activity});
    await this.providers.pin(pin);
    return {...request,chatTransport:{protocol:configuration.protocol,
      connection:{kind:"connection",bindingId:pin.bindingId,pinId:pin.id,acceptanceId:pin.acceptanceId},
      deadlineAt:Date.now()+configuration.generationLifetimeMs,maximumBytes:32*1024*1024,endpoint:configuration.baseUrl}};
  }
  async observe(state:ProtocolExecutionState,request:Request,signal:AbortSignal,authorize:()=>Promise<void>,preview?:HelarcNativePreviewObserver):Promise<ProtocolJournalRecord>{
    const id=state.activity.scope.activityId;
    if(this.observing.has(id))throw new ActivityCheckpointError(`${id}:chat-observation-busy`);
    this.observing.add(id);
    try{return await this.observeOriginal(state,request,signal,authorize,preview);}
    catch(cause){if(cause instanceof ActivityCheckpointError)throw cause;throw new ActivityCheckpointError(`${state.activity.scope.activityId}:chat-observation`,{cause});}
    finally{this.observing.delete(id);}
  }
  async interrupt(state:ProtocolExecutionState,request:Request,identity:string):Promise<null>{
    if(!state.cancelled)throw new TypeError("chat_purpose_cancellation_not_accepted");
    const id=state.activity.scope.activityId,journal=this.store.protocolJournal;
    const original=JSON.parse((await readProtocolContent(journal,state.input,id,32*1024*1024)).toString());
    if(digest(original)!==digest(request))throw new TypeError("chat_purpose_original_transport_changed");
    const operationId=request.format==="helarc.native-prepared-task.v1"?request.binding.operationId:request.operationId;
    const dispatched=await journal.command({kind:"record",activityId:id,ref:{id:`${operationId}:dispatch`,revision:"1"}});
    const complete=await journal.command({kind:"record",activityId:id,ref:{id:`${operationId}:http-complete`,revision:"1"}});
    const content=await retainProtocolContent(journal,`${identity}:disposition`,id,Buffer.from(JSON.stringify({
      local:"cancelled",remote:complete?"response_retained":dispatched?"unknown":"not_dispatched",remoteCancellation:"unavailable"})));
    const record:ProtocolJournalRecord={ref:{id:identity,revision:"1"},activityId:id,operationId,kind:"owner_checkpoint",content,source:null,
      dependencies:complete?[{id:`${operationId}:http-complete`,revision:"1"}]:dispatched?[{id:`${operationId}:dispatch`,revision:"1"}]:[]};
    const existing=await journal.command({kind:"record",activityId:id,ref:record.ref});
    if(existing){
      if(digest(existing)!==digest(record))throw new TypeError("chat_cancellation_disposition_conflict");
    }else await this.record(state,record,true);
    return null;
  }
  async close():Promise<void>{if(this.observing.size)throw new TypeError("chat_observation_still_active");}
  async deliveryResolution(state:ProtocolExecutionState):Promise<HelarcNativeDeliveryResolution|null>{
    const value=await readHelarcNativeDischarge(this.store,state);if(!value)return null;
    const protocol=state.activity.composition.composition.protocol.id;
    if(value.kind!=="chat_dependency_discharge"||value.protocol!==protocol||!["ollama.chat","deepseek.chat-completions"].includes(protocol))
      throw new TypeError("chat_delivery_resolution_original_changed");
    return {basis:state.retentionBasis!,resolved:value.disposition==="response_retained"||value.disposition==="not_dispatched"};
  }
  async settleInputUse(state:ProtocolExecutionState):Promise<HelarcNativeDeliveryResolution|null>{
    const resolution=await this.deliveryResolution(state);
    if(resolution)await settleHelarcNativeInputUse(this.store,state,resolution);
    return resolution;
  }
  async retire(state:ProtocolExecutionState):Promise<boolean>{
    const id=state.activity.scope.activityId;
    if(this.observing.has(id)||!state.accepted&&!state.cancelled)return false;
    const request=JSON.parse((await readProtocolContent(this.store.protocolJournal,state.input,id,32*1024*1024)).toString()) as BoundRequest;
    const t=request.chatTransport,c=state.activity.composition.composition.configuration;
    if(!t||t.protocol!==c.protocol.id||t.connection.bindingId!==c.connectionBinding.id||t.connection.pinId!==`${id}:connection`)
      throw new TypeError("chat_retirement_original_changed");
    const operationId=request.format==="helarc.native-prepared-task.v1"?request.binding.operationId:request.operationId;
    const dispatch=await this.store.protocolJournal.command({kind:"record",activityId:id,ref:{id:`${operationId}:dispatch`,revision:"1"}}) as ProtocolJournalRecord|null;
    const complete=await this.store.protocolJournal.command({kind:"record",activityId:id,ref:{id:`${operationId}:http-complete`,revision:"1"}}) as ProtocolJournalRecord|null;
    if(!complete&&!state.cancelled)return false;
    return releaseHelarcNativeRetention(this.store,state,{operationId,dependencies:[...dispatch?[dispatch.ref]:[],...complete?[complete.ref]:[]],
      value:{kind:"chat_dependency_discharge",protocol:t.protocol,originalInput:state.input,
        disposition:complete?"response_retained":dispatch?"remote_outcome_unknown":"not_dispatched",networkContinuation:"unavailable",history:"retained"}});
  }
  private async observeOriginal(state:ProtocolExecutionState,request:Request,signal:AbortSignal,authorize:()=>Promise<void>,preview?:HelarcNativePreviewObserver){
    const {protocolJournal:journal}=this.store,id=state.activity.scope.activityId;
    const original=JSON.parse((await readProtocolContent(journal,state.input,id,32*1024*1024)).toString()) as BoundRequest;
    if(digest(original)!==digest(request)||!original.chatTransport)throw new TypeError("chat_purpose_original_transport_changed");
    const t=original.chatTransport,c=state.activity.composition.composition.configuration;
    if(t.protocol!==c.protocol.id||!Number.isSafeInteger(t.deadlineAt)||!Number.isSafeInteger(t.maximumBytes)||t.maximumBytes<1||t.maximumBytes>32*1024*1024)
      throw new TypeError("chat_purpose_original_transport_changed");
    if(t.connection.bindingId!==c.connectionBinding.id||t.connection.pinId!==`${id}:connection`||t.connection.acceptanceId!==`${id}:prepare`)
      throw new TypeError("chat_purpose_original_configuration_changed");
    const task=request.format==="helarc.native-prepared-task.v1",observation=task?request.binding.record:request.observation;
    const operationId=task?request.binding.operationId:request.operationId;
    const saved=await journal.command({kind:"record",activityId:id,ref:observation}) as ProtocolJournalRecord|null;
    if(saved&&await hasHelarcNativeUsage(this.store,saved))return saved;
    const dispatchRef={id:`${operationId}:dispatch`,revision:"1"},httpRef={id:`${operationId}:http-complete`,revision:"1"};
    const complete=await journal.command({kind:"record",activityId:id,ref:httpRef}) as ProtocolJournalRecord|null;
    let http:NativeHttpObservation;
    if(complete){
      http=JSON.parse((await readProtocolContent(journal,complete.content,id,96*1024*1024)).toString()) as NativeHttpObservation;
    }else{
      const intent=await journal.command({kind:"record",activityId:id,ref:dispatchRef}) as ProtocolJournalRecord|null;
      if(intent){
        await registerHelarcNativeUsage(this.store,state,intent,{operationId,endpoint:t.endpoint??null,submittedAt:null});
        throw new TypeError("chat_original_creation_unresolved");
      }
      signal.throwIfAborted();
      const remaining=t.deadlineAt-Date.now();
      if(remaining<=0)throw new TypeError("chat_original_deadline_elapsed");
      const configuration=await this.retention.recover(t.connection);
      if(configuration.id!==c.configuration.id||configuration.revision!==c.configuration.revision||configuration.model!==c.model||
        configuration.protocol!==t.protocol||configuration.connectionBindingId!==c.connectionBinding.id)throw new TypeError("chat_purpose_original_configuration_changed");
      const bounded=AbortSignal.any([signal,AbortSignal.timeout(Math.min(remaining,2_147_483_647))]);
      http=await this.providers.withConnection(t.connection.bindingId,async(actual,key)=>{
        if(actual.id!==configuration.id||actual.revision!==configuration.revision||actual.connectionBindingId!==configuration.connectionBindingId)
          throw new TypeError("chat_purpose_original_configuration_changed");
        await authorize();bounded.throwIfAborted();
        const current=await journal.command({kind:"state",activityId:id}) as ProtocolExecutionState|null;
        if(!current||current.cancelled||digest(current.fence)!==digest(state.fence))throw new TypeError("chat_purpose_current_control_changed");
        const dispatch:ProtocolJournalRecord={ref:dispatchRef,activityId:id,operationId,kind:"dispatch_intent",content:state.input,source:null,dependencies:[]};
        await this.record(state,dispatch,true);
        await registerHelarcNativeUsage(this.store,state,dispatch,{operationId,endpoint:t.endpoint??null,submittedAt:null});
        const wire={body:JSON.parse(request.wire.body),encoded:request.wire.body,digest:request.wire.digest};
        // Each raw chunk is retained before parsing or display; no accumulated-body rewrite per delta.
        const options={signal:bounded,maximumBytes:t.maximumBytes,retainChunk:async(bytes:Uint8Array,offset:number)=>{
          const content=await retainProtocolContent(journal,`${operationId}:chunk:${offset}`,id,Buffer.from(bytes));
          await this.record(state,{ref:{id:`${operationId}:chunk:${offset}`,revision:"1"},activityId:id,operationId,kind:"observation",
            content,source:null,dependencies:[dispatchRef]},false);
        },observeFrame:task&&preview?(frame:{event:string;data:string})=>{
          try{const value=JSON.parse(frame.data);if(value&&typeof value==="object")preview({binding:request.binding,sequence:sequence++,value});}catch{/* Framing evidence remains retained. */}
        }:undefined};
        let sequence=0;
        // Dispatch only uses the frozen native body. Catalog/schema were accepted by their purpose owner.
        return t.protocol==="ollama.chat"?dispatchOllamaChat(wire,{baseUrl:actual.baseUrl},options):
          dispatchDeepSeekChat(wire,{baseUrl:actual.baseUrl,apiKey:key??""},options);
      });
      const content=await retainProtocolContent(journal,`${operationId}:http-complete`,id,Buffer.from(JSON.stringify(http)));
      await this.record(state,{ref:httpRef,activityId:id,operationId,kind:"observation",content,source:null,dependencies:[dispatchRef]},false);
    }
    // Parsing is replayable from original HTTP evidence, even when the current key is unavailable.
    let refusal:Record<string,unknown>|null=null;
    if(http.status===400){
      try{const value=JSON.parse(http.body);if((t.protocol==="ollama.chat"?ollamaInputCapacityRefused:deepSeekInputCapacityRefused)(value))refusal=value;}
      catch{/* Invalid diagnostics cannot prove a capacity refusal. */}
    }
    const value=saved?JSON.parse((await readProtocolContent(journal,saved.content,id,32*1024*1024)).toString()):refusal??
      (t.protocol==="ollama.chat"?readOllamaChatObservation(http):readDeepSeekObservation(http));
    const content=await retainProtocolContent(journal,`${operationId}:observation`,id,Buffer.from(JSON.stringify(value)));
    const record:ProtocolJournalRecord={ref:observation,activityId:id,operationId,kind:"observation",content,
      source:{scope:state.activity.scope,protocol:state.activity.composition.composition.protocol,
        interpretation:state.activity.composition.composition.adapter.implementation,operationId,record:observation,
        position:{format:"json-pointer",value:""},nativeIdentity:typeof value.id==="string"?{kind:"completion",id:value.id}:null},dependencies:[dispatchRef,httpRef]};
    if(saved&&digest(saved)!==digest(record))throw new TypeError("chat_usage_original_observation_changed");
    if(!saved)await this.record(state,record,false);
    await recordHelarcNativeUsage(this.store,state,record,{operationId,response:value,endpoint:t.endpoint??null,
      submittedAt:http.work.startedAt??null,receivedAt:http.work.completedAt??null,channel:JSON.parse(request.wire.body).stream?"stream":"create"});
    return record;
  }
  private async record(state:ProtocolExecutionState,record:ProtocolJournalRecord,fenced:boolean){
    const receipt=await this.store.sharedAcceptance.accept({id:`${record.ref.id}:retain`,scope:state.activity.scope.runId,
      actor:state.activity.composition.composition.adapter.implementation.id,
      parts:[{owner:"protocol_execution",kind:"record",proposal:{fence:fenced?state.fence:null,record}}]});
    if(receipt.outcome!=="accepted")throw new TypeError(`chat_observation_retention_rejected:${receipt.rejection?.code}`);
  }
}
