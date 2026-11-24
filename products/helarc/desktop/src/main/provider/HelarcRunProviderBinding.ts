import {snapshotProviderFailure,type Provider} from "@agent-anything/model-interaction";
import {RemoteInputMeasurementNotDispatchedError} from "@agent-anything/model-interaction/input";
import type {ProviderObserver} from "@agent-anything/model-interaction/transport";
import type {HelarcLegacyExecutionAdmission as HelarcExecutionAdmission} from "../execution-storage/HelarcExecutionAdmission.js";
import type {ProviderCredentialStore} from "./ProviderCredentialStore.js";
import {restoreHelarcProvider} from "./restoreHelarcProvider.js";
import {validHelarcRunCredentialBinding} from "./HelarcRunCredentialBinding.js";
import {ProviderConfigurationError} from "../../shared/ProviderConfiguration.js";
import type {ProviderConfigurationService} from "./ProviderConfigurationService.js";
export type {HelarcRunCredentialBinding} from "./HelarcRunCredentialBinding.js";

/** Restore local contracts first; credentials are a dispatch dependency, not a read dependency. */
export function bindHelarcRunProvider(
  saved:Pick<HelarcExecutionAdmission,"providerProfile"|"providerBinding"|"providerCredential">,
  credentials:Pick<ProviderCredentialStore,"resolveApiKey">,
  observer?:ProviderObserver,
  environment:Readonly<Record<string,string|undefined>>=process.env,
  connections?:ProviderConfigurationService,
):Provider {
  if(!validHelarcRunCredentialBinding(saved.providerCredential,saved.providerProfile.id))throw new TypeError("provider_credential_binding_invalid");
  const local=restoreHelarcProvider(saved,"",observer);
  return Object.freeze({
    descriptor:local.descriptor,modelContext:local.modelContext,requestBodyTransportLimit:local.requestBodyTransportLimit,
    ...(local.inputTargetDigest?{inputTargetDigest:local.inputTargetDigest}:{}),
    ...(local.encodeInput?{encodeInput:local.encodeInput.bind(local)}:{}),
    ...(local.verifyEncodedInput?{verifyEncodedInput:local.verifyEncodedInput.bind(local)}:{}),
    ...(local.inputMeasurement?{inputMeasurement:{revision:local.inputMeasurement.revision,
      prepare:local.inputMeasurement.prepare.bind(local.inputMeasurement),
      interpret:local.inputMeasurement.interpret.bind(local.inputMeasurement),
      async send(request:Parameters<NonNullable<Provider["inputMeasurement"]>["send"]>[0],signal:AbortSignal) {
        signal.throwIfAborted();
        try {return await dispatch(async provider=>{
          signal.throwIfAborted();
          if(!provider.inputMeasurement)throw new TypeError("provider_measurement_binding_unavailable");
          return provider.inputMeasurement.send(request,signal);
        });}
        catch(error) {
          if(!(error instanceof HelarcRunCredentialError))throw error;
          throw new RemoteInputMeasurementNotDispatchedError(error.code,"original_credential");
        }
      }}}:{}),
    async send(request,context,delivery) {
      context.signal.throwIfAborted();
      try {return await dispatch(async provider=>{
        context.signal.throwIfAborted();return provider.send(request,context,delivery);
      });}
      catch(error) {
        if(!(error instanceof HelarcRunCredentialError))throw error;
        return {kind:"failed",failure:snapshotProviderFailure({category:"configuration",code:error.code,message:error.message,
          requestId:request.requestId,metadata:{transportDispatched:false,dependency:"original_credential"}})};
      }
    },
  });
  async function dispatch<T>(work:(provider:Provider)=>Promise<T>):Promise<T> {
    const binding=saved.providerCredential;
    if(binding.kind!=="connection")return work(await resolve());
    if(!connections)throw new HelarcRunCredentialError("provider_connection_custody_unavailable");
    try {
      const pin=await connections.readPin(binding.pinId);
      if(!pin||pin.state!=="confirmed"||pin.bindingId!==binding.bindingId||pin.acceptanceId!==binding.acceptanceId)
        throw new HelarcRunCredentialError("provider_connection_acceptance_mismatch");
      return await connections.withConnection(binding.bindingId,async(configuration,key)=>{
        if(configuration.id!==saved.providerProfile.id||configuration.revision!==saved.providerProfile.revision)
          throw new HelarcRunCredentialError("provider_connection_configuration_mismatch");
        return work(key?restoreHelarcProvider(saved,key,observer):local);
      });
    }catch(error){if(error instanceof ProviderConfigurationError)throw new HelarcRunCredentialError(error.code);throw error;}
  }
  async function resolve():Promise<Provider> {
    const binding=saved.providerCredential;
    let key="";
    if(binding.kind==="saved") {
      const result=await credentials.resolveApiKey(binding.ref);
      if(!result.ok || !result.apiKey)throw new HelarcRunCredentialError(result.ok?"provider_credential_missing":result.error.code);
      key=result.apiKey;
    } else if(binding.kind==="environment") {
      key=environment[binding.name]??"";
      if(!key.trim())throw new HelarcRunCredentialError("provider_credential_missing");
    }
    return key?restoreHelarcProvider(saved,key,observer):local;
  }
}

export class HelarcRunCredentialError extends Error {
  constructor(readonly code:string) {
    super("The original execution credential is unavailable; local recovery remains available.");
    this.name="HelarcRunCredentialError";
  }
}
