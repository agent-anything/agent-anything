import {modelInputValueDigest} from "@agent-anything/model-interaction/input";
import {snapshotHelarcProviderModelSettings,type HelarcProviderProfile,type HelarcProviderModelSettings} from "./HelarcProviderProfile.js";

export interface HelarcContextObservationTarget {
  readonly profileId:string;
  readonly providerKind:HelarcProviderProfile["providerKind"];
  readonly baseUrl:string;
  readonly model:string;
  readonly modelSettings:HelarcProviderModelSettings;
  readonly contextWindowTokens:number|null;
  readonly artifact:string|null;
}
export interface HelarcContextCapabilityObservation {
  readonly id:string;
  readonly revision:string;
  readonly target:HelarcContextObservationTarget;
  readonly duty:"generation"|"assessment";
  readonly method:{readonly id:string;readonly revision:string}|null;
  readonly protocol:string|null;
  readonly conclusion:"supported"|"limited"|"unknown"|"conflicting";
  readonly dimensions:readonly ("format_and_references"|"source_support"|"coverage"|"exact_values_and_unknowns"|"revision_and_relationships"|"misses_and_false_positives")[];
  readonly conditions:string;
  readonly finding:string;
  readonly source:string;
  readonly limitations:string;
  readonly observedAt:string;
}
export interface HelarcContextSettings {
  readonly autoRepresentation:boolean;
  readonly observations:readonly HelarcContextCapabilityObservation[];
}
export interface HelarcContextSettingsSnapshot {readonly revision:string;readonly settings:HelarcContextSettings;}
export function createDefaultHelarcContextSettings():HelarcContextSettings {return Object.freeze({autoRepresentation:true,observations:Object.freeze([])});}

export function snapshotHelarcContextSettings(value:unknown):HelarcContextSettings {
  const input=record(value,["autoRepresentation","observations"]);
  if(typeof input.autoRepresentation!=="boolean"||!Array.isArray(input.observations)||input.observations.length>256)throw new TypeError("context_settings_invalid");
  const ids=new Set<string>();
  const observations=input.observations.map(value=>{
    const item=record(value,["id","revision","target","duty","method","protocol","conclusion","dimensions","conditions","finding","source","limitations","observedAt"]);
    const id=text(item.id,256);if(ids.has(id))throw new TypeError("context_observation_duplicate");ids.add(id);
    const target=record(item.target,["profileId","providerKind","baseUrl","model","modelSettings","contextWindowTokens","artifact"]);
    if(target.providerKind!=="ollama"&&target.providerKind!=="openai-compatible")throw new TypeError("context_observation_provider_invalid");
    if(target.contextWindowTokens!==null&&(!Number.isSafeInteger(target.contextWindowTokens)||(target.contextWindowTokens as number)<1))throw new TypeError("context_observation_window_invalid");
    const url=new URL(text(target.baseUrl,2048));
    if(!["http:","https:"].includes(url.protocol)||url.username||url.password||url.search||url.hash)throw new TypeError("context_observation_endpoint_invalid");
    const method=item.method===null?null:record(item.method,["id","revision"]);
    if(!["generation","assessment"].includes(item.duty as string)||!["supported","limited","unknown","conflicting"].includes(item.conclusion as string)||
      !Array.isArray(item.dimensions)||new Set(item.dimensions).size!==item.dimensions.length||item.dimensions.some(d=>!DIMENSIONS.includes(d)))throw new TypeError("context_observation_invalid");
    const observedAt=text(item.observedAt,64);if(!Number.isFinite(Date.parse(observedAt)))throw new TypeError("context_observation_date_invalid");
    const body={id,target:{profileId:text(target.profileId,256),providerKind:target.providerKind,baseUrl:url.toString().replace(/\/$/,""),model:text(target.model,512),
      modelSettings:snapshotHelarcProviderModelSettings(target.modelSettings as HelarcProviderModelSettings,target.providerKind),contextWindowTokens:target.contextWindowTokens,artifact:nullableText(target.artifact,2048)},
      duty:item.duty,method:method?{id:text(method.id,256),revision:text(method.revision,256)}:null,protocol:nullableText(item.protocol,256),conclusion:item.conclusion,
      dimensions:[...item.dimensions],conditions:text(item.conditions,8192,true),finding:text(item.finding,8192),source:text(item.source,4096),limitations:text(item.limitations,8192,true),observedAt};
    return deepFreeze({...body,revision:modelInputValueDigest(body)}) as HelarcContextCapabilityObservation;
  });
  return Object.freeze({autoRepresentation:input.autoRepresentation,observations:Object.freeze(observations)});
}
export function contextSettingsSnapshot(value:unknown):HelarcContextSettingsSnapshot {
  const settings=snapshotHelarcContextSettings(value);return Object.freeze({revision:modelInputValueDigest(settings),settings});
}
/** Target matching is mechanical. Free-text material applicability is not inferred here. */
export function matchHelarcContextObservations(settings:HelarcContextSettings,profile:HelarcProviderProfile,artifact:string|null=null) {
  const target={profileId:profile.id,providerKind:profile.providerKind,baseUrl:new URL(profile.baseUrl).toString().replace(/\/$/,""),model:profile.model,
    modelSettings:snapshotHelarcProviderModelSettings(profile.modelSettings,profile.providerKind),contextWindowTokens:profile.ollamaRuntime?.contextWindowTokens??null};
  return settings.observations.map(observation=>{
    const {artifact:observedArtifact,...recorded}=observation.target;
    const match=modelInputValueDigest(recorded)!==modelInputValueDigest(target)?"target_mismatch":observedArtifact!==null&&artifact===null?"target_unknown":
      observedArtifact!==null&&observedArtifact!==artifact?"target_mismatch":"target_matched";
    return Object.freeze({observation,match,limitations:Object.freeze(["material_applicability_not_established",...(observedArtifact===null?["model_artifact_unknown"]:[])])});
  });
}
const DIMENSIONS=["format_and_references","source_support","coverage","exact_values_and_unknowns","revision_and_relationships","misses_and_false_positives"];
function record(value:unknown,keys:readonly string[]):Record<string,unknown> {
  if(!value||typeof value!=="object"||Array.isArray(value)||Object.keys(value).length!==keys.length||keys.some(key=>!Object.hasOwn(value,key)))throw new TypeError("context_settings_shape_invalid");
  return value as Record<string,unknown>;
}
function text(value:unknown,maximum:number,empty=false):string {
  if(typeof value!=="string"||value.length>maximum||(!empty&&!value.trim()))throw new TypeError("context_settings_text_invalid");return value;
}
function nullableText(value:unknown,maximum:number):string|null{return value===null?null:text(value,maximum);}
function deepFreeze<T>(value:T):T {if(value&&typeof value==="object"){Object.values(value).forEach(deepFreeze);Object.freeze(value);}return value;}
