import {modelInputValueDigest as digest} from "@agent-anything/model-interaction/input";
import {measureIdentifiedWork,measuredFetch,protocolWork} from "../diagnostics/IdentifiedWorkTiming.js";
import {readProtocolContent,type ProtocolModelActivity,type ProtocolExecutionState} from "@agent-anything/agent-runtime/model-access";
import {validateHelarcResponsesCompactRequest,type HelarcResponsesCompactRequest,type HelarcResponsesCompactSource} from "@agent-anything/helarc/controller";
import type {ResponsesCompactSession} from "@agent-anything/provider-integrations/native";
import type {HelarcExecutionStore} from "../execution-storage/HelarcExecutionStore.js";
import type {ProviderConfiguration} from "../../shared/ProviderConfiguration.js";
import type {ProviderConfigurationService} from "./ProviderConfigurationService.js";
import {ProviderConnectionRetention,type RetainedConnection} from "./ProviderConnectionRetention.js";
import {HelarcResponsesTransport,helarcResponsesCompactBinding} from "./HelarcResponsesTransport.js";

export interface HelarcConnectedCompactRequest extends HelarcResponsesCompactRequest {
  readonly connection:RetainedConnection;
}
/** Original connection custody only; execution and semantic assessment remain separate. */
export class HelarcResponsesCompactConnection {
  private readonly retention:ProviderConnectionRetention;
  constructor(private readonly store:Pick<HelarcExecutionStore,"protocolJournal"|"sharedAcceptance">&Partial<Pick<HelarcExecutionStore,"generation"|"workTiming">>,
    private readonly providers:ProviderConfigurationService){
    this.retention=new ProviderConnectionRetention(providers,{read:async pin=>
      (await store.sharedAcceptance.query(pin.acceptanceId))?.outcome==="accepted"?"accepted":"unknown"});
  }
  async prepare(input:{readonly activity:ProtocolModelActivity;readonly source:HelarcResponsesCompactSource;
    readonly configuration:ProviderConfiguration;readonly startedAt:number;readonly maximumBytes:number}):Promise<HelarcConnectedCompactRequest>{
    const {activity,source,configuration}=input,id=activity.scope.activityId;
    this.checkConfiguration(activity,configuration);
    const state=await this.store.protocolJournal.command({kind:"state",activityId:id}) as ProtocolExecutionState|null;
    if(state){
      const original=JSON.parse((await readProtocolContent(this.store.protocolJournal,state.input,id,32*1024*1024)).toString()) as HelarcConnectedCompactRequest;
      validateHelarcResponsesCompactRequest(original);
      if(digest(original.activity)!==digest(activity)||digest(original.source)!==digest(source))throw new TypeError("responses_compact_original_preparation_changed");
      this.checkOriginal(original);
      return original;
    }
    const pin={id:`${id}:connection`,bindingId:configuration.connectionBindingId,acceptanceId:`${id}:prepare`,
      owner:activity.composition.composition.adapter.implementation.id,purpose:activity.scope.purpose.id,state:"provisional" as const};
    const request:HelarcConnectedCompactRequest={format:"helarc.responses-compact-request.v1",activity,source,
      binding:helarcResponsesCompactBinding({configuration,prepared:source.methodRequest,id:`${id}:compact`,sourceDigest:source.sourceDigest,
        disclosure:source.dependencies.authority,startedAt:input.startedAt,maximumBytes:input.maximumBytes}),
      connection:{kind:"connection",bindingId:pin.bindingId,pinId:pin.id,acceptanceId:pin.acceptanceId}};
    validateHelarcResponsesCompactRequest(request);
    await this.store.protocolJournal.command({kind:"reserve_admission",activity});
    await this.providers.pin(pin);
    return request;
  }
  checkOriginal(request:HelarcResponsesCompactRequest):void{
    validateHelarcResponsesCompactRequest(request);
    const r=request as HelarcConnectedCompactRequest,id=r.activity.scope.activityId,c=r.connection;
    if(!c||c.kind!=="connection"||c.pinId!==`${id}:connection`||c.acceptanceId!==`${id}:prepare`||
      c.bindingId!==r.activity.composition.composition.configuration.connectionBinding.id)
      throw new TypeError("responses_compact_connection_changed");
    const configuration=r.activity.composition.composition.configuration;
    if(r.binding.target!==digest({configuration:configuration.configuration.id,revision:configuration.configuration.revision,
      connection:configuration.connectionBinding.id,protocol:configuration.protocol.id,model:configuration.model}))
      throw new TypeError("responses_compact_original_target_changed");
  }
  async check(request:HelarcResponsesCompactRequest):Promise<void>{
    this.checkOriginal(request);
    const r=request as HelarcConnectedCompactRequest,id=r.activity.scope.activityId,c=r.connection;
    const pin=await this.providers.readPin(c.pinId);
    if(!pin||pin.bindingId!==c.bindingId||pin.acceptanceId!==c.acceptanceId||pin.state==="released"||
      pin.owner!==r.activity.composition.composition.adapter.implementation.id||pin.purpose!==r.activity.scope.purpose.id)
      throw new TypeError("responses_compact_original_pin_changed");
    const state=await this.store.protocolJournal.command({kind:"state",activityId:id}) as ProtocolExecutionState|null;
    const configuration=state?await this.retention.recover(c):(await this.providers.binding(c.bindingId)).configuration;
    this.checkConfiguration(r.activity,configuration);
    const original=helarcResponsesCompactBinding({configuration,prepared:r.source.methodRequest,id:r.binding.id,sourceDigest:r.source.sourceDigest,
      disclosure:r.source.dependencies.authority,startedAt:r.binding.startedAt,maximumBytes:r.binding.maximumBytes});
    if(digest(original)!==digest(r.binding))throw new TypeError("responses_compact_original_transport_changed");
  }
  async dispatch(request:HelarcResponsesCompactRequest,session:ResponsesCompactSession,signal:AbortSignal,authorize:()=>Promise<boolean>){
    const work=protocolWork(request.activity.scope.runId,request.activity.scope.activityId);
    await measureIdentifiedWork(this.store,{work,phase:"validate_compact"},()=>this.check(request));
    if(digest(request.binding)!==digest(session.binding))throw new TypeError("responses_compact_original_session_changed");
    const connection=(request as HelarcConnectedCompactRequest).connection;
    const carrier=new HelarcResponsesTransport(this.providers,connection);
    try{return await measureIdentifiedWork(this.store,{work,phase:"compact_transport"},()=>carrier.compact(session,signal,authorize,
      measuredFetch(this.store,work,session.binding.id)));}
    finally{await measureIdentifiedWork(this.store,{work,phase:"carrier_cleanup"},()=>carrier.close());}
  }
  private checkConfiguration(activity:ProtocolModelActivity,configuration:ProviderConfiguration){
    const c=activity.composition.composition.configuration;
    if(configuration.protocol!=="openai.responses"||c.configuration.id!==configuration.id||c.configuration.revision!==configuration.revision||
      c.connectionBinding.id!==configuration.connectionBindingId||c.model!==configuration.model)
      throw new TypeError("responses_compact_original_configuration_changed");
  }
}
