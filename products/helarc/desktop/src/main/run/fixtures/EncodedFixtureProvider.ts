import {snapshotProviderRequest, type Provider, type ProviderRequest} from "@agent-anything/model-interaction";
import {createEncodedModelInput, modelInputValueDigest, verifyEncodedModelInput} from "@agent-anything/model-interaction/input";

/** The scripted transport consumes the complete JSON request, with no HTTP credentials. */
export function bindFixtureProviderEncoding<T extends Provider>(provider: T): T {
  if (provider.encodeInput && provider.verifyEncodedInput) return provider;
  if (provider.encodeInput || provider.verifyEncodedInput) throw new Error("Incomplete fixture encoding capability");
  const target = structuredClone(provider.modelContext.target);
  const adapterRevision = "helarc.scripted-provider.v1", endpoint = "https://fixture.invalid/scripted-request";
  // Local capacity assessment is attached after encoding; it is not Provider input.
  const semantic = (request: ProviderRequest) => snapshotProviderRequest({...request,
    modelContext: {...request.modelContext, assessment: null}});
  const encodeInput: NonNullable<Provider["encodeInput"]> = (request, mode) => createEncodedModelInput({
    request, target, adapterRevision, endpoint, mode, body: JSON.stringify(semantic(request)),
  });
  const verifyEncodedInput: NonNullable<Provider["verifyEncodedInput"]> = (request, encoded) => {
    verifyEncodedModelInput(encoded, {request, target, adapterRevision, endpoint, mode: encoded.mode});
    if (modelInputValueDigest(JSON.parse(encoded.body)) !== modelInputValueDigest(semantic(request))) {
      throw new Error("Fixture encoded request changed");
    }
  };
  const original = provider.send.bind(provider);
  const send: Provider["send"] = (request, context, options) => {
    if (!options?.encodedInput || options.encodedInput.mode !== options.mode) throw new Error("Fixture prepared input missing");
    verifyEncodedInput(request, options.encodedInput);
    return original(request, context, options);
  };
  return Object.assign(provider, {encodeInput, verifyEncodedInput, send});
}
