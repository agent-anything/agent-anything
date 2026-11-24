import {type Provider} from "@agent-anything/model-interaction";
import {OpenAICompatibleProvider} from "@agent-anything/provider-integrations/openai-compatible";

/** Legacy Chat fixtures use the native encoder; only transport responses are scripted. */
export function bindFixtureProviderEncoding<T extends Provider>(provider: T): T {
  if (provider.encodeInput && provider.verifyEncodedInput) return provider;
  if (provider.encodeInput || provider.verifyEncodedInput) throw new Error("Incomplete fixture encoding capability");
  const encoder=new OpenAICompatibleProvider({baseUrl:"https://fixture.invalid/v1",apiKey:"",
    model:provider.modelContext.target.model,timeoutMs:30000,nativeToolInteraction:{supported:true},
    requestBodyTransportLimit:provider.requestBodyTransportLimit});
  if(provider.descriptor.id!==encoder.descriptor.id||provider.modelContext.target.providerId!==encoder.descriptor.id)
    throw new Error("Fixture identity must match its native encoder");
  const encodeInput:NonNullable<Provider["encodeInput"]>=(request,mode)=>encoder.encodeInput(request,mode);
  const verifyEncodedInput:NonNullable<Provider["verifyEncodedInput"]>=(request,encoded)=>encoder.verifyEncodedInput(request,encoded);
  const original = provider.send.bind(provider);
  const send: Provider["send"] = (request, context, options) => {
    if (!options?.encodedInput || options.encodedInput.mode !== options.mode) throw new Error("Fixture prepared input missing");
    verifyEncodedInput(request, options.encodedInput);
    return original(request, context, options);
  };
  return Object.assign(provider, {encodeInput, verifyEncodedInput, inputTargetDigest:encoder.inputTargetDigest,send});
}
