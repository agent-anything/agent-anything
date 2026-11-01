import {snapshotProviderFailure,type Provider} from "@agent-anything/model-interaction";
import {RemoteInputMeasurementNotDispatchedError} from "@agent-anything/model-interaction/input";
import type {ProviderObserver} from "@agent-anything/model-interaction/transport";
import type {HelarcExecutionAdmission} from "../execution-storage/HelarcExecutionAdmission.js";
import type {ProviderCredentialStore} from "./ProviderCredentialStore.js";
import {restoreHelarcProvider} from "./restoreHelarcProvider.js";
import {validHelarcRunCredentialBinding} from "./HelarcRunCredentialBinding.js";
export type {HelarcRunCredentialBinding} from "./HelarcRunCredentialBinding.js";

/** Restore local contracts first; credentials are a dispatch dependency, not a read dependency. */
export function bindHelarcRunProvider(
  saved:Pick<HelarcExecutionAdmission,"providerProfile"|"providerBinding"|"providerCredential">,
  credentials:Pick<ProviderCredentialStore,"resolveApiKey">,
  observer?:ProviderObserver,
  environment:Readonly<Record<string,string|undefined>>=process.env,
):Provider {
  if(!validHelarcRunCredentialBinding(saved.providerCredential,saved.providerProfile.id))throw new TypeError("provider_credential_binding_invalid");
  const local=restoreHelarcProvider(saved,"",observer);
  return Object.freeze({
    descriptor:local.descriptor,modelContext:local.modelContext,requestBodyTransportLimit:local.requestBodyTransportLimit,
    ...(local.encodeInput?{encodeInput:local.encodeInput.bind(local)}:{}),
    ...(local.verifyEncodedInput?{verifyEncodedInput:local.verifyEncodedInput.bind(local)}:{}),
    ...(local.inputMeasurement?{inputMeasurement:{revision:local.inputMeasurement.revision,
      prepare:local.inputMeasurement.prepare.bind(local.inputMeasurement),
      interpret:local.inputMeasurement.interpret.bind(local.inputMeasurement),
      async send(request:Parameters<NonNullable<Provider["inputMeasurement"]>["send"]>[0],signal:AbortSignal) {
        signal.throwIfAborted();
        let provider:Provider;
        try {provider=await resolve();}
        catch(error) {
          if(!(error instanceof HelarcRunCredentialError))throw error;
          throw new RemoteInputMeasurementNotDispatchedError(error.code,"original_credential");
        }
        signal.throwIfAborted();
        if(!provider.inputMeasurement)throw new TypeError("provider_measurement_binding_unavailable");
        return provider.inputMeasurement.send(request,signal);
      }}}:{}),
    async send(request,context,delivery) {
      context.signal.throwIfAborted();
      let provider:Provider;
      try {provider=await resolve();}
      catch(error) {
        if(!(error instanceof HelarcRunCredentialError))throw error;
        return {kind:"failed",failure:snapshotProviderFailure({category:"configuration",code:error.code,message:error.message,
          requestId:request.requestId,metadata:{transportDispatched:false,dependency:"original_credential"}})};
      }
      context.signal.throwIfAborted();
      return provider.send(request,context,delivery);
    },
  });
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
