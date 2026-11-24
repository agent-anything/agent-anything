import {defaultHelarcInRequestCompactionPolicy,snapshotHelarcInRequestCompactionPolicy} from "@agent-anything/helarc/configuration";
import {MODEL_INTERACTION_PROTOCOLS,ProviderConfigurationError,defaultProviderDraft as emptyDraft,providerCapacityTarget,providerCompactionTarget,providerDestination,providerRecord,providerToken,type ProviderConfigurationDraft,type ProviderProtocolId} from "../../shared/ProviderConfiguration.js";
import type {ProviderCompactionPolicy} from "../../shared/ProviderCompactionPolicy.js";

export function snapshotProviderDraft(value: unknown): ProviderConfigurationDraft {
  const capacityPresent=Boolean(value&&typeof value==="object"&&Object.hasOwn(value,"capacityDeclaration"));
  const compactionPresent=Boolean(value&&typeof value==="object"&&Object.hasOwn(value,"inRequestCompaction"));
  providerRecord(value, ["protocol", "name", "baseUrl", "model", "generationLifetimeMs", "native", "observation",...(capacityPresent?["capacityDeclaration"]:[]),...(compactionPresent?["inRequestCompaction"]:[])]);
  if (typeof value.protocol !== "string" || !Object.hasOwn(MODEL_INTERACTION_PROTOCOLS, value.protocol)) throw new ProviderConfigurationError("provider_protocol_invalid");
  const protocol = value.protocol as ProviderProtocolId;
  const name = providerToken(value.name);
  if (typeof value.model !== "string" || value.model.length > 512 || /[\u0000-\u001f\u007f]/u.test(value.model)) throw new ProviderConfigurationError("provider_model_invalid");
  if (typeof value.baseUrl !== "string" || value.baseUrl.length > 2048) throw new ProviderConfigurationError("provider_destination_invalid");
  positive(value.generationLifetimeMs, 2_147_483_647);
  const observation = value.observation;
  providerRecord(observation, ["revision", "connectMs", "readMs", "silenceMs", "pollMinimumMs", "pollMaximumMs", "failureRetries", "failureEpisodeMs"]);
  if (observation.revision !== "helarc.provider-observation.v1") throw new ProviderConfigurationError("provider_observation_policy_invalid");
  for (const key of ["connectMs", "readMs", "silenceMs", "pollMinimumMs", "pollMaximumMs", "failureEpisodeMs"] as const) positive(observation[key], 86_400_000);
  if (!Number.isSafeInteger(observation.failureRetries) || (observation.failureRetries as number) < 0 || (observation.failureRetries as number) > 10)
    throw new ProviderConfigurationError("provider_numeric_policy_invalid");
  if ((observation.pollMinimumMs as number) > (observation.pollMaximumMs as number)) throw new ProviderConfigurationError("provider_observation_policy_invalid");
  const native = value.native;
  if (protocol === "ollama.chat") {
    providerRecord(native, ["protocol", "contextWindowTokens", "think"]);
    positive(native.contextWindowTokens, 100_000_000);
    if (typeof native.think !== "string" || !["default", "disabled", "enabled"].includes(native.think)) throw new ProviderConfigurationError("provider_thinking_invalid");
  } else if (protocol === "deepseek.chat-completions") {
    providerRecord(native, ["protocol", "thinking"]);
    if (typeof native.thinking !== "string" || !["default", "disabled", "enabled"].includes(native.thinking)) throw new ProviderConfigurationError("provider_thinking_invalid");
  } else {
    providerRecord(native, ["protocol", "organization", "project", "transport", "background", "stream", "continuity", "store",
      "allowTemporaryRetention", "allowConnectionMemory", "allowInRequestCompaction", "reasoningEffort"]);
    for (const key of ["organization", "project", "reasoningEffort"]) if (native[key] !== null) providerToken(native[key]);
    for (const key of ["background", "stream", "store", "allowTemporaryRetention", "allowConnectionMemory", "allowInRequestCompaction"])
      if (typeof native[key] !== "boolean") throw new ProviderConfigurationError("provider_native_choices_invalid");
    if (typeof native.transport !== "string" || !["http", "websocket"].includes(native.transport) ||
        typeof native.continuity !== "string" || !["replay", "stored-response", "connection-memory"].includes(native.continuity))
      throw new ProviderConfigurationError("provider_native_choices_invalid");
    if ((native.continuity === "stored-response" && !native.store) ||
        (native.background && (native.transport !== "http" || !native.allowTemporaryRetention)) ||
        (native.continuity === "connection-memory" && (native.transport !== "websocket" || !native.allowConnectionMemory)))
      throw new ProviderConfigurationError("provider_native_retention_not_authorized");
  }
  if (native.protocol !== protocol) throw new ProviderConfigurationError("provider_protocol_mismatch");
  if(compactionPresent){
    const policy=reviewPolicy(value.inRequestCompaction);
    if(policy.target!==providerCompactionTarget(value as unknown as ProviderConfigurationDraft))throw new ProviderConfigurationError("provider_compaction_target_changed");
    if(protocol!=="openai.responses"&&policy.support!=="excluded")throw new ProviderConfigurationError("provider_compaction_protocol_unsupported");
  }
  if(capacityPresent){
    const declaration=value.capacityDeclaration;
    providerRecord(declaration,["target","sharedTokens","basis","validUntil"]);
    positive(declaration.sharedTokens,100_000_000);providerToken(declaration.basis);
    if(protocol==="ollama.chat"||!value.model.trim()||declaration.target!==providerCapacityTarget(value as unknown as ProviderConfigurationDraft)||
      declaration.validUntil!==null&&(typeof declaration.validUntil!=="string"||!Number.isFinite(Date.parse(declaration.validUntil))||
        new Date(declaration.validUntil).toISOString()!==declaration.validUntil))throw new ProviderConfigurationError("provider_capacity_declaration_invalid");
  }
  return structuredClone({ ...value, protocol, name, model: value.model.trim(), baseUrl: providerDestination(value.baseUrl, protocol).baseUrl }) as unknown as ProviderConfigurationDraft;
}
export function defaultProviderCompactionPolicy(value:Pick<ProviderConfigurationDraft,"protocol"|"baseUrl"|"model"|"native">):ProviderCompactionPolicy{
  return defaultHelarcInRequestCompactionPolicy({protocol:value.protocol,model:value.model,target:providerCompactionTarget(value),
    officialEndpoint:providerDestination(value.baseUrl,value.protocol).baseUrl==="https://api.openai.com/v1"});
}
function positive(value: unknown, maximum: number): void {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maximum) throw new ProviderConfigurationError("provider_numeric_policy_invalid");
}

function reviewPolicy(value:unknown):ProviderCompactionPolicy {
  try{return snapshotHelarcInRequestCompactionPolicy(value);}
  catch(error){if(error instanceof TypeError&&error.message.startsWith("in_request_compaction_"))throw new ProviderConfigurationError(error.message);throw error;}
}
export function defaultProviderDraft(protocol:ProviderProtocolId,model=""):ProviderConfigurationDraft {
  const draft={...emptyDraft(protocol),model};
  return model.trim()?{...draft,inRequestCompaction:defaultProviderCompactionPolicy(draft)}:draft;
}

/** Read-only preview: identical validation to save, without registry or credential access. */
export function previewProviderPolicy(input:{draft:ProviderConfigurationDraft}):ProviderCompactionPolicy {
  providerRecord(input,["draft"]);
  const draft=snapshotProviderDraft(input.draft);
  return draft.inRequestCompaction??defaultProviderCompactionPolicy(draft);
}
