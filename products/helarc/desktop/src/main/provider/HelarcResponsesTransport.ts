import {ResponsesWebSocket,dispatchResponsesCompact,type ResponsesCompactSession,type ResponsesCompactBinding,type ResponsesSession,type ResponsesSessionBinding,type ResponsesPreparation} from "@agent-anything/provider-integrations/native";
import {modelInputValueDigest as digest} from "@agent-anything/model-interaction/input";
import {ProviderConfigurationError,type ProviderConfiguration} from "../../shared/ProviderConfiguration.js";
import type {ProviderConfigurationService} from "./ProviderConfigurationService.js";
import type {RetainedConnection} from "./ProviderConnectionRetention.js";
import {randomUUID} from "node:crypto";

export function helarcResponsesSessionBinding(input:{readonly configuration:ProviderConfiguration;readonly prepared:Pick<ResponsesPreparation,"body"|"encoded"|"digest">;
  readonly id:string;readonly scopeId:string;readonly connectionIncarnation:string|null;readonly createdAt:number;
  readonly arrangement?:{readonly transport:"http"|"websocket";readonly continuity:ResponsesSessionBinding["profile"]["continuity"]};
  readonly maximumBytes:number;readonly maximumFrameBytes:number;readonly maximumEvents:number}):ResponsesSessionBinding{
  const {configuration:c,prepared}=input,n=c.native;
  if(c.protocol!=="openai.responses"||n.protocol!=="openai.responses")throw new ProviderConfigurationError("responses_configuration_required");
  if(prepared.body.model!==c.model)throw new ProviderConfigurationError("responses_original_model_changed");
  if(prepared.body.context_management!==undefined&&!n.allowInRequestCompaction)throw new ProviderConfigurationError("responses_in_request_compaction_not_allowed");
  if(n.continuity==="connection-memory"&&!n.allowConnectionMemory)throw new ProviderConfigurationError("responses_connection_memory_not_authorized");
  const continuity=input.arrangement?.continuity??(n.continuity==="replay"?"native_replay":n.continuity==="stored-response"?"persistent_chain":"connection_memory");
  const transport=input.arrangement?.transport??n.transport;
  const store=prepared.body.store===true,background=prepared.body.background===true,stream=transport==="websocket"||prepared.body.stream===true;
  if(store&&!n.store||background&&!n.allowTemporaryRetention||continuity==="connection_memory"&&!n.allowConnectionMemory)
    throw new ProviderConfigurationError("responses_purpose_policy_not_authorized");
  const {revision:_,...policy}=c.observation;
  return {id:input.id,scopeId:input.scopeId,target:target(c),prepared:{body:prepared.body,encoded:prepared.encoded,digest:prepared.digest},
    profile:{transport,background,stream,store,temporaryRetention:n.allowTemporaryRetention,
      continuity,
      connectionIncarnation:input.connectionIncarnation},policy,createdAt:input.createdAt,deadlineAt:input.createdAt+c.generationLifetimeMs,
    maximumBytes:input.maximumBytes,maximumFrameBytes:input.maximumFrameBytes,maximumEvents:input.maximumEvents};
}

/** One scoped native carrier. Original custody is resolved at each operation, never from the current default. */
export class HelarcResponsesTransport {
  private socket:ResponsesWebSocket|undefined;
  readonly connectionIncarnation=randomUUID();
  constructor(private readonly service:Pick<ProviderConfigurationService,"readPin"|"withConnection">,private readonly connection:RetainedConnection){}
  async step(session:ResponsesSession,signal:AbortSignal,authorize:(operation:"create"|"retrieve"|"resume"|"cancel")=>Promise<void>,connection:RetainedConnection=this.connection,fetcher?:typeof fetch){
    if(connection.bindingId!==this.connection.bindingId)throw new ProviderConfigurationError("provider_connection_acceptance_mismatch");
    const pin=await this.service.readPin(connection.pinId);
    if(!pin||pin.state!=="confirmed"||pin.bindingId!==connection.bindingId||pin.acceptanceId!==connection.acceptanceId)
      throw new ProviderConfigurationError("provider_connection_acceptance_mismatch");
    return this.service.withConnection(connection.bindingId,async(c,key)=>{
      if(target(c)!==session.binding.target||c.native.protocol!=="openai.responses")throw new ProviderConfigurationError("responses_original_target_changed");
      const n=c.native,headers={"content-type":"application/json",...(key?{authorization:`Bearer ${key}`} :{}),
        ...(n.organization?{"OpenAI-Organization":n.organization}:{}),...(n.project?{"OpenAI-Project":n.project}:{})};
      if(session.binding.profile.transport==="websocket"&&session.snapshot().creation==="unsent"){
        if(session.binding.profile.connectionIncarnation!==this.connectionIncarnation)throw new ProviderConfigurationError("responses_connection_incarnation_lost");
        if(!this.socket)this.socket=new ResponsesWebSocket(session.binding.scopeId,this.connectionIncarnation,
          {baseUrl:c.baseUrl,headers},{connectMs:session.binding.policy.connectMs,maximumFrameBytes:session.binding.maximumFrameBytes,maximumBufferedBytes:session.binding.maximumFrameBytes*2});
      }
      return session.step({now:Date.now,jitter:Math.random,target:target(c),headers,baseUrl:c.baseUrl,signal,authorize,socket:this.socket,fetch:fetcher});
    });
  }
  async close():Promise<void>{await this.socket?.close();}
  async compact(session:ResponsesCompactSession,signal:AbortSignal,authorize:()=>Promise<boolean>,fetcher?:typeof fetch){
    const pin=await this.service.readPin(this.connection.pinId);
    if(!pin||pin.state!=="confirmed"||pin.bindingId!==this.connection.bindingId||pin.acceptanceId!==this.connection.acceptanceId)
      throw new ProviderConfigurationError("provider_connection_acceptance_mismatch");
    return this.service.withConnection(this.connection.bindingId,async(c,key)=>{
      if(target(c)!==session.binding.target||c.native.protocol!=="openai.responses"||session.binding.prepared.body.model!==c.model)
        throw new ProviderConfigurationError("responses_original_target_changed");
      const n=c.native,remaining=session.binding.deadlineAt-Date.now();
      if(remaining<=0)throw new ProviderConfigurationError("responses_compact_deadline_elapsed");
      const abort=AbortSignal.any([signal,AbortSignal.timeout(Math.min(remaining,2_147_483_647))]);
      return session.execute({now:Date.now(),authorize,dispatch:retainChunk=>dispatchResponsesCompact(session.binding.prepared,
        {baseUrl:c.baseUrl,apiKey:key??"",...(n.organization?{organization:n.organization}:{}),...(n.project?{project:n.project}:{})},
        {signal:abort,retainChunk,maximumBytes:session.binding.maximumBytes,fetch:fetcher})});
    });
  }
}
export function helarcResponsesCompactBinding(input:{readonly configuration:ProviderConfiguration;readonly prepared:ResponsesCompactBinding["prepared"];
  readonly id:string;readonly sourceDigest:string;readonly disclosure:string;readonly startedAt:number;readonly maximumBytes:number}):ResponsesCompactBinding{
  if(input.configuration.protocol!=="openai.responses"||input.prepared.body.model!==input.configuration.model)throw new ProviderConfigurationError("responses_original_model_changed");
  return {id:input.id,prepared:input.prepared,sourceDigest:input.sourceDigest,target:target(input.configuration),disclosure:input.disclosure,
    startedAt:input.startedAt,deadlineAt:input.startedAt+input.configuration.generationLifetimeMs,maximumBytes:input.maximumBytes};
}
function target(c:ProviderConfiguration):string{return digest({configuration:c.id,revision:c.revision,connection:c.connectionBindingId,protocol:c.protocol,model:c.model});}
